import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { withdrawDictation } from "../components/dictation-live.ts";
import { createLiveTranscript, nativeSpeechReady, probeNativeSpeech, resetNativeSpeechForTests, startNativeSpeech } from "../components/dictation-native.ts";
import { decodeSpeechLine, encodeSpeechOp, SPEECH_ERROR_CODES, SPEECH_ERROR_MESSAGES } from "../src/core/speech-bridge.ts";

/**
 * M12 step 6: dictation in the Android shell. The wire format is pure (src/core/speech-bridge.ts); the page adapter
 * (components/dictation-native.ts) is driven here by a fake `window.lhAndroid` that records posts and plays lines back.
 */

test("page operations encode to one speech line each", () => {
	assert.equal(encodeSpeechOp({ op: "probe" }), "speech probe");
	assert.equal(encodeSpeechOp({ op: "start", language: "nb" }), "speech start nb");
	assert.equal(encodeSpeechOp({ op: "stop" }), "speech stop");
	assert.equal(encodeSpeechOp({ op: "cancel" }), "speech cancel");
});

test("shell lines decode, and anything else is ignored without throwing", () => {
	assert.deepEqual(decodeSpeechLine("speech ready"), { kind: "ready" });
	assert.deepEqual(decodeSpeechLine("speech state listening"), { kind: "state", state: "listening" });
	assert.deepEqual(decodeSpeechLine("speech state idle\n"), { kind: "state", state: "idle" });
	assert.deepEqual(decodeSpeechLine("speech partial  hello the "), { kind: "partial", text: "hello the" });
	assert.deepEqual(decodeSpeechLine("speech final  hello there, world "), { kind: "final", text: "hello there, world" });
	assert.deepEqual(decodeSpeechLine("speech error language pack missing"), { kind: "error", code: "language", detail: "pack missing" });
	assert.deepEqual(decodeSpeechLine("speech error busy"), { kind: "error", code: "busy", detail: "" });
	for (const bad of ["", "ready", "speech", "speech state hmm", "speech partial", "speech final", "speech error nope x", "stroke {}", "pan 3"]) {
		assert.equal(decodeSpeechLine(bad), null, bad);
	}
});

test("every error code has a message the learner can act on", () => {
	for (const code of SPEECH_ERROR_CODES) assert.ok(SPEECH_ERROR_MESSAGES[code].length > 10, code);
});

type Listener = (event: { data: unknown }) => void;

function fakeShell() {
	const posts: string[] = [];
	const listeners = new Set<Listener>();
	const shell = {
		postMessage: (m: string) => void posts.push(m),
		addEventListener: (_t: "message", l: Listener) => void listeners.add(l),
		removeEventListener: (_t: "message", l: Listener) => void listeners.delete(l),
	};
	(globalThis as unknown as { window: unknown }).window = { lhAndroid: shell };
	return { posts, listeners, say: (line: string) => [...listeners].forEach((l) => l({ data: line })) };
}

afterEach(() => {
	resetNativeSpeechForTests();
	delete (globalThis as unknown as { window?: unknown }).window;
});

test("not ready without a shell, nor in a shell that never answers the probe", () => {
	assert.equal(nativeSpeechReady(), false);
	probeNativeSpeech(); // no window at all: nothing happens
	const shell = fakeShell();
	probeNativeSpeech();
	assert.deepEqual(shell.posts, ["speech probe"]);
	assert.equal(nativeSpeechReady(), false); // an older shell stays silent
	shell.say("stroke {}"); // an ink line is not an answer
	assert.equal(nativeSpeechReady(), false);
});

test("the shell's answer makes speech ready, and the probe listener goes away", () => {
	const shell = fakeShell();
	probeNativeSpeech();
	probeNativeSpeech(); // a second mount does not probe twice
	assert.equal(shell.posts.length, 1);
	shell.say("speech ready");
	assert.equal(nativeSpeechReady(), true);
	assert.equal(shell.listeners.size, 0);
});

