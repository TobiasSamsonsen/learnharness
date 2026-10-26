import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	LESSON_LANGUAGES,
	parseSttDevice,
	parseSttEngine,
	sttModelFor,
	type SttDevice,
	LOCAL_STT_MODELS,
	lessonLanguageInfo,
	sttModelFiles,
	type LessonLanguage,
	type LocalSttStatus,
	type SttEngine,
	type SttModelSpec,
} from "../core/language.ts";
import { prepareWhisperCpp, transcribeWhisperCpp, whisperCppStatuses } from "./stt/whispercpp.ts";

/**
 * Local dictation (fork addition, 2026-10-24): the server half of the
 * on-device speech-to-text engine. Owns ONE worker process
 * (src/server/stt/worker.mjs — why a separate process is documented
 * there), forked on first use and stopped after IDLE_MS without work so
 * the model memory goes back to the OS. Models download once from the
 * Hugging Face Hub into <data>/models/stt and run fully offline after.
 *
 * Dictation is DEFERRED (components/dictation.tsx): the browser records
 * the whole utterance and posts it once, at stop — so a batch Whisper
 * call is the natural fit; there is no streaming to emulate.
 *
 * LH_STT_ENGINE=whispercpp swaps this worker for a whisper.cpp
 * `whisper-server` (stt/whispercpp.ts; Android plan M4) behind the same
 * three entry points at the bottom of this file.
 *
 * Each language has a GPU model and a small CPU fallback (core/language.ts,
 * owner 2026-10-25); the worker picks (stt/engine.mjs) and reports which
 * one ran — the status's `ranOn`.
 */

/** One engine's answer to a prepare or transcribe request. */
export type SttReply = { ok: true; text?: string; ranOn?: LocalSttStatus["ranOn"] } | { ok: false; error: string };

const WORKER = path.join(PATHS.root, "src", "server", "stt", "worker.mjs");
const CACHE_DIR = path.join(PATHS.models, "stt");
const IDLE_MS = 10 * 60_000;
type Reply = SttReply;
type WorkerMessage =
	| ({ id: number } & Reply)
	| { op: "progress"; repo: string; progress: number }
	| { op: "loaded"; repo: string };

interface LocalSttState {
	worker: ChildProcess | null;
	nextId: number;
	pending: Map<number, (reply: Reply) => void>;
	idle: ReturnType<typeof setTimeout> | null;
	/** repo → live state; absent = derive from disk */
	models: Map<string, { state: LocalSttStatus["state"]; progress?: number; error?: string }>;
	/** language → where its last run went (the GPU model or the CPU fallback) */
	ranOn: Map<LessonLanguage, NonNullable<LocalSttStatus["ranOn"]>>;
}

// globalThis: one worker per server process, even across dev HMR re-imports
const KEY = Symbol.for("lh.localStt");
function shared(): LocalSttState {
	const g = globalThis as Record<symbol, LocalSttState | undefined>;
	g[KEY] ??= { worker: null, nextId: 1, pending: new Map(), idle: null, models: new Map(), ranOn: new Map() };
	g[KEY].ranOn ??= new Map(); // a state object from before the field (dev HMR)
	return g[KEY];
}

function onDisk(model: SttModelSpec): boolean {
	return sttModelFiles(model.dtype).every((f) => fs.existsSync(path.join(CACHE_DIR, model.repo, f)));
}

function startWorker(s: LocalSttState): ChildProcess {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	// spawn + an "ipc" stdio slot = fork's channel, minus fork(): the
	// bundler treats fork(path) as a module reference and fails the build.
	// process.execPath is Electron (node mode) in the packaged app: the
	// server already runs with ELECTRON_RUN_AS_NODE=1 and passes it on.
	const worker = spawn(process.execPath, [WORKER], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LH_STT_CACHE_DIR: CACHE_DIR },
		serialization: "advanced",
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
	worker.on("message", (raw) => {
		const msg = raw as WorkerMessage;
		if ("op" in msg) {
			if (msg.op === "progress") s.models.set(msg.repo, { state: "downloading", progress: msg.progress });
			else s.models.set(msg.repo, { state: "ready" });
			return;
		}
		const resolve = s.pending.get(msg.id);
		s.pending.delete(msg.id);
		resolve?.(msg);
	});
	worker.on("exit", (code) => {
		if (s.worker === worker) s.worker = null;
		for (const resolve of s.pending.values()) resolve({ ok: false, error: `speech worker exited (code ${code ?? "?"})` });
		s.pending.clear();
		// loaded models died with it; on-disk truth is re-derived on read
		for (const [repo, m] of s.models) if (m.state !== "error") s.models.delete(repo);
	});
	s.worker = worker;
	return worker;
}

