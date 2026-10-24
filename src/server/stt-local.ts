import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	LESSON_LANGUAGES,
	LOCAL_STT_MODELS,
	lessonLanguageInfo,
	type LessonLanguage,
	type LocalSttStatus,
} from "../core/language.ts";

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
 */

const WORKER = path.join(PATHS.root, "src", "server", "stt", "worker.mjs");
const CACHE_DIR = path.join(PATHS.models, "stt");
const IDLE_MS = 10 * 60_000;
/** The files a q8 model needs on disk (the worker's dtype choice). */
const MODEL_FILES = ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx", "tokenizer.json"];

type Reply = { ok: true; text?: string } | { ok: false; error: string };
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
}

// globalThis: one worker per server process, even across dev HMR re-imports
const KEY = Symbol.for("lh.localStt");
function shared(): LocalSttState {
	const g = globalThis as Record<symbol, LocalSttState | undefined>;
	g[KEY] ??= { worker: null, nextId: 1, pending: new Map(), idle: null, models: new Map() };
	return g[KEY];
}

function onDisk(repo: string): boolean {
	return MODEL_FILES.every((f) => fs.existsSync(path.join(CACHE_DIR, repo, f)));
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

function markRun(repo: string, reply: Reply): Reply {
	const s = shared();
	if (reply.ok) s.models.set(repo, { state: "ready" });
	else s.models.set(repo, { state: "error", error: reply.error });
	return reply;
}

/** Every language's local model, with its live (or on-disk) state. */
export function localSttStatuses(): LocalSttStatus[] {
	const s = shared();
	return LESSON_LANGUAGES.map(({ id }) => {
		const model = LOCAL_STT_MODELS[id];
		const live = s.models.get(model.repo);
		const state = live?.state ?? (onDisk(model.repo) ? "cached" : "absent");
		return {
			language: id,
			repo: model.repo,
			sizeMb: model.sizeMb,
			state: state === "downloading" && onDisk(model.repo) ? "loading" : state,
			...(live?.progress !== undefined && state === "downloading" ? { progress: live.progress } : {}),
			...(live?.error ? { error: live.error } : {}),
		};
	});
}

/** Download (first time) and load a language's model. Resolves when warm. */
export async function prepareLocalStt(language: LessonLanguage): Promise<Reply> {
	const { repo } = LOCAL_STT_MODELS[language];
	const s = shared();
	if (s.models.get(repo)?.state !== "ready") s.models.set(repo, { state: onDisk(repo) ? "loading" : "downloading", progress: 0 });
	return markRun(repo, await request("prepare", { repo }));
}

/** Transcribe one utterance: 16 kHz mono Int16 little-endian PCM. */
export async function transcribeLocal(language: LessonLanguage, pcm: Uint8Array): Promise<Reply> {
	const { repo } = LOCAL_STT_MODELS[language];
	const s = shared();
	if (s.models.get(repo)?.state !== "ready") s.models.set(repo, { state: onDisk(repo) ? "loading" : "downloading", progress: 0 });
	return markRun(repo, await request("transcribe", { repo, whisper: lessonLanguageInfo(language).whisper, pcm }));
}
