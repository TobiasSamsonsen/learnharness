import type { LessonLanguage } from "./language.ts";

/**
 * The speech half of `window.lhAndroid` (docs/android/m12-plan.md, step 6). In the Android shell dictation comes from the
 * system SpeechRecognizer, ON-DEVICE only (owner, 2026-10-28: audio never leaves the phone). The page and the shell talk
 * over the same channel as the native ink layer: one text line per message, every line starting with the verb `speech`,
 * so each side's parser ignores the other's lines. Pure on purpose: the Kotlin side (SpeechBridge.kt, SpeechWire) mirrors it.
 *
 *   page → shell   speech probe                  is speech available here? (answered once, by `speech ready`)
 *                  speech start <en|nb>          begin dictating in that lesson language
 *                  speech stop                   end and KEEP what was heard (finals still arrive, then state idle)
 *                  speech cancel                 end and DISCARD (nothing more arrives)
 *   shell → page   speech ready                  this shell can dictate
 *                  speech state <listening|processing|idle>
 *                  speech final <text>           one recognized stretch (the shell restarts listening after pauses)
 *                  speech error <code> [detail]  codes: permission, unavailable, language, network, busy, other
 */

export type SpeechOp = { op: "probe" } | { op: "start"; language: LessonLanguage } | { op: "stop" } | { op: "cancel" };

export const SPEECH_ERROR_CODES = ["permission", "unavailable", "language", "network", "busy", "other"] as const;
export type SpeechErrorCode = (typeof SPEECH_ERROR_CODES)[number];

export type SpeechState = "listening" | "processing" | "idle";

export type SpeechEvent =
	| { kind: "ready" }
	| { kind: "state"; state: SpeechState }
	| { kind: "final"; text: string }
	| { kind: "error"; code: SpeechErrorCode; detail: string };

/** What the learner reads in the dictation button when the shell reports an error. */
export const SPEECH_ERROR_MESSAGES: Readonly<Record<SpeechErrorCode, string>> = {
	permission: "Microphone permission is off for this app (Android settings, Apps, learnharness, Permissions).",
	unavailable: "Offline speech recognition is not available on this phone.",
	language: "The offline speech pack for this language is not installed yet. Android is downloading it; try again in a minute.",
	network: "Speech recognition lost its connection.",
	busy: "Another app is using speech recognition. Try again.",
	other: "Speech recognition stopped unexpectedly.",
};

export function encodeSpeechOp(op: SpeechOp): string {
	return op.op === "start" ? `speech start ${op.language}` : `speech ${op.op}`;
}

const isErrorCode = (v: string): v is SpeechErrorCode => (SPEECH_ERROR_CODES as readonly string[]).includes(v);

/** One line from the shell, or null when it is not a speech line the page understands (never throws). */
export function decodeSpeechLine(line: string): SpeechEvent | null {
	const text = line.trim();
	if (!text.startsWith("speech ")) return null;
	const rest = text.slice("speech ".length);
	const verb = rest.split(" ", 1)[0] ?? "";
	const arg = rest.slice(verb.length).trim();
	switch (verb) {
		case "ready":
			return { kind: "ready" };
		case "state":
			return arg === "listening" || arg === "processing" || arg === "idle" ? { kind: "state", state: arg } : null;
		case "final":
			return arg ? { kind: "final", text: arg } : null;
		case "error": {
			const code = arg.split(" ", 1)[0] ?? "";
			return isErrorCode(code) ? { kind: "error", code, detail: arg.slice(code.length).trim() } : null;
		}
		default:
			return null;
	}
}