function request(op: "prepare" | "transcribe", body: Record<string, unknown>): Promise<Reply> {
	const s = shared();
	const worker = s.worker ?? startWorker(s);
	if (s.idle) clearTimeout(s.idle);
	const id = s.nextId++;
	return new Promise<Reply>((resolve) => {
		s.pending.set(id, resolve);
		worker.send({ id, op, ...body });
	}).finally(() => {
		if (s.pending.size > 0) return;
		if (s.idle) clearTimeout(s.idle);
		s.idle = setTimeout(() => {
			if (s.pending.size === 0) s.worker?.kill();
		}, IDLE_MS);
		s.idle.unref?.();
	});
}

function markRun(language: LessonLanguage, reply: Reply): Reply {
	const s = shared();
	const { repo } = sttModelFor(language, sttDevice());
	if (!reply.ok) s.models.set(repo, { state: "error", error: reply.error });
	else if (reply.ranOn) {
		// cpu device: the worker's "primary" is already the CPU model
		const ranOn = sttDevice() === "cpu" && reply.ranOn === "gpu" ? "cpu" : reply.ranOn;
		s.ranOn.set(language, ranOn);
		// the fallback ran: the GPU model is not what is warm
		if (ranOn === "gpu" || ranOn === "cpu") s.models.set(repo, { state: "ready" });
		else if (s.models.get(repo)?.state !== "error") s.models.delete(repo);
	}
	return reply;
}

/** Mark a language's GPU model as loading (or downloading) until it replies. */
function markLoading(language: LessonLanguage): void {
	const s = shared();
	const model = sttModelFor(language, sttDevice());
	if (s.models.get(model.repo)?.state !== "ready") s.models.set(model.repo, { state: onDisk(model) ? "loading" : "downloading", progress: 0 });
}

/** A language's two models, as the worker protocol carries them. */
function specs(language: LessonLanguage): { model: SttModelSpec; fallback: SttModelSpec } {
	return { model: sttModelFor(language, sttDevice()), fallback: LOCAL_STT_MODELS[language].fallback };
}

/** Which local engine this server process runs (LH_STT_ENGINE, Android plan M4). */
export function sttEngine(): SttEngine {
	return parseSttEngine(process.env.LH_STT_ENGINE);
}

/** Which device the transformers.js engine may use (LH_STT_DEVICE, Android plan M6). */
export function sttDevice(): SttDevice {
	return parseSttDevice(process.env.LH_STT_DEVICE);
}

/** Every language's local model, with its live (or on-disk) state. */
export function localSttStatuses(): LocalSttStatus[] {
	if (sttEngine() === "whispercpp") return whisperCppStatuses();
	const s = shared();
	return LESSON_LANGUAGES.map(({ id }) => {
		const model = sttModelFor(id, sttDevice());
		const live = s.models.get(model.repo);
		const state = live?.state ?? (onDisk(model) ? "cached" : "absent");
		const ranOn = s.ranOn.get(id);
		return {
			language: id,
			repo: model.repo,
			sizeMb: model.sizeMb,
			state: state === "downloading" && onDisk(model) ? "loading" : state,
			...(live?.progress !== undefined && state === "downloading" ? { progress: live.progress } : {}),
			...(live?.error ? { error: live.error } : {}),
			...(ranOn ? { ranOn } : {}),
		};
	});
}

/** Download (first time) and load a language's model. Resolves when warm. */
export async function prepareLocalStt(language: LessonLanguage): Promise<Reply> {
	if (sttEngine() === "whispercpp") return prepareWhisperCpp(language);
	markLoading(language);
	return markRun(language, await request("prepare", specs(language)));
}

/** Transcribe one utterance: 16 kHz mono Int16 little-endian PCM. `vocabulary`
 *  (the lesson's terms, core/dictation-vocabulary.ts) biases the whisper.cpp
 *  engine; the transformers worker has no prompt support and ignores it. */
export async function transcribeLocal(language: LessonLanguage, pcm: Uint8Array, vocabulary?: string): Promise<Reply> {
	if (sttEngine() === "whispercpp") return transcribeWhisperCpp(language, pcm, vocabulary);
	markLoading(language);
	return markRun(language, await request("transcribe", { ...specs(language), whisper: lessonLanguageInfo(language).whisper, pcm }));
}
