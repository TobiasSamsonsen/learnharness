import type { SketchStroke } from "@/src/core";

/**
 * Unsent ink (owner, M1 2026-10-26): closing the sketch view keeps the
 * drawing for its question or problem — reopening shows it again, and a
 * submit from the canvas clears it. In memory only: a reload loses it
 * until the kept page (M3) adds localStorage. Keyed by the question's or
 * problem's tool-call id, so the dock remounting never drops it.
 */

export interface InkState {
	strokes: SketchStroke[];
	/** Undone strokes, newest last (redo pops from here). */
	redo: SketchStroke[];
}

const memory = new Map<string, InkState>();

export function readInk(key: string): InkState {
	return memory.get(key) ?? { strokes: [], redo: [] };
}

export function writeInk(key: string, state: InkState): void {
	if (state.strokes.length === 0 && state.redo.length === 0) memory.delete(key);
	else memory.set(key, state);
}

export function clearInk(key: string): void {
	memory.delete(key);
}
