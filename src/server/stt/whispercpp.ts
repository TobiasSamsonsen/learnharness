import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { PATHS } from "../../../config.ts";
import { parseMaxRequestSeconds, splitPcm } from "../../core/dictation-pieces.ts";
import { dropPromptEcho } from "../../core/dictation-vocabulary.ts";
import { LESSON_LANGUAGES, WHISPERCPP_MODELS, type LessonLanguage, type LocalSttStatus } from "../../core/language.ts";
import type { SttReply } from "../stt-local.ts";
import { toFloat } from "./pcm.mjs";
import { wavFromPcm } from "./wav.ts";

/**
 * The whisper.cpp speech engine (Android plan M4, LH_STT_ENGINE=whispercpp):
 * a `whisper-server` per language, called over loopback HTTP. Two modes:
 *   - URL mode — LH_WHISPER_URL_NB / LH_WHISPER_URL_EN name a server that is
 *     already running (Android: started natively in Termux, outside the
 *     proot this process lives in). The app downloads and spawns nothing.
 *   - spawn mode — otherwise this process starts `LH_WHISPER_BIN` itself on
 *     first use, downloads the GGML model once into <data>/models/stt/ggml,
 *     and stops the server after IDLE_MS without work (like the worker).
 * A failure is an error reply, never a silent switch to transformers.js
 * (owner, M4): the dictation UI keeps the recording and offers Retry.
 * LH_WHISPER_THREADS passes `-t` through; unset leaves whisper-server's own
 * default.
 * LH_WHISPER_MAX_S (Android plan M7b) is the longest audio one request may
 * carry: a server started with a short `-ac` audio context truncates anything
 * longer, so a longer clip (a Retry of an old recording) is split at its
 * quietest frames and the texts are joined. Unset = no splitting.
 */

const GGML_DIR = path.join(PATHS.models, "stt", "ggml");
const IDLE_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const SILENCE_PEAK = 0.01; // same floor as the transformers worker

interface Slot {
	proc: ChildProcess;
	/** Resolves with the server's base URL once it answers. */
	base: Promise<string>;
	up: boolean;
	busy: number;
	idle: ReturnType<typeof setTimeout> | null;
}

interface WhisperCppState {
	slots: Map<LessonLanguage, Slot>;
	downloads: Map<LessonLanguage, Promise<string>>;
	/** language → live model state; absent = derive from disk / the slot */
	models: Map<LessonLanguage, { state: LocalSttStatus["state"]; progress?: number; error?: string }>;
	/** URL mode: the outcome of the language's last request */
	reached: Map<LessonLanguage, { ok: true } | { ok: false; error: string }>;
}

// globalThis: one set of servers per server process, even across dev HMR re-imports
const KEY = Symbol.for("lh.whisperCpp");
function shared(): WhisperCppState {
	const g = globalThis as Record<symbol, WhisperCppState | undefined>;
	g[KEY] ??= { slots: new Map(), downloads: new Map(), models: new Map(), reached: new Map() };
	return g[KEY];
}

function externalUrl(language: LessonLanguage): string | null {
	const raw = process.env[language === "nb" ? "LH_WHISPER_URL_NB" : "LH_WHISPER_URL_EN"]?.trim();
	return raw ? raw.replace(/\/+$/, "") : null;
}

