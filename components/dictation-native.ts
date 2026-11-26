import { decodeSpeechLine, encodeSpeechOp, type LessonLanguage, type SpeechErrorCode, type SpeechEvent, type SpeechState } from "@/src/core";

/**
 * The page's side of the Android shell's speech recognizer (docs/android/m12-plan.md, step 6). In the shell dictation
 * comes from the system recognizer through `window.lhAndroid`; everywhere else this module reports "not ready" and the
 * existing engines (local, Deepgram) run unchanged. Wire format: src/core/speech-bridge.ts.
 */

/** The shell's side of `window.lhAndroid` (a WebMessageListener's JS object). */
interface Bridge {
	postMessage(message: string): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

function bridge(): Bridge | null {
	if (typeof window === "undefined") return null;
	const b = (window as unknown as { lhAndroid?: Partial<Bridge> }).lhAndroid;
	return b && typeof b.postMessage === "function" && typeof b.addEventListener === "function" ? (b as Bridge) : null;
}

const lineOf = (data: unknown): string => (typeof data === "string" ? data : "");

let ready = false;
let probing = false;

/**
 * Ask the shell once whether it can dictate. An older shell (ink only) never answers, so "ready" stays false and the
 * page keeps its server-side engines: the answer, not the mere presence of `lhAndroid`, is what counts.
 */
export function probeNativeSpeech(): void {
	const b = bridge();
	if (!b || ready || probing) return;
	probing = true;
	const listener = (event: { data: unknown }) => {
		if (decodeSpeechLine(lineOf(event.data))?.kind === "ready") {
			ready = true;
			b.removeEventListener("message", listener);
		}
	};
	b.addEventListener("message", listener);
	b.postMessage(encodeSpeechOp({ op: "probe" }));
}

export function nativeSpeechReady(): boolean {
	return ready && bridge() !== null;
}

export interface NativeSpeechHandlers {
	onState(state: SpeechState): void;
	onPartial(text: string): void;
	onFinal(text: string): void;
	/** How loud the learner is, 0..1 (a few times a second while listening). */
	onLevel?(level: number): void;
	onError(code: SpeechErrorCode, detail: string): void;
	/** Which recognizer the run uses: true once the shell went online (the opt-in, and no offline pack for the language). */
	onMode?(online: boolean): void;
}

export interface NativeSpeechRun {
	/** End and keep: finals still arrive, then state idle. */
	stop(): void;
	/** End and discard. */
	cancel(): void;
	/** Detach from the channel (a finished or abandoned run). Idempotent. */
	dispose(): void;
}

/**
 * Begin dictating in `language`. `online` is the learner's opt-in (Settings → Dictation): it only PERMITS the shell to use the
 * online recognizer when the language has no offline pack. Throws when the shell is not there; callers check [nativeSpeechReady] first.
 */
export function startNativeSpeech(language: LessonLanguage, handlers: NativeSpeechHandlers, online = false): NativeSpeechRun {
	const b = bridge();
	if (!b) throw new Error("the Android shell's speech bridge is not available");
	let live = true;
	const listener = (event: { data: unknown }) => {
		if (!live) return;
		const e: SpeechEvent | null = decodeSpeechLine(lineOf(event.data));
		if (!e) return;
		if (e.kind === "state") handlers.onState(e.state);
		else if (e.kind === "partial") handlers.onPartial(e.text);
		else if (e.kind === "final") handlers.onFinal(e.text);
		else if (e.kind === "level") handlers.onLevel?.(e.level);
		else if (e.kind === "mode") handlers.onMode?.(e.online);
		else if (e.kind === "error") handlers.onError(e.code, e.detail);
	};
	b.addEventListener("message", listener);
	b.postMessage(encodeSpeechOp({ op: "start", language, online }));
	const dispose = () => {
		if (!live) return;
		live = false;
		b.removeEventListener("message", listener);
	};
	return {
		stop: () => {
			if (live) b.postMessage(encodeSpeechOp({ op: "stop" }));
		},
		cancel: () => {
			if (live) b.postMessage(encodeSpeechOp({ op: "cancel" }));
			dispose();
		},
		dispose,
	};
}

/** Test seam: forget the probe result. */
export function resetNativeSpeechForTests(): void {
	ready = false;
	probing = false;
}

/**
 * Spreads the recognizer's loudness over the whole meter. The system recognizer's level moves only a little between a
 * quiet room and speech and differs from phone to phone, so used raw the meter barely changes (owner, 2026-10-28). The shell
 * sends a level about twenty times a second. This follows the quietest level it has heard (the room) slowly upward and the
 * loudest (the voice) downward over about a second, and scales each level between them: silence reads 0, the current peak
 * reads 1. A short pause between words dips the meter at once. Pure and stateful per run.
 */
export function createLevelNormalizer(): (level: number) => number {
	let floor: number | null = null;
	let peak = 0;
	return (level) => {
		if (floor === null) {
			floor = level;
			peak = level;
		}
		floor = level < floor ? level : floor + (level - floor) * 0.004; // the room: drops at once, drifts up over about twelve seconds
		peak = level > peak ? level : peak - (peak - floor) * 0.05; // the voice: rises at once, fades over about a second
		const range = Math.max(peak - floor, 0.12); // a run of silence must not blow its own noise up to full scale
		return Math.min(1, Math.max(0, (level - floor) / range)) ** 0.7;
	};
}

/** A dictation target: adds a piece, or with `withdraw` takes one back (the same contract as components/dictation.tsx). */
type Target = (text: string, withdraw?: boolean) => void;

export interface LiveTranscript {
	/** The recognizer's current guess: shown in the field at once and replaced by the next partial or the final. */
	partial(text: string): void;
	/** A stretch is done: the partial (if any) is replaced by it, and it stays. */
	final(text: string): void;
	/** Esc: everything this run put in the field is taken back out, newest first. */
	discard(): void;
	/** The run ended: what is in the field stays as it is. */
	settle(): void;
}

/** After this much silence between updates, a shrinking or single-word change is treated as a new stretch. */
const PAUSE_COMMIT_MS = 1500;

const wordsOf = (text: string): string[] =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);

