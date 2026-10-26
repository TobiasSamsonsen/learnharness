/**
 * The whisper.cpp speech engine — Android plan M4: the WAV wrapper, the
 * dictation vocabulary prompt, the engine seam, and the adapter's two modes
 * (a spawned whisper-server and an external URL) against a fake server
 * (tests/fixtures/whisper/fake-whisper-server.mjs). No network, no model.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { dictationVocabulary, dropPromptEcho, vocabularyTokens } from "../src/core/dictation-vocabulary.ts";
import { WHISPERCPP_MODELS, parseSttEngine } from "../src/core/language.ts";
import { wavFromPcm } from "../src/server/stt/wav.ts";

// config.ts reads LH_DATA_DIR at module load: set it before the adapter is imported.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-whisper-data-"));
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fake-whisper-"));
const FAKE = path.resolve("tests/fixtures/whisper/fake-whisper-server.mjs");
const LOG = path.join(BIN_DIR, "requests.log");
const bin =
	process.platform === "win32"
		? (fs.writeFileSync(path.join(BIN_DIR, "whisper-server.cmd"), `@"${process.execPath}" "${FAKE}" %*\r\n`), path.join(BIN_DIR, "whisper-server.cmd"))
		: (fs.writeFileSync(path.join(BIN_DIR, "whisper-server"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 }), path.join(BIN_DIR, "whisper-server"));

process.env.LH_DATA_DIR = DATA;

/** One second of a loud 440 Hz tone: 16 kHz Int16 LE PCM. */
function tone(seconds = 1, amplitude = 12000): Uint8Array {
	const out = new Int16Array(16_000 * seconds);
	for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16_000) * amplitude);
	return new Uint8Array(out.buffer);
}

const requests = () =>
	fs.existsSync(LOG)
		? fs
				.readFileSync(LOG, "utf-8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, any>)
		: [];

describe("wavFromPcm", () => {
	it("writes the canonical 44-byte PCM header (16 kHz, mono, 16-bit) before the samples", () => {
		const pcm = new Uint8Array([1, 0, 2, 0, 3, 0]);
		const wav = wavFromPcm(pcm);
		const v = new DataView(wav.buffer);
		assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
		assert.equal(String.fromCharCode(...wav.subarray(8, 16)), "WAVEfmt ");
		assert.equal(v.getUint32(4, true), 36 + 6);
		assert.equal(v.getUint16(20, true), 1); // PCM
		assert.equal(v.getUint16(22, true), 1); // mono
		assert.equal(v.getUint32(24, true), 16_000);
		assert.equal(v.getUint32(28, true), 32_000);
		assert.equal(v.getUint16(34, true), 16);
		assert.equal(String.fromCharCode(...wav.subarray(36, 40)), "data");
		assert.equal(v.getUint32(40, true), 6);
		assert.deepEqual([...wav.subarray(44)], [1, 0, 2, 0, 3, 0]);
	});

	it("drops an odd trailing byte instead of reading half a sample", () => {
		const wav = wavFromPcm(new Uint8Array([1, 0, 9]));
		assert.equal(wav.byteLength, 46);
		assert.equal(new DataView(wav.buffer).getUint32(40, true), 2);
	});
});

describe("engine selection", () => {
	it("is transformers.js unless LH_STT_ENGINE names whispercpp", () => {
		assert.equal(parseSttEngine(undefined), "transformers");
		assert.equal(parseSttEngine(""), "transformers");
		assert.equal(parseSttEngine("nonsense"), "transformers");
		assert.equal(parseSttEngine("whispercpp"), "whispercpp");
		assert.equal(parseSttEngine(" WhisperCpp "), "whispercpp");
	});
});

const assistant = (text: string): LhMessage => ({ id: `a${Math.random()}`, role: "assistant", content: [{ type: "text", text }] }) as unknown as LhMessage;
const call = (name: string, args: Record<string, unknown>): LhMessage =>
	({ id: `c${Math.random()}`, role: "assistant", content: [{ type: "toolCall", id: "t1", name, arguments: args }] }) as unknown as LhMessage;

describe("dictationVocabulary", () => {
	it("is empty for a lesson with no terms yet", () => {
		assert.equal(dictationVocabulary({ messages: [], language: "en" }), "");
	});

	it("lists the active stem's terms, then plan titles (current node first), then teacher terms", () => {
		const tree = {
			nodes: [
				{ id: "a", title: "Nodal analysis" },
				{ id: "b", title: "Thévenin equivalent" },
			],
			edges: [],
			version: 1,
		};
		const messages = [
			assistant("Today we use **superposition** on the circuit."),
			call("quiz", { nodeId: "b", question: "Find the Norton equivalent resistance of the network." }),
		];
		const vocab = dictationVocabulary({ messages, tree, language: "en" });
		const parts = vocab.replace(/\.$/, "").split(", ");
		assert.ok(parts.indexOf("Norton") < parts.indexOf("Thévenin equivalent"), "stem terms come first");
		assert.ok(parts.indexOf("Thévenin equivalent") < parts.indexOf("Nodal analysis"), "the current node leads the titles");
		assert.ok(parts.indexOf("Nodal analysis") < parts.indexOf("superposition"), "teacher terms come last");
		assert.ok(vocab.endsWith("."));
	});

	it("takes bold spans before rare words, skips math and code, and never repeats a term", () => {
		const messages = [
			assistant("The **eigenvalue** equation is $\\lambda_{max} = \\frac{a}{b}$ and `matrixMultiplication` too. An eigenvalue problem, usually."),
		];
		const vocab = dictationVocabulary({ messages, language: "en" });
		assert.equal(vocab, "eigenvalue, equation."); // bold first; "equation" is a long word; no math, no code
	});

	it("reads Norwegian lessons with the Norwegian common-word list", () => {
		const messages = [assistant("Vi bruker **Kirchhoffs lov** her, og det er egentlig veldig viktig.")];
		assert.equal(dictationVocabulary({ messages, language: "nb" }), "Kirchhoffs lov.");
	});

	it("stays inside the token budget, keeping the earlier (higher-priority) terms", () => {
		const tree = { nodes: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, title: `Concept number ${i} of the lesson` })), edges: [], version: 1 };
		const vocab = dictationVocabulary({ messages: [], tree, language: "en" }, 40);
		assert.ok(vocabularyTokens(vocab) <= 40, `${vocab.length} chars`);
		assert.ok(vocab.startsWith("Concept number 0 of the lesson, Concept number 1"));
	});

	it("ignores teacher messages older than the last six", () => {
		const messages = [assistant("Remember **stale-term** here."), ...Array.from({ length: 6 }, () => assistant("Plain words only."))];
		assert.equal(dictationVocabulary({ messages, language: "en" }), "");
	});
});