function modelFile(language: LessonLanguage): string {
	return path.join(GGML_DIR, WHISPERCPP_MODELS[language].file);
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Download (once) a language's GGML model. Resolves with its path. */
function ensureModel(language: LessonLanguage): Promise<string> {
	const s = shared();
	const dest = modelFile(language);
	if (fs.existsSync(dest)) return Promise.resolve(dest);
	let p = s.downloads.get(language);
	if (!p) {
		p = download(language, dest).finally(() => s.downloads.delete(language));
		s.downloads.set(language, p);
	}
	return p;
}

async function download(language: LessonLanguage, dest: string): Promise<string> {
	const s = shared();
	const { repo, file } = WHISPERCPP_MODELS[language];
	s.models.set(language, { state: "downloading", progress: 0 });
	const part = `${dest}.part`;
	try {
		fs.mkdirSync(GGML_DIR, { recursive: true });
		const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`, { redirect: "follow" });
		if (!res.ok || !res.body) throw new Error(`model download failed (${res.status}) — ${repo}/${file}`);
		const total = Number(res.headers.get("content-length")) || 0;
		const out = fs.createWriteStream(part);
		let loaded = 0;
		let last = -1;
		for await (const chunk of Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)) {
			if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
			loaded += (chunk as Uint8Array).byteLength;
			const pct = total > 0 ? Math.floor((loaded / total) * 100) : -1;
			if (pct !== last) {
				last = pct;
				s.models.set(language, { state: "downloading", progress: total > 0 ? loaded / total : 0 });
			}
		}
		await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
		fs.renameSync(part, dest);
		s.models.delete(language);
		return dest;
	} catch (err) {
		fs.rmSync(part, { force: true });
		s.models.set(language, { state: "error", error: errorText(err) });
		throw err;
	}
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

function threadArgs(): string[] {
	const n = Number.parseInt(process.env.LH_WHISPER_THREADS ?? "", 10);
	return Number.isFinite(n) && n >= 1 ? ["-t", String(n)] : [];
}

/** The server's base URL for a language: the external one, else a spawned
 *  one (started, and its model downloaded, on first use). */
function baseUrl(language: LessonLanguage): Promise<string> {
	const external = externalUrl(language);
	if (external) return Promise.resolve(external);
	const s = shared();
	const existing = s.slots.get(language);
	if (existing) return existing.base;
	return startServer(language);
}

function startServer(language: LessonLanguage): Promise<string> {
	const s = shared();
	const bin = process.env.LH_WHISPER_BIN?.trim();
	if (!bin) {
		return Promise.reject(new Error("whisper.cpp: set LH_WHISPER_BIN (the whisper-server binary), or LH_WHISPER_URL_NB / LH_WHISPER_URL_EN to use a server that is already running"));
	}
	if (!fs.existsSync(bin)) return Promise.reject(new Error(`whisper.cpp: LH_WHISPER_BIN does not exist: ${bin}`));

	// The slot is registered BEFORE the model download and the spawn, so a
	// second request during either joins this start instead of launching its own.
	let slot!: Slot;
	const base = (async () => {
		const model = await ensureModel(language);
		const port = await freePort();
		let tail = "";
		const keep = (b: Buffer) => {
			tail = (tail + b.toString()).slice(-2000);
		};
		const args = ["-m", model, "--host", "127.0.0.1", "--port", String(port), ...threadArgs()];
		// a .cmd shim only runs through the shell on Windows (same rule as the claude provider)
		const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
		const proc = spawn(shell ? `"${bin}"` : bin, shell ? args.map((a) => `"${a}"`) : args, {
			shell,
			// the server's access token (Android plan M6) is not the engine's business
			env: { ...process.env, LH_ACCESS_TOKEN: undefined },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		proc.stdout?.on("data", keep);
		proc.stderr?.on("data", keep);
		slot.proc = proc;
		s.models.set(language, { state: "loading" });
		const exited = new Promise<never>((_, reject) => {
			proc.once("error", (err) => reject(new Error(`whisper-server failed to start: ${err.message}`)));
			proc.once("exit", (code) => reject(new Error(`whisper-server exited (code ${code ?? "?"})${tail ? `: ${tail.trim().split("\n").slice(-3).join(" | ")}` : ""}`)));
		});
		proc.once("exit", () => {
			if (s.slots.get(language) === slot) s.slots.delete(language);
			if (slot.idle) clearTimeout(slot.idle);
			if (s.models.get(language)?.state !== "error") s.models.delete(language);
		});
		const url = `http://127.0.0.1:${port}`;
		await Promise.race([waitReady(url), exited]);
		slot.up = true;
		s.models.set(language, { state: "ready" });
		return url;
	})();
	slot = { proc: null as unknown as ChildProcess, base, up: false, busy: 0, idle: null };
	s.slots.set(language, slot);
	base.catch((err) => {
		// a failed start (spawn, download, early exit) leaves nothing behind: the next request retries
		if (s.slots.get(language) === slot) s.slots.delete(language);
		slot.proc?.kill();
		s.models.set(language, { state: "error", error: errorText(err) });
	});
	return base;
}

/** Any HTTP answer means the model is loaded: whisper-server listens only after. */
async function waitReady(url: string): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		try {
			await fetch(url, { signal: AbortSignal.timeout(2_000) });
			return;
		} catch {
			if (Date.now() > deadline) throw new Error("whisper-server did not start in time");
			await new Promise((r) => setTimeout(r, 250));
		}
	}
}

/** Whisper's transcript → plain text: no blank-audio tag, one-space whitespace. */
export function cleanWhisperText(raw: string): string {
	return raw.replace(/\[BLANK_AUDIO\]/gi, " ").replace(/\s+/g, " ").trim();
}