const compactOf = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function sharedPrefixLength(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

/** Ordered word matches (LCS) between `prevWords` and `nextWords`, allowing a trailing word prefix/extension match. */
function orderedWordMatches(prevWords: readonly string[], nextWords: readonly string[]): number {
	let prev = new Array<number>(nextWords.length + 1).fill(0);
	let curr = new Array<number>(nextWords.length + 1).fill(0);
	for (let i = 0; i < prevWords.length; i++) {
		curr[0] = 0;
		const a = prevWords[i] ?? "";
		for (let j = 0; j < nextWords.length; j++) {
			const b = nextWords[j] ?? "";
			const matches = a === b || (i === prevWords.length - 1 && a.length >= 2 && (b.startsWith(a) || a.startsWith(b)));
			curr[j + 1] = matches ? (prev[j] ?? 0) + 1 : Math.max(prev[j + 1] ?? 0, curr[j] ?? 0);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[nextWords.length] ?? 0;
}

/**
 * True when `next` is a revision or continuation of `previous` (so replacing `previous` with `next` will not wipe
 * already-spoken words). False when the recognizer started a fresh stretch after a pause or filler ("umm"/"eh").
 */
function preservesPrevious(previous: string, next: string, elapsedMs: number): boolean {
	const cp = compactOf(previous);
	const cn = compactOf(next);
	if (cp.length === 0) return true;
	if (cn.length === 0) return false;
	if (cn.includes(cp)) return true;

	const pw = wordsOf(previous);
	const nw = wordsOf(next);
	if (pw.length === 0) return true;
	if (nw.length === 0) return false;

	const paused = elapsedMs >= PAUSE_COMMIT_MS;
	const matched = orderedWordMatches(pw, nw);
	if (paused && nw.length < pw.length && cn.length < cp.length && matched / pw.length < 0.8) return false;
	if (pw.length === 1) return matched === 1 || (nw.length === 1 && !paused);
	if (pw.length === 2) {
		if (matched === 2) return true;
		if (matched === 1 && nw.length >= 2 && !paused) return true;
		return cp.length >= 4 && sharedPrefixLength(cp, cn) >= cp.length * 0.7 && cn.length >= cp.length * 0.7;
	}
	return matched / pw.length >= 0.6 || (cp.length >= 4 && sharedPrefixLength(cp, cn) >= cp.length * 0.7);
}

/** True when `next` recovers the full `kept` stretch after a temporary reset/flicker. */
function recoversPrefix(kept: string, next: string): boolean {
	const ck = compactOf(kept);
	const cn = compactOf(next);
	if (ck.length === 0 || cn.length < ck.length * 0.85) return false;
	if (cn.startsWith(ck)) return true;
	const kw = wordsOf(kept);
	const nw = wordsOf(next);
	if (kw.length === 0 || nw.length < kw.length) return false;
	return orderedWordMatches(kw, nw.slice(0, kw.length + 2)) / kw.length >= 0.8;
}

/**
 * Words appear as they are spoken, like a keyboard's voice typing (owner, 2026-10-28): each partial replaces the last in
 * the field it went to, and a final replaces the partial. `resolveTarget` is asked for the field at the first piece of a
 * stretch, so a question that takes the claim mid-run gets the next stretch; a stretch stays in the field it began in.
 */
export function createLiveTranscript(resolveTarget: () => Target, now: () => number = Date.now): LiveTranscript {
	let current: { text: string; target: Target; at: number } | null = null;
	const delivered: Array<{ text: string; target: Target }> = [];
	const autoKept: Array<{ text: string; target: Target }> = [];
	const clearPartial = (): Target | null => {
		if (!current) return null;
		const { text, target } = current;
		target(text, true);
		current = null;
		return target;
	};
	const recoverAutoKept = (t: string): Target | null => {
		const first = autoKept[0];
		if (!first) return null;
		const sharedTarget = first.target;
		if (autoKept.some((e) => e.target !== sharedTarget) || (current && current.target !== sharedTarget)) return null;
		const combined = autoKept.map((e) => e.text).join(" ");
		if (!recoversPrefix(combined, t)) return null;
		clearPartial();
		for (const entry of autoKept.splice(0).reverse()) {
			entry.target(entry.text, true);
			const idx = delivered.lastIndexOf(entry);
			if (idx >= 0) delivered.splice(idx, 1);
		}
		return sharedTarget;
	};
	return {
		partial(text) {
			const t = text.trim();
			if (!t || current?.text === t) return;
			const ts = now();
			const recoveredTarget = recoverAutoKept(t);
			if (recoveredTarget) {
				recoveredTarget(t);
				current = { text: t, target: recoveredTarget, at: ts };
				return;
			}
			if (current && !preservesPrevious(current.text, t, ts - current.at)) {
				const kept = { text: current.text, target: current.target };
				delivered.push(kept);
				autoKept.push(kept);
				current = null;
			}
			const target = clearPartial() ?? resolveTarget();
			target(t);
			current = { text: t, target, at: ts };
		},
		final(text) {
			const t = text.trim();
			if (!t) {
				clearPartial();
				autoKept.length = 0;
				return;
			}
			const ts = now();
			const recoveredTarget = recoverAutoKept(t);
			if (recoveredTarget) {
				recoveredTarget(t);
				delivered.push({ text: t, target: recoveredTarget });
				return;
			}
			if (current && !preservesPrevious(current.text, t, ts - current.at)) {
				delivered.push({ text: current.text, target: current.target });
				current = null;
			}
			const target = clearPartial() ?? resolveTarget();
			target(t);
			delivered.push({ text: t, target });
			autoKept.length = 0;
		},
		discard() {
			autoKept.length = 0;
			clearPartial();
			for (const { text, target } of delivered.splice(0).reverse()) target(text, true);
		},
		settle() {
			current = null;
			delivered.length = 0;
			autoKept.length = 0;
		},
	};
}
