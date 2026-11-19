import { useCallback, useEffect, useSyncExternalStore } from "react";
import { newSketchId, parseSketchPayload, strokesJson, type SketchPayload, type SketchStroke } from "@/src/core";
import { dropDraft, fetchDraft, flushAllDrafts, inkDraftsEnabled, scheduleDraftPush } from "./ink-drafts.ts";
import { indexedDbInkStore, type InkStore } from "./ink-store.ts";

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
/** The write stamp that rides beside a mirrored page in localStorage (a restore takes the newer of the mirror and IndexedDB). */
const STAMP_PREFIX = "lh:ink-t:";
/** Pages up to this many characters are also written to localStorage, which saves instantly: the last strokes survive the
 *  WebView being killed before an IndexedDB write can finish. Bigger pages live in IndexedDB alone. */
export const MIRROR_MAX_CHARS = 200_000;
const IDB_INK = "ink:";
const IDB_HIST = "hist:";

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
	return parseStrokes(storage()?.getItem(LS_PREFIX + key));
}

function parseStrokes(raw: string | null | undefined): InkState | null {
	try {
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
	return parseHistory(storage()?.getItem(HIST_PREFIX + key), signature);
}

function parseHistory(raw: string | null | undefined, signature: number): Pick<InkState, "undo" | "redo"> | null {
	try {
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

/** Names of the stored keys that start with a prefix (storage has no listing, so walk its indexes). */
function storedKeys(ls: Storage, prefix: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < ls.length; i++) {
		const k = ls.key(i);
		if (k !== null && k.startsWith(prefix)) out.push(k);
	}
	return out;
}

/** One write that survives a full store: when the quota refuses it, the undo history of every OTHER page goes first (it is
 *  rebuilt from nothing worse than "undo removes the newest stroke"), then this page's own, and the write is retried.
 *  Unsent ink of other pages is never touched here. Throws only when the page itself still does not fit. */
function setWithEviction(ls: Storage, name: string, text: string, ownHistory: string): void {
	try {
		ls.setItem(name, text);
		return;
	} catch {
		// fall through to eviction
	}
	for (const k of storedKeys(ls, HIST_PREFIX)) if (k !== ownHistory) ls.removeItem(k);
	try {
		ls.setItem(name, text);
		return;
	} catch {
		// still full
	}
	ls.removeItem(ownHistory);
	ls.setItem(name, text);
}

function persistHistory(ls: Storage, key: string, state: InkState, signature: number): void {
	if (state.undo.length === 0 && state.redo.length === 0) {
		ls.removeItem(HIST_PREFIX + key);
		return;
	}
	const text = JSON.stringify({ sig: signature, undo: state.undo.slice(-HISTORY_OPS), redo: state.redo.slice(-HISTORY_OPS) });
	if (text.length > HISTORY_MAX_CHARS) ls.removeItem(HIST_PREFIX + key);
	else {
		try {
			ls.setItem(HIST_PREFIX + key, text);
		} catch {
			// the history is a convenience: never let it fail the strokes' save
			ls.removeItem(HIST_PREFIX + key);
		}
	}
}

/** Keys whose last write to storage failed (quota): the in-memory ink is fine, but a reload would lose it. */
const saveFailed = new Set<string>();
function setSaveFailed(key: string, failed: boolean): void {
	if (failed === saveFailed.has(key)) return;
	if (failed) saveFailed.add(key);
	else saveFailed.delete(key);
	notify();
}

/** Pages that are not kept in the browser's storage at all (lecture notes, 2026-11-19): a key with a registered prefix hands its
 *  (debounced) state to its own saver instead, which owns durability. */
type InkPersistHandler = (key: string, state: InkState) => void;
const persistHandlers: { prefix: string; fn: InkPersistHandler }[] = [];
export function registerInkPersist(prefix: string, fn: InkPersistHandler): void {
	const i = persistHandlers.findIndex((h) => h.prefix === prefix);
	if (i >= 0) persistHandlers[i] = { prefix, fn };
	else persistHandlers.push({ prefix, fn });
}
const handlerFor = (key: string): InkPersistHandler | undefined => persistHandlers.find((h) => key.startsWith(h.prefix))?.fn;

/** A saver of a handled page (note-ink.ts) reports that its save failed or has recovered: the view says so. */
export function markInkSaveFailed(key: string, failed: boolean): void {
	setSaveFailed(key, failed);
}

function persistInk(key: string, state: InkState): void {
	const handler = handlerFor(key);
	if (handler) {
		handler(key, state);
		return;
	}
	// the server copy goes first and does not depend on the local write: a full store must not stop it
	if (state.thawed !== undefined) {
		// a thawed page is the sent page with edits: the server already holds the sent part, and no draft is kept
	} else if (state.strokes.length === 0) dropDraft(key);
	else scheduleDraftPush(key, strokesJson(state.strokes));
	const be = backing();
	if (be === null) persistLocal(key, state);
	else persistBacked(be, key, state);
}

/** The page's stored text: null when there is nothing to keep (an empty, unthawed page). */
function pageText(state: InkState): string | null {
	if (state.thawed !== undefined) {
		const sent = state.strokes.flatMap((s, i) => (s.fresh === false ? [i] : []));
		return `{"thawed":${JSON.stringify(state.thawed)},"strokes":${strokesJson(state.strokes)},"sent":${JSON.stringify(sent)}}`;
	}
	return state.strokes.length === 0 ? null : strokesJson(state.strokes);
}

function historyText(state: InkState, signature: number): string | null {
	if (state.undo.length === 0 && state.redo.length === 0) return null;
	const text = JSON.stringify({ sig: signature, undo: state.undo.slice(-HISTORY_OPS), redo: state.redo.slice(-HISTORY_OPS) });
	return text.length > HISTORY_MAX_CHARS ? null : text;
}

// One write after another per page, so a slow earlier write never lands on top of a newer one.
const queues = new Map<string, Promise<void>>();
function enqueue(key: string, job: () => Promise<void>): Promise<void> {
	const run = (queues.get(key) ?? Promise.resolve()).then(job).catch(() => {});
	queues.set(key, run);
	return run;
}
/** Resolves when every write started so far has finished (tests, and anything that must not race a write). */
export async function settleInkWrites(): Promise<void> {
	await Promise.all([...queues.values()]);
}
let stampClock = 0;
const lastStamp = new Map<string, number>();
const nextStamp = (key: string): number => {
	stampClock = Math.max(Date.now(), stampClock + 1);
	lastStamp.set(key, stampClock);
	return stampClock;
};

/** The storage is IndexedDB; a small page is also mirrored to localStorage right now (synchronously), so closing or killing the
 *  app straight after a stroke keeps it. The history lives in IndexedDB only: losing it costs nothing worse than undo. */
function persistBacked(be: InkStore, key: string, state: InkState): void {
	const text = pageText(state);
	const t = nextStamp(key);
	const ls = storage();
	let mirrored = false;
	try {
		ls?.removeItem(HIST_PREFIX + key); // an old history copy: it is IndexedDB's now
		if (text === null) {
			ls?.removeItem(LS_PREFIX + key);
			ls?.removeItem(STAMP_PREFIX + key);
			mirrored = true;
		} else if (text.length <= MIRROR_MAX_CHARS && ls) {
			ls.setItem(LS_PREFIX + key, text);
			ls.setItem(STAMP_PREFIX + key, String(t));
			mirrored = true;
		}
	} catch {
		// a full localStorage costs only the mirror
	}
	const hist = text === null ? null : historyText(state, text.length);
	void enqueue(key, async () => {
		try {
			if (text === null) {
				await be.remove([IDB_INK + key, IDB_HIST + key]);
			} else {
				await be.set(IDB_INK + key, { t, text });
				if (hist === null) await be.remove([IDB_HIST + key]).catch(() => {});
				else await be.set(IDB_HIST + key, { t, text: hist }).catch(() => {});
				if (text.length > MIRROR_MAX_CHARS) {
					// the page outgrew its mirror and IndexedDB has it now: the old small copy would only look newer than it is
					try {
						ls?.removeItem(LS_PREFIX + key);
						ls?.removeItem(STAMP_PREFIX + key);
					} catch {
						// nothing to do
					}
				}
			}
			setSaveFailed(key, false);
		} catch {
			// IndexedDB refused; a mirrored page is still safe in localStorage
			setSaveFailed(key, !mirrored);
		}
	});
}

function persistLocal(key: string, state: InkState): void {
	try {
		const ls = storage();
		if (!ls) return;
		if (state.thawed !== undefined) {
		const sent = state.strokes.flatMap((s, i) => (s.fresh === false ? [i] : []));
		const text = `{"thawed":${JSON.stringify(state.thawed)},"strokes":${strokesJson(state.strokes)},"sent":${JSON.stringify(sent)}}`;
		setWithEviction(ls, LS_PREFIX + key, text, HIST_PREFIX + key);
		persistHistory(ls, key, state, text.length);
		} else if (state.strokes.length === 0) {
		ls.removeItem(LS_PREFIX + key);
		ls.removeItem(HIST_PREFIX + key);
		} else {
		const text = strokesJson(state.strokes);
		setWithEviction(ls, LS_PREFIX + key, text, HIST_PREFIX + key);
		persistHistory(ls, key, state, text.length);
		}
		setSaveFailed(key, false);
	} catch {
		// quota or a blocked store: the in-memory ink still works, and the view says so (useInkSaveFailed)
		setSaveFailed(key, true);
	}
}

/** How long after the last change the ink is written to storage. */
export const PERSIST_DELAY_MS = 500;
// Writing stringifies the whole page and its history, so it waits for a pause in drawing instead of running on every
// stroke. The latest state per key is held here; the timer is module-level, so closing the view does not drop it.
const pending = new Map<string, InkState>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePersist(key: string, state: InkState): void {
	pending.set(key, state);
	clearTimeout(persistTimer);
	persistTimer = setTimeout(flushInk, PERSIST_DELAY_MS);
}

/** Write what is waiting now (the page is being hidden or closed, or a test wants the storage current). */
export function flushInk(): void {
	clearTimeout(persistTimer);
	persistTimer = undefined;
	const waiting = [...pending];
	pending.clear();
	for (const [key, state] of waiting) persistInk(key, state);
}

/** The page is being hidden or closed: write the local copy now and send the server copy without waiting for its pause. */
function flushForHide(): void {
	flushInk();
	flushAllDrafts();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	window.addEventListener("pagehide", flushForHide);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flushForHide();
	});
}