/** Transcribe one utterance (16 kHz mono Int16 LE PCM) on whisper.cpp. */
export async function transcribeWhisperCpp(language: LessonLanguage, pcm: Uint8Array, vocabulary?: string): Promise<SttReply> {
	const cap = parseMaxRequestSeconds(process.env.LH_WHISPER_MAX_S);
	const chunks = cap ? splitPcm(pcm, cap) : [pcm];
	if (chunks.length === 1) return transcribeChunk(language, pcm, vocabulary);
	const texts: string[] = [];
	for (const chunk of chunks) {
		const reply = await transcribeChunk(language, chunk, vocabulary);
		if (!reply.ok) return reply;
		if (reply.text) texts.push(reply.text);
	}
	return { ok: true, text: texts.join(" ") };
}

async function transcribeChunk(language: LessonLanguage, pcm: Uint8Array, vocabulary?: string): Promise<SttReply> {
	const { audio, peak } = toFloat(pcm);
	if (audio.length < 1600 || peak < SILENCE_PEAK) return { ok: true, text: "" }; // < 0.1 s, or silence
	const s = shared();
	const external = externalUrl(language) !== null;
	const finish = (slot: Slot | undefined) => {
		if (!slot) return;
		slot.busy--;
		if (slot.busy > 0) return;
		if (slot.idle) clearTimeout(slot.idle);
		slot.idle = setTimeout(() => {
			if (slot.busy === 0) slot.proc.kill();
		}, IDLE_MS);
		slot.idle.unref?.();
	};
	let slot: Slot | undefined;
	try {
		const base = await baseUrl(language);
		slot = s.slots.get(language);
		if (slot) {
			slot.busy++;
			if (slot.idle) clearTimeout(slot.idle);
		}
		const form = new FormData();
		form.set("file", new Blob([wavFromPcm(pcm)], { type: "audio/wav" }), "clip.wav");
		form.set("language", WHISPERCPP_MODELS[language].code);
		form.set("temperature", "0");
		form.set("response_format", "json");
		if (vocabulary) form.set("prompt", vocabulary);
		const res = await fetch(`${base}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
		if (!res.ok || typeof body.text !== "string") throw new Error(body.error ?? `whisper-server answered ${res.status}`);
		if (external) s.reached.set(language, { ok: true });
		let text = cleanWhisperText(body.text);
		if (vocabulary) text = dropPromptEcho(text, vocabulary);
		return { ok: true, text };
	} catch (err) {
		const message = errorText(err);
		if (external) s.reached.set(language, { ok: false, error: message });
		return { ok: false, error: message };
	} finally {
		finish(slot);
	}
}

/** Download (first time) and start a language's server, or probe its URL. */
export async function prepareWhisperCpp(language: LessonLanguage): Promise<SttReply> {
	try {
		const base = await baseUrl(language);
		if (externalUrl(language)) {
			await fetch(base, { signal: AbortSignal.timeout(5_000) });
			shared().reached.set(language, { ok: true });
		}
		return { ok: true };
	} catch (err) {
		const message = errorText(err);
		if (externalUrl(language)) shared().reached.set(language, { ok: false, error: message });
		return { ok: false, error: message };
	}
}

/** Every language's model, as GET /api/stt/local reports it. */
export function whisperCppStatuses(): LocalSttStatus[] {
	const s = shared();
	return LESSON_LANGUAGES.map(({ id }) => {
		const model = WHISPERCPP_MODELS[id];
		const external = externalUrl(id);
		if (external) {
			const reached = s.reached.get(id);
			return {
				language: id,
				repo: external,
				sizeMb: 0,
				state: reached ? (reached.ok ? "ready" : "error") : "cached",
				...(reached && !reached.ok ? { error: reached.error } : {}),
			};
		}
		const live = s.models.get(id);
		const state = live?.state ?? (fs.existsSync(modelFile(id)) ? "cached" : "absent");
		return {
			language: id,
			repo: `${model.repo}/${model.file}`,
			sizeMb: model.sizeMb,
			state,
			...(live?.progress !== undefined && state === "downloading" ? { progress: live.progress } : {}),
			...(live?.error ? { error: live.error } : {}),
		};
	});
}

/** Stop every spawned whisper-server (tests, shutdown). An external server is never touched. */
export function stopWhisperCpp(): void {
	const s = shared();
	for (const slot of s.slots.values()) slot.proc?.kill();
}
