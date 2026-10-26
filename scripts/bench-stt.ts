/**
 * whisper.cpp dictation bench (Android plan M4): word error rate and speed
 * of the candidate GGML models, with and without the vocabulary prompt.
 *
 *   npx tsx scripts/bench-stt.ts --bin <whisper-server> --models <dir>
 *       [--langs nb,en] [--threads 4,8] [--fleurs 8] [--tech <dir>]
 *
 * Clips:
 *   FLEURS  the first --fleurs distinct test utterances of nb_no / en_us (≈100 s
 *           at 8), taken once from the dataset's test split into
 *           <models>/../fleurs and converted with ffmpeg. The "prompt" runs here
 *           use the technical lesson's vocabulary on UNRELATED speech: they
 *           measure what a stale prompt costs.
 *   tech    your recording of scripts/bench-stt/lesson-<lang>.json's `script`,
 *           any audio file named <tech>/<lang>.(wav|m4a|mp3|...) — ffmpeg
 *           converts it. The prompt is the REAL pipeline's: dictationVocabulary
 *           over that lesson fixture.
 * Models: <models>/<file> for the names in CANDIDATES that exist.
 * Prints markdown tables and writes <models>/../results.json.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { dictationVocabulary, dropPromptEcho } from "../src/core/dictation-vocabulary.ts";
import { cleanWhisperText } from "../src/server/stt/whispercpp.ts";

type Lang = "nb" | "en";
const CODE: Record<Lang, string> = { nb: "no", en: "en" };
const FLEURS_CONFIG: Record<Lang, string> = { nb: "nb_no", en: "en_us" };
const CANDIDATES: Record<Lang, string[]> = {
	nb: ["nb-small-q5_0.bin", "nb-medium-q5_0.bin"],
	en: ["en-small-q5_1.bin", "en-turbo-q5_0.bin"],
};

function arg(name: string, fallback?: string): string {
	const i = process.argv.indexOf(`--${name}`);
	const v = i === -1 ? fallback : process.argv[i + 1];
	if (v === undefined) throw new Error(`missing --${name}`);
	return v;
}

const BIN = arg("bin");
const MODELS = path.resolve(arg("models"));
const LANGS = arg("langs", "nb,en").split(",") as Lang[];
const THREADS = arg("threads", "4,8").split(",").map(Number);
const FLEURS_N = Number(arg("fleurs", "8"));
const ROOT = path.dirname(MODELS);
const TECH = path.resolve(arg("tech", path.join(ROOT, "tech")));
const FLEURS_DIR = path.join(ROOT, "fleurs");

interface Clip {
	id: string;
	wav: string;
	reference: string;
	seconds: number;
}

// ─── clips ───────────────────────────────────────────────────────────────────

function toWav(src: string, dest: string): void {
	execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dest]);
}

function wavSeconds(file: string): number {
	return (fs.statSync(file).size - 44) / 32_000;
}

async function fleursClips(lang: Lang): Promise<Clip[]> {
	const dir = path.join(FLEURS_DIR, lang);
	fs.mkdirSync(dir, { recursive: true });
	const meta = path.join(dir, "rows.json");
	if (!fs.existsSync(meta)) {
		// the dataset's own test split: the datasets server refuses en_us (row groups too large)
		const base = `https://huggingface.co/datasets/google/fleurs/resolve/main/data/${FLEURS_CONFIG[lang]}`;
		const tsv = path.join(dir, "test.tsv");
		const tar = path.join(dir, "test.tar.gz");
		if (!fs.existsSync(tsv)) fs.writeFileSync(tsv, await (await fetch(`${base}/test.tsv`)).text());
		if (!fs.existsSync(tar)) execFileSync("curl", ["-sL", "-o", tar, `${base}/audio/test.tar.gz`]);
		// columns: id · file · raw transcription · normalized transcription · …; each sentence once
		const picked = new Map<string, { file: string; reference: string }>();
		for (const line of fs.readFileSync(tsv, "utf-8").split("\n")) {
			const [, file, , reference] = line.split("\t");
			if (file && reference && !picked.has(reference) && picked.size < FLEURS_N) picked.set(reference, { file, reference });
		}
		// relative paths from `dir`: GNU tar reads "C:\..." as a remote host
		execFileSync("tar", ["-xzf", "test.tar.gz", ...[...picked.values()].map((p) => `test/${p.file}`)], { cwd: dir });
		const rows = [...picked.values()].map(({ file, reference }) => {
			const id = path.parse(file).name;
			toWav(path.join(dir, "test", file), path.join(dir, `${id}.wav`));
			return { id, reference };
		});
		fs.writeFileSync(meta, JSON.stringify(rows));
	}
	return (JSON.parse(fs.readFileSync(meta, "utf-8")) as Array<{ id: string; reference: string }>).slice(0, FLEURS_N).map((r) => {
		const wav = path.join(dir, `${r.id}.wav`);
		return { id: `fleurs-${r.id}`, wav, reference: r.reference, seconds: wavSeconds(wav) };
	});
}

function techClip(lang: Lang, script: string): Clip | null {
	if (!fs.existsSync(TECH)) return null;
	const file = fs.readdirSync(TECH).find((f) => path.parse(f).name === lang && !f.endsWith(".16k.wav"));
	if (!file) return null;
	const wav = path.join(TECH, `${lang}.16k.wav`);
	toWav(path.join(TECH, file), wav);
	return { id: `tech-${lang}`, wav, reference: script, seconds: wavSeconds(wav) };
}

// ─── scoring ─────────────────────────────────────────────────────────────────

function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/-/g, " ")
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.split(/\s+/)
		.filter(Boolean);
}

/** Word-level Levenshtein distance. */
function edits(ref: string[], hyp: string[]): number {
	let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
	for (let i = 1; i <= ref.length; i++) {
		const row = [i];
		for (let j = 1; j <= hyp.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
		prev = row;
	}
	return prev[hyp.length]!;
}

// ─── server ──────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer().once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

async function withServer<T>(model: string, threads: number, fn: (base: string, loadSeconds: number) => Promise<T>): Promise<T> {
	const port = await freePort();
	const t0 = performance.now();
	const proc = spawn(BIN, ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-t", String(threads)], { stdio: "ignore", windowsHide: true });
	const base = `http://127.0.0.1:${port}`;
	try {
		for (;;) {
			try {
				await fetch(base, { signal: AbortSignal.timeout(1000) });
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		return await fn(base, (performance.now() - t0) / 1000);
	} finally {
		proc.kill();
	}
}

async function transcribe(base: string, clip: Clip, lang: Lang, prompt: string): Promise<{ text: string; seconds: number }> {
	const form = new FormData();
	form.set("file", new Blob([fs.readFileSync(clip.wav)], { type: "audio/wav" }), "clip.wav");
	form.set("language", CODE[lang]);
	form.set("temperature", "0");
	form.set("response_format", "json");
	if (prompt) form.set("prompt", prompt);
	const t0 = performance.now();
	const res = await fetch(`${base}/inference`, { method: "POST", body: form });
	const body = (await res.json()) as { text?: string; error?: string };
	if (typeof body.text !== "string") throw new Error(body.error ?? `server answered ${res.status}`);
	const seconds = (performance.now() - t0) / 1000;
	let text = cleanWhisperText(body.text);
	if (prompt) text = dropPromptEcho(text, prompt);
	return { text, seconds };
}

// ─── run ─────────────────────────────────────────────────────────────────────

interface Row {
	lang: Lang;
	model: string;
	threads: number;
	set: "fleurs" | "tech";
	prompt: boolean;
	wer: number;
	audioSeconds: number;
	wallSeconds: number;
	loadSeconds: number;
	words: number;
	hypothesis?: string;
}

const rows: Row[] = [];
console.error(`machine: ${os.cpus()[0]?.model} · ${os.cpus().length} threads · ${Math.round(os.totalmem() / 2 ** 30)} GB`);

for (const lang of LANGS) {
	const lesson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "bench-stt", `lesson-${lang}.json`), "utf-8")) as {
		messages: never[];
		tree: never;
		script: string;
	};
	const vocabulary = dictationVocabulary({ messages: lesson.messages, tree: lesson.tree, language: lang });
	console.error(`\n[${lang}] vocabulary prompt: ${vocabulary}`);
	const sets: Array<{ set: Row["set"]; clips: Clip[] }> = [{ set: "fleurs", clips: await fleursClips(lang) }];
	const tech = techClip(lang, lesson.script);
	if (tech) sets.push({ set: "tech", clips: [tech] });
	else console.error(`[${lang}] no technical clip in ${TECH} (record ${lang}.<wav|m4a|mp3> from scripts/bench-stt/lesson-${lang}.json) — FLEURS only`);

	for (const file of CANDIDATES[lang]) {
		const model = path.join(MODELS, file);
		if (!fs.existsSync(model)) continue;
		for (const threads of THREADS) {
			await withServer(model, threads, async (base, loadSeconds) => {
				await transcribe(base, sets[0]!.clips[0]!, lang, ""); // warm-up: first-request allocations are not the steady state
				for (const { set, clips } of sets) {
					for (const prompt of [false, true]) {
						let errors = 0;
						let total = 0;
						let wall = 0;
						let audio = 0;
						let hypothesis = "";
						for (const clip of clips) {
							const out = await transcribe(base, clip, lang, prompt ? vocabulary : "");
							const ref = words(clip.reference);
							errors += edits(ref, words(out.text));
							total += ref.length;
							wall += out.seconds;
							audio += clip.seconds;
							if (set === "tech") hypothesis = out.text;
						}
						const row: Row = { lang, model: file, threads, set, prompt, wer: errors / total, audioSeconds: audio, wallSeconds: wall, loadSeconds, words: total, ...(hypothesis ? { hypothesis } : {}) };
						rows.push(row);
						console.error(`${lang} ${file} t${threads} ${set}${prompt ? "+prompt" : ""}: WER ${(row.wer * 100).toFixed(1)}% · ${(audio / wall).toFixed(1)}× real time`);
					}
				}
			});
		}
	}
}

fs.writeFileSync(path.join(ROOT, "results.json"), JSON.stringify(rows, null, 2));
console.log("| Lang | Model | Threads | Clips | Prompt | WER | Speed (× real time) | Wall s | Load s |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
	console.log(
		`| ${r.lang} | ${r.model} | ${r.threads} | ${r.set} (${r.words} words, ${r.audioSeconds.toFixed(0)} s) | ${r.prompt ? "vocabulary" : "none"} | ${(r.wer * 100).toFixed(1)}% | ${(r.audioSeconds / r.wallSeconds).toFixed(1)} | ${r.wallSeconds.toFixed(1)} | ${r.loadSeconds.toFixed(1)} |`,
	);
}