export function readInk(key: string): InkState {
	const held = ink.get(key);
	if (held) return held;
	if (backing() !== null) {
		// the page is still being read from IndexedDB: this is "not loaded yet", never "empty" (see afterHydrate)
		if (!hydrated.has(key)) void hydrateInk(key);
		return EMPTY_INK;
	}
	const restored = restoreInk(key);
	if (restored) ink.set(key, restored);
	return restored ?? EMPTY_INK;
}

/** Test seam: the store to use (null: localStorage only, as in a browser without IndexedDB; undefined: choose as the app does). */
export function setInkStore(store: InkStore | null | undefined): void {
	override = store;
	forgetInkMemory();
}
let override: InkStore | null | undefined;
let resolved: InkStore | null | undefined;
function backing(): InkStore | null {
	if (override !== undefined) return override;
	if (resolved === undefined) resolved = typeof window === "undefined" ? null : indexedDbInkStore();
	return resolved;
}

// Hydration: with IndexedDB a page is read asynchronously. Until it has been, readInk says "empty" — but everything that
// branches on emptiness (restoring a server draft, carrying a re-ask's ink over, dropping a redundant copy, drawing) waits
// for it, so a page is never mistaken for empty and written over.
const hydrated = new Set<string>();
const hydrating = new Map<string, Promise<void>>();
let epoch = 0;