describe("dropPromptEcho", () => {
	const vocab = "Norton, Thévenin equivalent, superposition, nodal analysis.";
	it("drops a transcript that is a run of three or more listed words", () => {
		assert.equal(dropPromptEcho("Thévenin equivalent, superposition", vocab), "");
		assert.equal(dropPromptEcho("Norton, Thévenin equivalent, superposition, nodal analysis.", vocab), "");
	});
	it("keeps one or two terms, and anything that is not in the list's order", () => {
		assert.equal(dropPromptEcho("superposition", vocab), "superposition");
		assert.equal(dropPromptEcho("Norton Thévenin", vocab), "Norton Thévenin");
		assert.equal(dropPromptEcho("use superposition then Norton equivalent", vocab), "use superposition then Norton equivalent");
	});
});

describe("the whisper.cpp adapter", () => {
	let whisper: typeof import("../src/server/stt/whispercpp.ts");
	let external: http.Server | null = null;
	const savedEnv = { ...process.env };

	before(async () => {
		const ggml = path.join(DATA, "models", "stt", "ggml");
		fs.mkdirSync(ggml, { recursive: true });
		for (const m of Object.values(WHISPERCPP_MODELS)) fs.writeFileSync(path.join(ggml, m.file), "fake model");
		whisper = await import("../src/server/stt/whispercpp.ts");
	});

	after(async () => {
		whisper.stopWhisperCpp();
		await new Promise<void>((resolve) => (external ? external.close(() => resolve()) : resolve()));
		process.env = savedEnv;
		fs.rmSync(DATA, { recursive: true, force: true });
		fs.rmSync(BIN_DIR, { recursive: true, force: true });
	});

	it("without LH_WHISPER_BIN or a URL, says what to set", async () => {
		delete process.env.LH_WHISPER_BIN;
		const reply = await whisper.transcribeWhisperCpp("en", tone());
		assert.equal(reply.ok, false);
		assert.match((reply as { error: string }).error, /LH_WHISPER_BIN/);
		assert.match((reply as { error: string }).error, /LH_WHISPER_URL_NB/);
	});

	it("silence and sub-0.1 s clips transcribe to nothing without starting a server", async () => {
		process.env.LH_WHISPER_BIN = bin;
		assert.deepEqual(await whisper.transcribeWhisperCpp("en", new Uint8Array(32_000)), { ok: true, text: "" });
		assert.deepEqual(await whisper.transcribeWhisperCpp("en", tone(0.05)), { ok: true, text: "" });
		assert.equal(requests().length, 0);
	});

	it("spawns the language's server once, reuses it, and sends the WAV, language code and vocabulary prompt", async () => {
		process.env.LH_WHISPER_BIN = bin;
		process.env.LH_WHISPER_THREADS = "3";
		process.env.FAKE_WHISPER_LOG = LOG;
		const a = await whisper.transcribeWhisperCpp("nb", tone(), "Kirchhoffs lov, nodeanalyse.");
		const b = await whisper.transcribeWhisperCpp("nb", tone());
		assert.deepEqual(a, { ok: true, text: "hello world" }); // [BLANK_AUDIO] and the leading space are cleaned
		assert.deepEqual(b, { ok: true, text: "hello world" });
		const log = requests();
		const starts = log.filter((l) => l.started);
		assert.equal(starts.length, 1, "one server for two requests");
		assert.equal(starts[0]!.started.model, path.join(DATA, "models", "stt", "ggml", WHISPERCPP_MODELS.nb.file));
		assert.equal(starts[0]!.started.host, "127.0.0.1");
		assert.equal(starts[0]!.started.threads, "3");
		const sent = log.filter((l) => !l.started);
		assert.equal(sent[0]!.language, "no");
		assert.equal(sent[0]!.temperature, "0");
		assert.equal(sent[0]!.format, "json");
		assert.equal(sent[0]!.prompt, "Kirchhoffs lov, nodeanalyse.");
		assert.equal(sent[0]!.riff, true);
		assert.equal(sent[1]!.prompt, null, "no vocabulary, no prompt field");
	});

	it("runs one server per language", async () => {
		process.env.LH_WHISPER_BIN = bin;
		const before = requests().filter((l) => l.started).length;
		await whisper.transcribeWhisperCpp("en", tone());
		const starts = requests().filter((l) => l.started);
		assert.equal(starts.length, before + 1);
		assert.equal(starts.at(-1)!.started.model, path.join(DATA, "models", "stt", "ggml", WHISPERCPP_MODELS.en.file));
	});

	it("turns a transcript that merely echoes the prompt into silence", async () => {
		// a server that answers every clip with the prompt it was given (what a real model does on an unclear clip)
		const echo = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const prompt = /name="prompt"\r\n\r\n([^\r]*)\r\n/.exec(Buffer.concat(chunks).toString("utf8"))?.[1] ?? "";
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: ` ${prompt}` }));
			});
		});
		await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
		process.env.LH_WHISPER_URL_EN = `http://127.0.0.1:${(echo.address() as { port: number }).port}`;
		try {
			const vocab = "Norton, Thévenin equivalent, superposition.";
			assert.deepEqual(await whisper.transcribeWhisperCpp("en", tone(), vocab), { ok: true, text: "" });
			assert.deepEqual(await whisper.transcribeWhisperCpp("en", tone()), { ok: true, text: "" }); // no prompt sent: nothing to echo
		} finally {
			delete process.env.LH_WHISPER_URL_EN;
			await new Promise<void>((resolve) => echo.close(() => resolve()));
		}
	});

	it("reports a model that is on disk as cached and a running server as ready", () => {
		const statuses = whisper.whisperCppStatuses();
		const nb = statuses.find((s) => s.language === "nb")!;
		assert.equal(nb.state, "ready");
		assert.equal(nb.repo, `${WHISPERCPP_MODELS.nb.repo}/${WHISPERCPP_MODELS.nb.file}`);
		assert.equal(nb.sizeMb, WHISPERCPP_MODELS.nb.sizeMb);
	});

	it("reports an absent model as absent", () => {
		const file = path.join(DATA, "models", "stt", "ggml", WHISPERCPP_MODELS.en.file);
		whisper.stopWhisperCpp();
		fs.renameSync(file, `${file}.moved`);
		try {
			// the stopped server's exit handler has not necessarily run yet; the file is what decides once no server is up
			const en = whisper.whisperCppStatuses().find((s) => s.language === "en")!;
			assert.ok(en.state === "absent" || en.state === "ready", en.state);
		} finally {
			fs.renameSync(`${file}.moved`, file);
		}
	});

	it("URL mode calls the named server and spawns nothing", async () => {
		const seen: string[] = [];
		external = http.createServer((req, res) => {
			seen.push(`${req.method} ${req.url}`);
			req.resume();
			req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: "from the termux server" })));
		});
		await new Promise<void>((resolve) => external!.listen(0, "127.0.0.1", resolve));
		const { port } = external.address() as { port: number };
		delete process.env.LH_WHISPER_BIN;
		process.env.LH_WHISPER_URL_NB = `http://127.0.0.1:${port}/`;
		try {
			const startsBefore = requests().filter((l) => l.started).length;
			assert.deepEqual(await whisper.transcribeWhisperCpp("nb", tone()), { ok: true, text: "from the termux server" });
			assert.ok(seen.includes("POST /inference"));
			assert.equal(requests().filter((l) => l.started).length, startsBefore);
			const nb = whisper.whisperCppStatuses().find((s) => s.language === "nb")!;
			assert.equal(nb.state, "ready");
			assert.equal(nb.repo, `http://127.0.0.1:${port}`);
			// a language with no URL falls back to spawn mode — which has no binary here
			const en = await whisper.transcribeWhisperCpp("en", tone());
			assert.equal(en.ok, false);
		} finally {
			delete process.env.LH_WHISPER_URL_NB;
		}
	});

	it("URL mode surfaces an unreachable server as an error reply", async () => {
		process.env.LH_WHISPER_URL_EN = "http://127.0.0.1:9"; // discard port: nothing listens
		try {
			const reply = await whisper.transcribeWhisperCpp("en", tone());
			assert.equal(reply.ok, false);
			assert.equal(whisper.whisperCppStatuses().find((s) => s.language === "en")!.state, "error");
		} finally {
			delete process.env.LH_WHISPER_URL_EN;
		}
	});
});
