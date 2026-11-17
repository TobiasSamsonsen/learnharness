"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { pagePayload, readInk, readKept } from "@/components/sketch/ink-memory";
import { nativeInkBridge, nativeInkEnabled } from "@/components/sketch/use-native-ink";
import { HINT_MAX, HINT_NUDGE_MS, hintsOf, type HintSize, type SketchPayload } from "@/src/core";

/**
 * The Hint button's state, shared by the question dock (a lesson check), the practice dock and the sketch view
 * (owner, 2026-11-17 — core/hints.ts). One controller per open question or problem, owned by the dock; the sketch view gets it
 * as a prop, so a hint taken in either place shows in both.
 *
 * A hint request carries the learner's CURRENT page when there is any ink (kept plus unsent strokes), so the hint fits
 * where they are stuck. A lesson's hints are kept here (this device's storage, keyed by the call) and ride the answer. A practice
 * problem's hints are written into the chat by the server, which also counts them: the list kept here is the display copy,
 * replaced by the server's list on every answer.
 */

export interface HintLine {
	text: string;
	/** A practice hint's size (slip, nudge, carry); absent on a lesson hint. */
	size?: HintSize;
}

export interface HintControl {
	/** The Hint button is offered on this question or problem. */
	offered: boolean;
	lines: HintLine[];
	max: number;
	busy: boolean;
	error: string | null;
	/** Five minutes on screen without a hint taken: the button is quietly highlighted. */
	nudge: boolean;
	/** A hint cannot be asked for now (compaction running, an answer being prepared) or none are left. */
	disabled: boolean;
	ask: () => void;
	/** The lesson hints' texts, as they ride the answer. */
	texts: string[];
}

/** The learner's page as it stands now: the kept strokes then the unsent ink, or null when there is none (or it cannot be packed). */
export function currentPageForHint(inkKey: string): SketchPayload | null {
	try {
		const state = readInk(inkKey);
		const kept = readKept(inkKey);
		if (state.strokes.length === 0 && !(kept && kept.strokes.length > 0)) return null;
		return pagePayload(kept, state.strokes, nativeInkBridge() !== null && nativeInkEnabled() ? "android-ink" : "web-canvas", state.thawed !== undefined);
	} catch {
		return null; // a page that cannot be packed asks for a text-only hint
	}
}

function loadLines(key: string, kind: "lesson" | "practice"): HintLine[] {
	try {
		const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? "[]");
		if (kind === "lesson") return hintsOf(parsed).map((text) => ({ text }));
		return practiceLinesOf(parsed);
	} catch {
		return [];
	}
}

function practiceLinesOf(raw: unknown): HintLine[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.flatMap((h): HintLine[] => {
			const line = h as { text?: unknown; size?: unknown } | null;
			if (!line || typeof line.text !== "string" || line.text.trim() === "") return [];
			const size: HintSize | undefined = line.size === "slip" || line.size === "nudge" || line.size === "carry" ? line.size : undefined;
			return [size ? { text: line.text, size } : { text: line.text }];
		})
		.slice(0, HINT_MAX);
}

export function useHints(opts: {
	/** The question's or problem's tool-call id. */
	callId: string;
	kind: "lesson" | "practice";
	offered: boolean;
	/** What the learner has typed so far (read when a hint is asked for). */
	thinking: () => string;
	/** Compaction running, an answer being prepared: asking waits. */
	blocked?: boolean;
}): HintControl {
	const { callId, kind, offered, blocked = false } = opts;
	const chatActions = useContext(ChatActionsContext);
	const storageKey = `${kind === "lesson" ? "lh:hints:" : "lh:phints:"}${callId}`;
	const [lines, setLines] = useState<HintLine[]>(() => loadLines(storageKey, kind));
	const linesRef = useRef(lines);
	linesRef.current = lines;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [nudge, setNudge] = useState(false);
	const thinkingRef = useRef(opts.thinking);
	thinkingRef.current = opts.thinking;

	useEffect(() => {
		if (!offered) return;
		let onScreenMs = 0;
		const STEP = 5000;
		const timer = setInterval(() => {
			if (document.visibilityState !== "visible") return;
			onScreenMs += STEP;
			if (onScreenMs >= HINT_NUDGE_MS) {
				setNudge(true);
				clearInterval(timer);
			}
		}, STEP);
		return () => clearInterval(timer);
	}, [offered, callId]);

	const persist = (next: HintLine[]) => {
		try {
			globalThis.localStorage?.setItem(storageKey, JSON.stringify(kind === "lesson" ? next.map((l) => l.text) : next));
		} catch {
			// storage is a convenience: a lesson's hints still ride the answer, a practice problem's live in the chat
		}
	};

	const ask = () => {
		if (!chatActions || busy || blocked || linesRef.current.length >= HINT_MAX) return;
		void (async () => {
			setBusy(true);
			setError(null);
			try {
				const sketch = currentPageForHint(callId);
				const res = await fetch(`/api/chats/${encodeURIComponent(chatActions.chatId)}/hint`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						toolCallId: callId,
						...(kind === "lesson" ? { earlier: linesRef.current.map((l) => l.text) } : {}),
						thinking: thinkingRef.current().trim() || undefined,
						...(sketch ? { sketch } : {}),
					}),
				});
				const body = (await res.json().catch(() => null)) as { hint?: unknown; error?: unknown; hints?: unknown } | null;
				if (!res.ok || typeof body?.hint !== "string") {
					setError(typeof body?.error === "string" ? body.error : `Could not get a hint (${res.status})`);
					return;
				}
				let next: HintLine[];
				if (kind === "lesson") next = hintsOf([...linesRef.current.map((l) => l.text), body.hint]).map((text) => ({ text }));
				else {
					// the server's list is the truth (a hint taken on another device is in it)
					const server = practiceLinesOf(body.hints);
					next = server.length > 0 ? server : practiceLinesOf([...linesRef.current, { text: body.hint }]);
				}
				setLines(next);
				persist(next);
			} catch {
				setError("Could not get a hint");
			} finally {
				setBusy(false);
			}
		})();
	};

	return {
		offered: offered && chatActions !== null,
		lines,
		max: HINT_MAX,
		busy,
		error,
		nudge,
		disabled: busy || blocked || lines.length >= HINT_MAX,
		ask,
		texts: lines.map((l) => l.text),
	};
}

/** The button's label: the same wording in the dock and in the sketch view. */
export function hintLabel(h: Pick<HintControl, "busy" | "lines" | "max" | "nudge">): string {
	if (h.busy) return "Thinking…";
	if (h.lines.length >= h.max) return `Hints used (${h.max} of ${h.max})`;
	if (h.lines.length > 0) return `Hint (${h.lines.length} of ${h.max} used)`;
	return h.nudge ? "Stuck? Take a hint" : "Hint";
}
