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
	onFinal(text: string): void;
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
		else if (e.kind === "final") handlers.onFinal(e.text);
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
