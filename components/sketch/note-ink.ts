import {
	groupBySegment,
	newStrokeId,
	openSegmentOf,
	placeStroke,
	strokeBox,
	type LectureNote,
	type OpenSegment,
	type SketchStroke,
} from "@/src/core";
import { afterHydrate, flushInk, markInkSaveFailed, registerInkPersist, writeInk, type InkState } from "./ink-memory.ts";
import { indexedDbInkStore, type InkStore } from "./ink-store.ts";

/**
 * A lecture note's ink on the client (owner plan, 2026-11-19): one infinite canvas whose strokes are cut into SEGMENTS in
 * write order. The canvas keeps the whole note as one flat stroke list (ink-memory, under the note's id); this module stamps
 * every new stroke with its id and segment, and saves ONLY the segments that changed to the device's own server, a few seconds
 * after the last change. Until the server confirms a segment, a copy of it is kept in IndexedDB (and read back on the next
 * open), so a killed server or WebView loses nothing. Nothing of a note goes to localStorage or to the unsent-ink drafts.
 */

export const NOTE_SAVE_DELAY_MS = 3000;
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 60_000;
export const NOTE_KEY_PREFIX = "ln_";
const IDB_DIRTY = "lndirty:";

interface SegTimes {
	startedAt: number;
	endedAt: number;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
interface Env {
	fetch: Fetch;
	store: InkStore | null;
	now: () => number;
	saveDelayMs: number;
}
let env: Env = {
	fetch: (i, init) => fetch(i, init),
	store: typeof window === "undefined" ? null : indexedDbInkStore(),
	now: () => Date.now(),
	saveDelayMs: NOTE_SAVE_DELAY_MS,
};
/** Test seam. */
export function configureNoteInk(next: Partial<Env>): void {
	env = { ...env, ...next };
	sessions.clear();
}

const sessions = new Map<string, NoteSession>();

const sameStrokes = (a: readonly SketchStroke[], b: readonly SketchStroke[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

export class NoteSession {
	private open: OpenSegment | null = null;
	/** What the server holds, per segment (the arrays that were last saved or loaded). */
	private saved = new Map<string, readonly SketchStroke[]>();
	private latest = new Map<string, SketchStroke[]>();
	private times = new Map<string, SegTimes>();
	private dirty = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private inflight: Promise<void> | null = null;
	private retryMs = RETRY_MIN_MS;
	private failed = false;
	private loaded = false;
	/** Left (or never going to be used): a load still in flight must not register itself or write the canvas. */
	private disposed = false;

	constructor(
		readonly courseId: string,
		readonly noteId: string,
	) {}

	private url(suffix = ""): string {
		return `/api/courses/${encodeURIComponent(this.courseId)}/lecture-notes/${encodeURIComponent(this.noteId)}${suffix}`;
	}

	/** Read the note (and any unconfirmed copy this device kept), and hand its ink to the canvas. */
	async load(): Promise<LectureNote> {
		const res = await env.fetch(this.url());
		if (!res.ok) throw new Error(res.status === 404 ? "This lecture note no longer exists." : "Could not load the lecture note.");
		const body = (await res.json()) as { note: LectureNote; strokes: SketchStroke[]; segments: { id: string; startedAt: number; endedAt: number }[] };
		for (const g of body.segments) this.times.set(g.id, { startedAt: g.startedAt, endedAt: g.endedAt });
		const fromServer = groupBySegment(body.strokes);
		for (const [id, list] of fromServer) this.saved.set(id, list);
		const groups = new Map(fromServer);
		// what an earlier session wrote locally but the server never confirmed wins over the server's older copy
		for (const [id, copy] of await this.readLocalCopies()) {
			groups.set(id, copy.strokes);
			this.times.set(id, { startedAt: copy.startedAt, endedAt: copy.endedAt });
		}
		const strokes = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([, list]) => list);
		let last = 0;
		for (const t of this.times.values()) last = Math.max(last, t.endedAt);
		if (this.disposed) return body.note;
		this.open = openSegmentOf(strokes, last);
		this.latest = new Map(groups);
		this.loaded = true;
		registerInkPersist(NOTE_KEY_PREFIX, (key, state) => sessions.get(key)?.onState(state));
		sessions.set(this.noteId, this);
		afterHydrate(this.noteId, () => writeInk(this.noteId, { strokes, undo: [], redo: [] }));
		return body.note;
	}

	/** A new stroke arrives from the pen: it gets its id and the segment it belongs to, in place (the canvas holds this very object). */
	stamp = (stroke: SketchStroke): void => {
		const now = env.now();
		const { segment } = placeStroke(this.open, strokeBox(stroke.points), now);
		this.open = segment;
		stroke.id = newStrokeId();
		stroke.seg = segment.id;
		const t = this.times.get(segment.id);
		this.times.set(segment.id, { startedAt: t?.startedAt ?? segment.startedAt, endedAt: now });
	};

	/** The canvas's (debounced) ink: work out which segments changed and schedule their save. */
	onState(state: InkState): void {
		if (!this.loaded) return;
		const groups = groupBySegment(state.strokes);
		for (const [id, list] of groups) {
			const prev = this.saved.get(id);
			if (!prev || !sameStrokes(prev, list)) this.dirty.add(id);
		}
		for (const id of this.saved.keys()) if (!groups.has(id)) this.dirty.add(id);
		this.latest = groups;
		if (this.dirty.size === 0) return;
		void this.writeLocalCopies();
		this.schedule(env.saveDelayMs);
	}

	private schedule(ms: number): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), ms);
	}

	/** Save every changed segment now. Resolves when the server has them all, or when a save failed (it retries by itself). */
	flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		const run = (this.inflight ?? Promise.resolve()).then(() => this.saveDirty());
		this.inflight = run.catch(() => {});
		return this.inflight;
	}

	private async saveDirty(): Promise<void> {
		for (const id of [...this.dirty].sort()) {
			const list = this.latest.get(id) ?? [];
			const t = this.times.get(id) ?? { startedAt: env.now(), endedAt: env.now() };
			try {
				const res = await env.fetch(this.url(`/segments/${encodeURIComponent(id)}`), {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ startedAt: t.startedAt, endedAt: t.endedAt, strokes: list }),
				});
				if (!res.ok) throw new Error(String(res.status));
			} catch {
				this.setFailed(true);
				this.schedule(this.retryMs);
				this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
				return;
			}
			if (list.length === 0) this.saved.delete(id);
			else this.saved.set(id, list);
			// changed again while the request was out: it stays dirty
			if (sameStrokes(this.latest.get(id) ?? [], list)) this.dirty.delete(id);
			else this.schedule(env.saveDelayMs);
		}
		this.retryMs = RETRY_MIN_MS;
		this.setFailed(false);
		await this.writeLocalCopies();
	}

	private setFailed(failed: boolean): void {
		this.failed = failed;
		markInkSaveFailed(this.noteId, failed); // idempotent: the flag is per note id, shared by every session of it
	}

	private async readLocalCopies(): Promise<Map<string, { startedAt: number; endedAt: number; strokes: SketchStroke[] }>> {
		const out = new Map<string, { startedAt: number; endedAt: number; strokes: SketchStroke[] }>();
		try {
			const rec = await env.store?.get(IDB_DIRTY + this.noteId);
			if (!rec) return out;
			const parsed = JSON.parse(rec.text) as Record<string, { startedAt?: unknown; endedAt?: unknown; strokes?: unknown }>;
			for (const [id, v] of Object.entries(parsed)) {
				if (Array.isArray(v?.strokes)) out.set(id, { startedAt: Number(v.startedAt) || 0, endedAt: Number(v.endedAt) || 0, strokes: v.strokes as SketchStroke[] });
			}
		} catch {
			// an unreadable copy restores nothing
		}
		return out;
	}

	/** The device copy: the changed segments only, removed once the server has them. */
	private async writeLocalCopies(): Promise<void> {
		const be = env.store;
		if (!be) return;
		try {
			if (this.dirty.size === 0) {
				await be.remove([IDB_DIRTY + this.noteId]);
				return;
			}
			const copy: Record<string, SegTimes & { strokes: SketchStroke[] }> = {};
			for (const id of this.dirty) {
				const t = this.times.get(id) ?? { startedAt: env.now(), endedAt: env.now() };
				copy[id] = { ...t, strokes: this.latest.get(id) ?? [] };
			}
			await be.set(IDB_DIRTY + this.noteId, { t: env.now(), text: JSON.stringify(copy) });
		} catch {
			// IndexedDB refused: the server save is still on its way
		}
	}

	/** The learner leaves the note: everything is saved now and the course page is told. */
	async leave(): Promise<void> {
		const wasLoaded = this.loaded;
		this.disposed = true;
		if (!wasLoaded) return;
		flushInk();
		await this.flush();
		try {
			await env.fetch(this.url("/leave"), { method: "POST" });
		} catch {
			// the row refreshes on its next fetch
		}
		if (sessions.get(this.noteId) === this) sessions.delete(this.noteId);
	}

	get unsaved(): boolean {
		return this.dirty.size > 0;
	}
}

/** The session of a note (one per open note). */
export function noteSession(courseId: string, noteId: string): NoteSession {
	return new NoteSession(courseId, noteId);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	const hide = () => {
		for (const s of sessions.values()) void s.flush();
	};
	window.addEventListener("pagehide", hide);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") hide();
	});
}
