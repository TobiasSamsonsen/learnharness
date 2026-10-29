import { useCallback, useSyncExternalStore } from "react";
import { newSketchId, parseSketchPayload, type SketchPayload, type SketchStroke } from "@/src/core";

/**
 * The practice page's ink (Android plan M1 + M3), keyed by the question's
 * or problem's tool-call id so the dock remounting never drops it.
 *
 * Two layers: the KEPT page (strokes the server already has, drawn dimmed
 * and locked — M3) and the UNSENT ink on top of it. Unsent ink survives
 * closing the view (memory) and a reload (localStorage); a submit from the
 * canvas — or a dock text submit that attaches it — folds it into the kept
 * page once the server accepts it. The kept page itself comes back after a
 * reload from the server (the dock fetches its strokes).
 *
 * History is a list of operations, so undo also restores an erased stroke.
 * Ink restored from a reload has no history: undo then removes the newest
 * stroke.
 */

export type InkOp =
	| { kind: "add"; stroke: SketchStroke }
	| { kind: "erase"; removed: { index: number; stroke: SketchStroke }[] }
	/** Clear: every unsent stroke went at once (undo brings them all back). */
	| { kind: "clear"; removed: SketchStroke[] }
	/** The pixel eraser: each touched stroke (by index in the strokes it was cut from) became these pieces (maybe none). */
	| { kind: "cut"; changes: { index: number; stroke: SketchStroke; pieces: SketchStroke[] }[] };

export interface InkState {
	/** The page being written. Normally just the unsent ink. After a THAW (below) it is the whole page: the
	 *  kept strokes too, each marked `fresh: false` (a local marker; the wire never carries it). */
	strokes: SketchStroke[];
	/** Set once sent ink has been edited (M13c): the id of the kept page its strokes were copied from. */
	thawed?: string;
	/** Done operations, newest last (undo pops from here). */
	undo: InkOp[];
	/** Undone operations, newest last (redo pops from here). */
	redo: InkOp[];
}

export interface KeptPage {
	/** The sketch the strokes came from (the server's newest for this key). */
	id: string;
	strokes: SketchStroke[];
}

const EMPTY_INK: InkState = { strokes: [], undo: [], redo: [] };
const LS_PREFIX = "lh:ink:";

const ink = new Map<string, InkState>();
const kept = new Map<string, KeptPage>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};

/** Editing sent ink (M13c): copy the kept page's strokes into the working page, marked as sent, so the
 *  eraser can cut them like any other. Idempotent. The kept copies go AFTER the unsent strokes, so the
 *  indexes the undo history holds stay right. */
export function thawInk(state: InkState, kept: KeptPage): InkState {
	if (state.thawed !== undefined) return state;
	return { ...state, strokes: [...state.strokes, ...kept.strokes.map((s) => ({ ...s, fresh: false }))], thawed: kept.id };
}

/** Is there anything to send? New or edited ink; after a thaw, an edit that left no stroke (a pure deletion) counts too. */
export function hasNewInk(state: InkState): boolean {
	return state.strokes.some((s) => s.fresh !== false) || (state.thawed !== undefined && state.undo.length > 0);
}

export function inkFromStrokes(strokes: SketchStroke[]): InkState {
	return { strokes, undo: strokes.map((stroke) => ({ kind: "add" as const, stroke })), redo: [] };
}

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function restoreInk(key: string): InkState | null {
	try {
		const raw = storage()?.getItem(LS_PREFIX + key);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			// a thawed page: the whole page plus which strokes are the sent ones
			const { thawed, strokes, sent } = parsed as { thawed?: unknown; strokes?: unknown; sent?: unknown };
			if (typeof thawed !== "string" || !Array.isArray(strokes) || !Array.isArray(sent)) return null;
			const clean = strokes.length === 0 ? [] : parseSketchPayload({ id: newSketchId(), producer: "web-canvas", strokes }).strokes;
			const gone = new Set(sent as unknown[]);
			return { strokes: clean.map((s, i) => (gone.has(i) ? { ...s, fresh: false } : s)), thawed, undo: [], redo: [] };
		}
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		// The same validation a submit gets: a damaged entry restores nothing.
		const payload = parseSketchPayload({ id: newSketchId(), producer: "web-canvas", strokes: parsed });
		return { strokes: payload.strokes, undo: [], redo: [] };
	} catch {
		return null;
	}
}

function persistInk(key: string, state: InkState): void {
	try {
		const ls = storage();
		if (!ls) return;
		if (state.thawed !== undefined) {
			const sent = state.strokes.flatMap((s, i) => (s.fresh === false ? [i] : []));
			ls.setItem(LS_PREFIX + key, JSON.stringify({ thawed: state.thawed, strokes: state.strokes, sent }));
		} else if (state.strokes.length === 0) ls.removeItem(LS_PREFIX + key);
		else ls.setItem(LS_PREFIX + key, JSON.stringify(state.strokes));
	} catch {
		// quota or a blocked store: the in-memory ink still works
	}
}