test("a run forwards state, finals and errors, and stops and cancels through the shell", () => {
	const shell = fakeShell();
	const seen: string[] = [];
	const run = startNativeSpeech("nb", {
		onState: (s) => seen.push(`state:${s}`),
		onPartial: (t) => seen.push(`partial:${t}`),
		onFinal: (t) => seen.push(`final:${t}`),
		onError: (c, d) => seen.push(`error:${c}:${d}`),
	});
	assert.deepEqual(shell.posts, ["speech start nb"]);
	shell.say("speech state listening");
	shell.say("speech partial first");
	shell.say("speech final first part");
	shell.say("pan 4"); // not ours
	shell.say("speech final second part");
	run.stop();
	assert.equal(shell.posts.at(-1), "speech stop");
	shell.say("speech state idle");
	shell.say("speech error other boom");
	assert.deepEqual(seen, ["state:listening", "partial:first", "final:first part", "final:second part", "state:idle", "error:other:boom"]);

	run.cancel();
	assert.equal(shell.posts.at(-1), "speech cancel");
	assert.equal(shell.listeners.size, 0);
	shell.say("speech final late"); // after cancel nothing lands
	assert.equal(seen.length, 6);
});

test("a disposed run sends nothing more", () => {
	const shell = fakeShell();
	const run = startNativeSpeech("en", { onState() {}, onPartial() {}, onFinal() {}, onError() {} });
	run.dispose();
	run.dispose();
	run.stop();
	run.cancel();
	assert.deepEqual(shell.posts, ["speech start en"]);
});

// ── the live transcript: words appear as they are spoken ─────────────────────

/** A dictation field with the contract of components/dictation.tsx: append a piece, or withdraw the last occurrence of it. */
function field(initial = "") {
	let text = initial;
	const append = (t: string, withdraw = false) => {
		text = withdraw ? withdrawDictation(text, t) : text ? text.replace(/\s+$/, "") + " " + t : t;
	};
	return { append, get text() { return text; } };
}

test("each partial replaces the last one in the field, and the final replaces its partial", () => {
	const f = field();
	const live = createLiveTranscript(() => f.append);
	live.partial("hello");
	assert.equal(f.text, "hello");
	live.partial("hello the");
	assert.equal(f.text, "hello the");
	live.partial("hello there");
	assert.equal(f.text, "hello there");
	live.final("Hello there.");
	assert.equal(f.text, "Hello there.");
	live.partial("how are");
	assert.equal(f.text, "Hello there. how are");
	live.final("How are you?");
	assert.equal(f.text, "Hello there. How are you?");
});

test("text that was already in the field is kept around the live words", () => {
	const f = field("My notes:");
	const live = createLiveTranscript(() => f.append);
	live.partial("one");
	live.partial("one two");
	assert.equal(f.text, "My notes: one two");
	live.final("one two three");
	assert.equal(f.text, "My notes: one two three");
});

test("a repeated or blank partial changes nothing", () => {
	const f = field();
	const live = createLiveTranscript(() => f.append);
	live.partial("same");
	live.partial("same");
	live.partial("   ");
	assert.equal(f.text, "same");
	live.final("");
	assert.equal(f.text, "", "an empty final just clears the partial it replaces");
});

test("Esc takes the partial and every final of the run back out, leaving what was there before", () => {
	const f = field("Before.");
	const live = createLiveTranscript(() => f.append);
	live.partial("first");
	live.final("First part.");
	live.partial("second");
	assert.equal(f.text, "Before. First part. second");
	live.discard();
	assert.equal(f.text, "Before.");
});

test("when the run ends, what is in the field stays, and a stray partial is not withdrawn later", () => {
	const f = field();
	const live = createLiveTranscript(() => f.append);
	live.partial("left over");
	live.settle();
	live.discard();
	assert.equal(f.text, "left over");
});

test("a stretch stays in the field it began in, the next one goes to the field that holds the claim then", () => {
	const composer = field();
	const question = field();
	let claimed = composer;
	const live = createLiveTranscript(() => claimed.append);
	live.partial("in the composer");
	claimed = question; // a question takes the claim mid-stretch
	live.partial("in the composer still");
	assert.equal(composer.text, "in the composer still");
	assert.equal(question.text, "");
	live.final("In the composer still.");
	live.partial("now the question");
	assert.equal(question.text, "now the question");
	assert.equal(composer.text, "In the composer still.");
});
