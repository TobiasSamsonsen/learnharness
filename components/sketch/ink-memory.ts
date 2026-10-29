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
 * The last HISTORY_OPS operations of each stack ride along in localStorage (M16b), so undo works after a reload too; a
 * history that no longer matches the restored strokes, is damaged, or is too big is dropped, and undo then removes the
 * newest stroke.
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
const HIST_PREFIX = "lh:ink-hist:";
/** Operations kept per stack across a reload, and the most characters the history may take in storage. */
export const HISTORY_OPS = 30;
const HISTORY_MAX_CHARS = 1_000_000;

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

function restoreStrokes(key: string): InkState | null {
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

function validStroke(s: unknown): boolean {
	const v = s as { size?: unknown; points?: unknown } | null;
	return typeof v === "object" && v !== null && typeof v.size === "number" && Array.isArray(v.points) && v.points.length % 3 === 0 && v.points.every((n) => typeof n === "number");
}

/** A stored operation of a known shape (the history is only trusted when every operation is). */
export function validOp(op: unknown): op is InkOp {
	const v = op as Record<string, unknown> | null;
	if (typeof v !== "object" || v === null) return false;
	const strokes = (xs: unknown) => Array.isArray(xs) && xs.every(validStroke);
	switch (v.kind) {
		case "add":
			return validStroke(v.stroke);
		case "erase":
			return Array.isArray(v.removed) && v.removed.every((r: { index?: unknown; stroke?: unknown }) => typeof r?.index === "number" && validStroke(r.stroke));
		case "clear":
			return strokes(v.removed);
		case "cut":
			return Array.isArray(v.changes) && v.changes.every((c: { index?: unknown; stroke?: unknown; pieces?: unknown }) => typeof c?.index === "number" && validStroke(c.stroke) && strokes(c.pieces));
		default:
			return false;
	}
}

/** The stored history for these strokes, or null when there is none, it is damaged, or it belongs to other strokes. */
function restoreHistory(key: string, signature: number): Pick<InkState, "undo" | "redo"> | null {
	try {
		const raw = storage()?.getItem(HIST_PREFIX + key);
		if (!raw) return null;
		const v = JSON.parse(raw) as { sig?: unknown; undo?: unknown; redo?: unknown } | null;
		if (!v || v.sig !== signature || !Array.isArray(v.undo) || !Array.isArray(v.redo)) return null;
		if (!v.undo.every(validOp) || !v.redo.every(validOp)) return null;
		return { undo: v.undo as InkOp[], redo: v.redo as InkOp[] };
	} catch {
		return null;
	}
}

function restoreInk(key: string): InkState | null {
	const state = restoreStrokes(key);
	if (!state) return null;
	const raw = storage()?.getItem(LS_PREFIX + key);
	const history = raw ? restoreHistory(key, raw.length) : null;
	return history ? { ...state, ...history } : state;
}

function persistHistory(ls: Storage, key: string, state: InkState, signature: number): void {
	if (state.undo.length === 0 && state.redo.length === 0) {
		ls.removeItem(HIST_PREFIX + key);
		return;
	}
	const text = JSON.stringify({ sig: signature, undo: state.undo.slice(-HISTORY_OPS), redo: state.redo.slice(-HISTORY_OPS) });
	if (text.length > HISTORY_MAX_CHARS) ls.removeItem(HIST_PREFIX + key);
	else ls.setItem(HIST_PREFIX + key, text);
}

function persistInk(key: string, state: InkState): void {
	try {
		const ls = storage();
		if (!ls) return;
		if (state.thawed !== undefined) {
		const sent = state.strokes.flatMap((s, i) => (s.fresh === false ? [i] : []));
		const text = JSON.stringify({ thawed: state.thawed, strokes: state.strokes, sent });
		ls.setItem(LS_PREFIX + key, text);
		persistHistory(ls, key, state, text.length);
		} else if (state.strokes.length === 0) {
		ls.removeItem(LS_PREFIX + key);
		ls.removeItem(HIST_PREFIX + key);
		} else {
		const text = JSON.stringify(state.strokes);
		ls.setItem(LS_PREFIX + key, text);
		persistHistory(ls, key, state, text.length);
		}
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

/** Test seam: a page reload (the memory is gone, localStorage stays). */
export function forgetInkMemory(): void {
ink.clear();
kept.clear();
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