export function readInk(key: string): InkState {
	const held = ink.get(key);
	if (held) return held;
	const restored = restoreInk(key);
	if (restored) ink.set(key, restored);
	return restored ?? EMPTY_INK;
}

export function writeInk(key: string, state: InkState): void {
	if (state.strokes.length === 0 && state.undo.length === 0 && state.redo.length === 0 && state.thawed === undefined) ink.delete(key);
	else ink.set(key, state);
	persistInk(key, state);
	notify();
}

export function clearInk(key: string): void {
	ink.delete(key);
	persistInk(key, EMPTY_INK);
	notify();
}

export function readKept(key: string): KeptPage | null {
	return kept.get(key) ?? null;
}

export function writeKept(key: string, page: KeptPage | null): void {
	if (page) kept.set(key, page);
	else kept.delete(key);
	notify();
}

export function useInk(key: string): InkState {
	return useSyncExternalStore(subscribe, () => readInk(key), () => EMPTY_INK);
}

export function useKept(key: string): KeptPage | null {
	const get = useCallback(() => readKept(key), [key]);
	return useSyncExternalStore(subscribe, get, () => null);
}

/** The whole page as one payload: the kept strokes, then the unsent ink,
 *  bracketed from where the new ink starts. Throws SketchPayloadError. */
export function pagePayload(
	page: KeptPage | null,
	unsent: readonly SketchStroke[],
	producer: SketchPayload["producer"] = "web-canvas",
	thawed = false,
): SketchPayload {
	if (thawed) {
		// the working strokes ARE the page: the sent ones (marked `fresh: false`) go plain, everything else —
		// new ink and the pieces left of edited ink — is flagged for the margin bracket
		return parseSketchPayload({
			id: newSketchId(),
			producer,
			strokes: unsent.map(({ fresh, ...rest }) => (fresh === false ? rest : { ...rest, fresh: true })),
		});
	}
	const base = page?.strokes ?? [];
	return parseSketchPayload({
		id: newSketchId(),
		producer,
		strokes: [...base, ...unsent],
		newFrom: base.length > 0 ? base.length : undefined,
	});
}

/** The server accepted `payload` (built from the kept page plus `sent`):
 *  the kept page becomes the whole payload, and the unsent ink loses the
 *  strokes that went out (anything drawn since stays). */
export function commitSketch(key: string, payload: SketchPayload, sent: readonly SketchStroke[]): void {
	// parseSketchPayload copies strokes; the kept page holds the payload's.
	writeKept(key, { id: payload.id, strokes: payload.strokes.map(({ fresh: _fresh, ...stroke }) => stroke) });
	const current = readInk(key);
	const gone = new Set(sent);
	const rest = current.strokes.filter((s) => !gone.has(s));
	if (rest.length === current.strokes.length && current.strokes.length > 0) return; // nothing of it was sent
	writeInk(key, rest.length === 0 ? EMPTY_INK : { strokes: rest, undo: [], redo: [] });
}

// A page being sent: the record shows its marker (and ref) before the
// server has answered, so the kept-page loader must not go looking for it.
const inflight = new Map<string, string>();
export const inflightSketch = (key: string): string | undefined => inflight.get(key);

/** Send a page and, once the server accepts it, fold the ink into the
 *  kept page. `send` resolves to whether the server accepted. */
export async function sendPage(
	key: string,
	payload: SketchPayload,
	unsent: readonly SketchStroke[],
	send: () => Promise<boolean | void>,
): Promise<boolean> {
	inflight.set(key, payload.id);
	try {
		const accepted = (await send()) ?? true;
		if (accepted) commitSketch(key, payload, unsent);
		return accepted;
	} finally {
		if (inflight.get(key) === payload.id) inflight.delete(key);
	}
}

/** Apply an operation to the strokes. */
export function applyOp(strokes: SketchStroke[], op: InkOp): SketchStroke[] {
	if (op.kind === "add") return [...strokes, op.stroke];
	if (op.kind === "clear") return strokes.filter((s) => s.fresh === false); // what was sent stays
	if (op.kind === "cut") {
		const pieces = new Map(op.changes.map((c) => [c.index, c.pieces]));
		return strokes.flatMap((s, i) => pieces.get(i) ?? [s]);
	}
	const gone = new Set(op.removed.map((r) => r.stroke));
	return strokes.filter((s) => !gone.has(s));
}

/** Reverse an operation. */
export function revertOp(strokes: SketchStroke[], op: InkOp): SketchStroke[] {
	if (op.kind === "add") return strokes.filter((s) => s !== op.stroke);
	if (op.kind === "clear") return [...strokes, ...op.removed];
	if (op.kind === "cut") {
		// ascending: every change before this one is already back to one stroke, so its index is still right
		const out = [...strokes];
		for (const c of [...op.changes].sort((a, b) => a.index - b.index)) out.splice(c.index, c.pieces.length, c.stroke);
		return out;
	}
	const out = [...strokes];
	for (const { index, stroke } of [...op.removed].sort((a, b) => a.index - b.index)) out.splice(index, 0, stroke);
	return out;
}