/** Is this page's stored ink in memory? Always true when there is no IndexedDB (localStorage reads are synchronous). */
export const isInkReady = (key: string): boolean => backing() === null || hydrated.has(key);

/** Read the page from storage into memory, once. Never rejects. */
export function hydrateInk(key: string): Promise<void> {
	const be = backing();
	if (be === null || hydrated.has(key)) return Promise.resolve();
	let p = hydrating.get(key);
	if (!p) {
		p = loadInk(be, key)
			.catch(() => {})
			.finally(() => {
				if (hydrating.get(key) === p) hydrating.delete(key);
			});
		hydrating.set(key, p);
	}
	return p;
}

/** Run now when the page is in memory, otherwise as soon as it is. */
export function afterHydrate(key: string, fn: () => void): void {
	if (isInkReady(key)) fn();
	else void hydrateInk(key).then(fn);
}

async function loadInk(be: InkStore, key: string): Promise<void> {
	const born = epoch;
	const ls = storage();
	let lsText: string | null = null;
	let lsStamp = 0;
	let lsHist: string | null = null;
	try {
		lsText = ls?.getItem(LS_PREFIX + key) ?? null;
		lsStamp = Number(ls?.getItem(STAMP_PREFIX + key)) || 0;
		lsHist = ls?.getItem(HIST_PREFIX + key) ?? null;
	} catch {
		// a blocked localStorage: IndexedDB alone
	}
	let rec: Awaited<ReturnType<InkStore["get"]>> = null;
	let histRec: Awaited<ReturnType<InkStore["get"]>> = null;
	let idbOk = true;
	try {
		rec = await be.get(IDB_INK + key);
		histRec = await be.get(IDB_HIST + key);
	} catch {
		idbOk = false;
	}
	// a write (or a forget) came first: what is in memory is newer than anything read here
	if (born !== epoch || hydrated.has(key)) return;
	const fromMirror = !!lsText && (!rec || lsStamp > rec.t);
	const text = fromMirror ? lsText : (rec?.text ?? null);
	let state = parseStrokes(text);
	if (state && text) {
		const history = parseHistory(histRec?.text ?? lsHist, text.length);
		if (history) state = { ...state, ...history };
	}
	if (state) ink.set(key, state);
	hydrated.add(key);
	notify();
	if (!idbOk || !text) return;
	// Copy what only localStorage had into IndexedDB (a page from before IndexedDB, or a mirror newer than its record), and let go
	// of the old copy only after the write has completed: a failed copy leaves localStorage exactly as it was.
	void enqueue(key, async () => {
		if (lastStamp.has(key) || born !== epoch) return; // this session has already written the page
		try {
			if (fromMirror) await be.set(IDB_INK + key, { t: Math.max(lsStamp, 1), text });
			if (!histRec && lsHist) await be.set(IDB_HIST + key, { t: Math.max(lsStamp, 1), text: lsHist });
			if (lsHist) ls?.removeItem(HIST_PREFIX + key);
			if (text.length > MIRROR_MAX_CHARS) {
				ls?.removeItem(LS_PREFIX + key);
				ls?.removeItem(STAMP_PREFIX + key);
			}
		} catch {
			// IndexedDB would not take it: localStorage keeps the page
		}
	});
}

