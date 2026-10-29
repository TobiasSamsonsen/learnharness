import { SKETCH_MAX_POINTS, SKETCH_MAX_STROKES } from "@/src/core";

/**
 * What the sketch view says about itself in the status line under its top bar (M16a): the refusal text that used to sit in
 * a hidden, truncated footer span, the reasons Submit waits, and a warning before the page reaches its size limits. Pure.
 */

export type SketchStatusKind = "error" | "warn" | "info";
export interface SketchStatus {
	kind: SketchStatusKind;
	text: string;
}

/** Warn from this share of the stroke or point limit. */
export const LIMIT_WARN_SHARE = 0.8;

/** The larger of the stroke and point shares the page uses (0..1+). The byte limit is not estimated: points dominate it. */
export function limitShare(strokes: readonly { points: readonly number[] }[]): number {
	let points = 0;
	for (const s of strokes) points += Math.floor(s.points.length / 3);
	return Math.max(strokes.length / SKETCH_MAX_STROKES, points / SKETCH_MAX_POINTS);
}

export interface SketchStatusInput {
	error: string | null;
	/** The reason a press on a waiting Submit was ignored (info, not an error). */
	note?: string | null;
	nativeFallback: string | null | undefined;
	disabled: boolean;
	keptStatus: "ready" | "loading" | "failed";
	blocked?: string;
	/** Strokes on the page (the kept page plus unsent ink). */
	share: number;
}

export function sketchStatus(i: SketchStatusInput): SketchStatus | null {
	if (i.error) return { kind: "error", text: i.error };
	if (i.note) return { kind: "info", text: i.note };
	if (i.nativeFallback) return { kind: "info", text: `Native ink unavailable (${i.nativeFallback}); using the web canvas.` };
	if (i.disabled) return { kind: "info", text: "Compacting the session…" };
	if (i.keptStatus === "loading") return { kind: "info", text: "Loading your earlier page…" };
	if (i.blocked) return { kind: "info", text: i.blocked };
	if (i.keptStatus === "failed") return { kind: "warn", text: "Couldn't load your earlier page; new ink goes alone." };
	if (i.share >= 1) return { kind: "error", text: "This page is full. Submit it or clear some ink." };
	if (i.share >= LIMIT_WARN_SHARE) return { kind: "warn", text: `This page is ${Math.floor(i.share * 100)}% full. Submit soon, or clear some ink.` };
	return null;
}

/** Why Submit does nothing right now, for the press that would otherwise be ignored in silence; null when it would go through. */
export function submitBlockReason(i: { empty: boolean; disabled: boolean; blocked?: string; keptStatus: "ready" | "loading" | "failed" }): string | null {
	if (i.disabled) return "Compacting the session…";
	if (i.blocked) return i.blocked;
	if (i.keptStatus === "loading") return "Loading your earlier page…";
	if (i.empty) return "Draw something first.";
	return null;
}
