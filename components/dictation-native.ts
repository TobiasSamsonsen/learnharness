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
}

export interface NativeSpeechRun {
	/** End and keep: finals still arrive, then state idle. */
	stop(): void;
	/** End and discard. */
	cancel(): void;
	/** Detach from the channel (a finished or abandoned run). Idempotent. */
	dispose(): void;
}

/** Begin dictating in `language`. Throws when the shell is not there; callers check [nativeSpeechReady] first. */
export function startNativeSpeech(language: LessonLanguage, handlers: NativeSpeechHandlers): NativeSpeechRun {
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
		else if (e.kind === "error") handlers.onError(e.code, e.detail);
	};
	b.addEventListener("message", listener);
	b.postMessage(encodeSpeechOp({ op: "start", language }));
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
 * quiet room and speech (and differs from phone to phone), so used raw the meter barely changes (owner, 2026-10-28). This
 * follows the quietest level it has heard (the room) slowly upward and the loudest (the voice) quickly downward, and
 * scales each level between them: silence reads 0, the current peak reads 1. Pure and stateful per run.
 */
export function createLevelNormalizer(): (level: number) => number {
	let floor: number | null = null;
	let peak = 0;
	return (level) => {
		if (floor === null) {
			floor = level;
			peak = level;
		}
		floor = level < floor ? level : floor + (level - floor) * 0.01; // the room: drops at once, drifts up over about ten seconds
		peak = level > peak ? level : peak - (peak - floor) * 0.03; // the voice: rises at once, fades over about three seconds
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

/**
 * Words appear as they are spoken, like a keyboard's voice typing (owner, 2026-10-28): each partial replaces the last in
 * the field it went to, and a final replaces the partial. `resolveTarget` is asked for the field at the first piece of a
 * stretch, so a question that takes the claim mid-run gets the next stretch; a stretch stays in the field it began in.
 */
export function createLiveTranscript(resolveTarget: () => Target): LiveTranscript {
	let current: { text: string; target: Target } | null = null;
	const delivered: Array<{ text: string; target: Target }> = [];
	const clearPartial = (): Target | null => {
		if (!current) return null;
		const { text, target } = current;
		target(text, true);
		current = null;
		return target;
	};
	return {
		partial(text) {
			const t = text.trim();
			if (!t || current?.text === t) return;
			const target = clearPartial() ?? resolveTarget();
			target(t);
			current = { text: t, target };
		},
		final(text) {
			const t = text.trim();
			const target = clearPartial() ?? resolveTarget();
			if (!t) return;
			target(t);
			delivered.push({ text: t, target });
		},
		discard() {
			clearPartial();
			for (const { text, target } of delivered.splice(0).reverse()) target(text, true);
		},
		settle() {
			current = null;
			delivered.length = 0;
		},
	};
}