export function writeInk(key: string, state: InkState): void {
	// a write before the stored page was read wins over it (the drawing paths wait for hydration, so this is only a fallback)
	if (backing() !== null) hydrated.add(key);
	if (state.strokes.length === 0 && state.undo.length === 0 && state.redo.length === 0 && state.thawed === undefined) ink.delete(key);
	else ink.set(key, state);
	schedulePersist(key, state);
	notify();
}

/** Test seam: a page reload (the memory is gone, localStorage stays). A real reload flushes on pagehide; so does this. */
export function forgetInkMemory(): void {
	flushInk();
	epoch++;
	hydrated.clear();
	hydrating.clear();
	lastStamp.clear();
	restoreTried.clear();
ink.clear();
kept.clear();
}

export function clearInk(key: string): void {
	if (backing() !== null) hydrated.add(key);
	ink.delete(key);
	schedulePersist(key, EMPTY_INK);
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

const restoreTried = new Set<string>();
/** A page opened with no ink of its own asks the server for its draft, once per session: the browser's copy may be gone. */
export function restoreDraft(key: string): void {
	if (restoreTried.has(key) || !inkDraftsEnabled() || handlerFor(key)) return;
	restoreTried.add(key);
	// only a page that is really empty asks the server: after hydration, "empty" is true
	afterHydrate(key, () => {
		if (readInk(key).strokes.length > 0) return;
		void fetchDraft(key).then((text) => {
			if (!text || readInk(key).strokes.length > 0) return;
			try {
				const payload = parseSketchPayload({ id: newSketchId(), producer: "web-canvas", strokes: JSON.parse(text) });
				writeInk(key, { strokes: payload.strokes, undo: [], redo: [] });
				const held = readKept(key);
				if (held) dropRedundantInk(key, held.strokes);
			} catch {
				// a damaged draft restores nothing
			}
		});
	});
}

export function useInk(key: string): InkState {
	useEffect(() => restoreDraft(key), [key]);
	return useSyncExternalStore(subscribe, () => readInk(key), () => EMPTY_INK);
}

/** Did the last write of this page's ink to storage fail (the quota)? A reload would lose it until a write succeeds. */
export const inkSaveFailed = (key: string): boolean => saveFailed.has(key);
export function useInkSaveFailed(key: string): boolean {
	return useSyncExternalStore(subscribe, () => inkSaveFailed(key), () => false);
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

/** A re-ask of the same node: the unsent ink of the earlier call moves to the new call's page, when that page has no ink yet.
 *  Moved, not copied: the old call is answered and its page would only keep taking space. */
export function carryOverInk(from: string, to: string): boolean {
	if (from === to) return false;
	if (!isInkReady(from) || !isInkReady(to)) {
		// both pages must be read before "this page is empty" means anything: do it then
		void Promise.all([hydrateInk(from), hydrateInk(to)]).then(() => void carryOverInk(from, to));
		return false;
	}
	const source = readInk(from);
	if (source.thawed !== undefined || !source.strokes.some((s) => s.fresh !== false) || readInk(to).strokes.length > 0) return false;
	writeInk(to, source);
	writeInk(from, EMPTY_INK);
	return true;
}

/** The page restored from storage is the very page the server holds (a reload came between the server accepting it and the
 *  commit, so the ink was never folded away): the copy is redundant, and left alone it would be sent again on top of itself. */
export function dropRedundantInk(key: string, keptStrokes: readonly SketchStroke[]): boolean {
	if (!isInkReady(key)) {
		afterHydrate(key, () => void dropRedundantInk(key, keptStrokes));
		return false;
	}
	const state = readInk(key);
	if (state.thawed !== undefined || state.strokes.length === 0 || state.strokes.length !== keptStrokes.length) return false;
	const same = state.strokes.every((s, i) => {
		const k = keptStrokes[i]!;
		return s.size === k.size && s.color === k.color && s.points.length === k.points.length && s.points.every((n, j) => n === k.points[j]);
	});
	if (!same) return false;
	writeInk(key, EMPTY_INK);
	return true;
}

/** The server accepted `payload` (built from the kept page plus `sent`):
 *  the kept page becomes the whole payload, and the unsent ink loses the
 *  strokes that went out (anything drawn since stays). */
export function commitSketch(key: string, payload: SketchPayload, sent: readonly SketchStroke[]): void {
	if (!isInkReady(key)) {
		afterHydrate(key, () => commitSketch(key, payload, sent));
		return;
	}
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

/** Send a page and, once the server accepts it, fold the ink into the kept page. `send` resolves to whether the server
 *  accepted, but it may resolve only when the tutor's whole reply has streamed: a reload or a killed server in that time would
 *  leave a sent page in storage for good. So `send` is also handed `accepted`, to call the moment the server has the answer;
 *  the page is committed on the first of the two, once. */
export async function sendPage(
	key: string,
	payload: SketchPayload,
	unsent: readonly SketchStroke[],
	send: (accepted: () => void) => Promise<boolean | void>,
): Promise<boolean> {
	inflight.set(key, payload.id);
	let committed = false;
	const commit = () => {
		if (committed) return;
		committed = true;
		commitSketch(key, payload, unsent);
	};
	try {
		const accepted = (await send(commit)) ?? true;
		if (accepted) commit();
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
