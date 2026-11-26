import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { withdrawDictation } from "../components/dictation-live.ts";
import { createLevelNormalizer, createLiveTranscript, nativeSpeechReady, probeNativeSpeech, resetNativeSpeechForTests, startNativeSpeech } from "../components/dictation-native.ts";
import { decodeSpeechLine, encodeSpeechOp, SPEECH_ERROR_CODES, SPEECH_ERROR_MESSAGES } from "../src/core/speech-bridge.ts";

/**
 * M12 step 6: dictation in the Android shell. The wire format is pure (src/core/speech-bridge.ts); the page adapter
 * (components/dictation-native.ts) is driven here by a fake `window.lhAndroid` that records posts and plays lines back.
 */

test("page operations encode to one speech line each", () => {
	assert.equal(encodeSpeechOp({ op: "probe" }), "speech probe");
	assert.equal(encodeSpeechOp({ op: "start", language: "nb" }), "speech start nb");
	assert.equal(encodeSpeechOp({ op: "start", language: "nb", online: false }), "speech start nb", "no opt-in = the old line");
	assert.equal(encodeSpeechOp({ op: "start", language: "nb", online: true }), "speech start nb online", "the opt-in rides the start line");
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
	assert.deepEqual(decodeSpeechLine("speech error unsupported nb"), { kind: "error", code: "unsupported", detail: "nb" });
	assert.deepEqual(decodeSpeechLine("speech error busy"), { kind: "error", code: "busy", detail: "" });
	assert.deepEqual(decodeSpeechLine("speech level 0.42"), { kind: "level", level: 0.42 });
	assert.deepEqual(decodeSpeechLine("speech mode online"), { kind: "mode", online: true });
	assert.deepEqual(decodeSpeechLine("speech mode offline"), { kind: "mode", online: false });
	assert.equal(decodeSpeechLine("speech mode cloudy"), null);
	assert.deepEqual(decodeSpeechLine("speech level 7"), { kind: "level", level: 1 }, "clamped");
	for (const bad of ["", "ready", "speech", "speech state hmm", "speech partial", "speech final", "speech error nope x", "speech level", "speech level loud", "stroke {}", "pan 3"]) {
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

test("a new stretch that starts over without a final keeps the long one before it (long dictation lost its text)", () => {
	const f = field();
	const live = createLiveTranscript(() => f.append);
	const stretch = "snakke sånn som det her da eh til her ehm det du burde jo bare få han til å følge med";
	live.partial(stretch);
	live.partial(stretch + " på loggene");
	live.partial("Hei");
	assert.equal(f.text, stretch + " på loggene Hei");
	live.partial("Hei Halla");
	assert.equal(f.text, stretch + " på loggene Hei Halla", "the new stretch is replaced by its own partials as before");
	live.final("Hei, hallo.");
	assert.equal(f.text, stretch + " på loggene Hei, hallo.");
	live.discard();
	assert.equal(f.text, "", "Esc takes the kept stretch back out too");
});

test("revisions of a long partial are not mistaken for a new stretch", () => {
	const f = field();
	const live = createLiveTranscript(() => f.append);
	const head = "la oss bare se vi snakke i 3 minutt ja så får jeg satse på å se om denne boks";
	live.partial(head + " tilogs");
	live.partial(head + " The Long");
	live.partial(head.toUpperCase().slice(0, 1) + head.slice(1) + " the long"); // a capital letter at the start
	assert.equal(f.text, head.toUpperCase().slice(0, 1) + head.slice(1) + " the long");
});

test("a short partial that is corrected to another word is replaced, not kept", () => {
	const f = field();
	const live = createLiveTranscript(() => f.append);
	live.partial("Hei");
	live.partial("Hvem");
	assert.equal(f.text, "Hvem");
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

test("the level normalizer spreads a narrow recognizer range over the whole meter", () => {
	const norm = createLevelNormalizer();
	const quiet = [0.22, 0.2, 0.21, 0.2, 0.22].map(norm);
	assert.ok(Math.max(...quiet) < 0.35, "a quiet room stays low");
	const speech = [0.3, 0.38, 0.34, 0.4].map(norm);
	assert.ok(Math.max(...speech) > 0.9, "speech reaches the top even though the raw level moved by 0.2");
	assert.ok(norm(0.2) < 0.15, "back to quiet it falls back");
	for (const raw of [0, 1, 0.5, 0.5, 0.5]) assert.ok(norm(raw) >= 0 && norm(raw) <= 1);
});

test("short phrases (< 30 chars) are kept when a pause or filler word restarts partials in English and Norwegian", () => {
	for (const [first, next] of [
		["I think the answer is 5", "um"],
		["Jeg tror svaret er fem", "eh"],
		["Det er riktig", "og så"],
		["First step", "um"],
	] as const) {
		const f = field();
		const live = createLiveTranscript(() => f.append);
		live.partial(first);
		live.partial(next);
		assert.equal(f.text, `${first} ${next}`);
	}
});

test("restarts sharing the opening letter or opening word do not wipe the previous stretch", () => {
	const cases: ReadonlyArray<readonly [string, string]> = [
		["I think the derivative of x squared is 2x", "I"],
		["I think the derivative of x squared is 2x", "in"],
		["I think the derivative of x squared is 2x", "I think"],
		["Er det sånn at vi bruker kjerneregelen", "eh"],
		["Jeg tror at svaret på oppgaven er fem", "ja"],
		["Jeg tror at svaret på oppgaven er fem", "jeg"],
	];
	for (const [first, next] of cases) {
		const f = field();
		const live = createLiveTranscript(() => f.append);
		live.partial(first);
		live.partial(next);
		assert.equal(f.text, `${first} ${next}`);
	}
});

test("a final with only a filler or post-pause clause keeps the previous partial", () => {
	const en = field();
	const liveEn = createLiveTranscript(() => en.append);
	liveEn.partial("I think the derivative of x squared is 2x");
	liveEn.final("um");
	assert.equal(en.text, "I think the derivative of x squared is 2x um");

	const nb = field();
	const liveNb = createLiveTranscript(() => nb.append);
	liveNb.partial("Jeg tror svaret blir fem");
	liveNb.final("fordi x er to");
	assert.equal(nb.text, "Jeg tror svaret blir fem fordi x er to");
});

test("pause-aware single-word and shrinking protection keeps prior speech after a pause", () => {
	let clock = 1000;
	const now = () => clock;

	// Single word + 2s pause + "um" -> kept
	const f1 = field();
	const l1 = createLiveTranscript(() => f1.append, now);
	l1.partial("Yes");
	clock += 2000;
	l1.partial("um");
	assert.equal(f1.text, "Yes um");

	// Single word + 2s pause + punctuated final -> replaced cleanly
	const f2 = field();
	const l2 = createLiveTranscript(() => f2.append, now);
	l2.partial("Yes");
	clock += 2000;
	l2.final("Yes.");
	assert.equal(f2.text, "Yes.");

	// Short phrase + 2s pause + shrinking prefix -> kept
	const f3 = field();
	const l3 = createLiveTranscript(() => f3.append, now);
	l3.partial("I think so");
	clock += 2000;
	l3.partial("I think");
	assert.equal(f3.text, "I think so I think");

	// Leading filler stripped by final after pause -> replaced cleanly without duplication
	const f4 = field();
	const l4 = createLiveTranscript(() => f4.append, now);
	l4.partial("um I think the answer is 5");
	clock += 2000;
	l4.final("I think the answer is 5.");
	assert.equal(f4.text, "I think the answer is 5.");
});

test("Norwegian compound-word revision replaces cleanly without duplication", () => {
	const f = field();
	const live = createLiveTranscript(() => f.append);
	live.partial("kjerne regelen er grei");
	live.partial("kjerneregelen er grei");
	assert.equal(f.text, "kjerneregelen er grei");
});

test("flicker recovery deduplicates when the recognizer recovers the full stretch after a temporary reset", () => {
	const f = field();
	const live = createLiveTranscript(() => f.append);
	live.partial("I think the voltage is 5 volts");
	live.partial("um");
	assert.equal(f.text, "I think the voltage is 5 volts um");
	live.final("I think the voltage is 5 volts, um, and then.");
	assert.equal(f.text, "I think the voltage is 5 volts, um, and then.");
	live.discard();
	assert.equal(f.text, "", "Esc still removes everything cleanly");
});
