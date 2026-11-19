/**
 * Lecture notes (fork addition, 2026-11-19 — docs/courses.md "Lecture notes"): a learner's handwriting from a lecture,
 * an infinite canvas per lecture, kept inside a course. The ink is cut into SEGMENTS in write order (each stroke
 * carries the id of the segment it was drawn into), so a long lecture is saved, synced and (later) transcribed in small
 * pieces. This module holds the shapes and the pure rules; the store is src/store/lecture-notes.ts.
 */

import type { SketchStroke } from "./contracts/sketch.ts";

/** One lecture: title and date only. The ink lives in its segment files, so this record changes on rename and redate. */
export interface LectureNote {
	/** "ln_…": also the ink key of the canvas. */
	id: string;
	courseId: string;
	title: string;
	/** The lecture's day, "YYYY-MM-DD" (defaults to today, editable). */
	date: string;
	createdAt: string;
	updatedAt: string;
}

/** Has the tutor's text of a lecture been made? none: no ink yet. unread: some ink is not read yet. reading: it is being read now. read: all of it. error: the last reading failed. */
export type NoteReadStatus = "none" | "unread" | "reading" | "read" | "error";

/** A lecture as the course page lists it: `inkAt` is when its ink last changed (ms, 0: no ink yet), the key of its thumbnail. */
export type LectureNoteListItem = LectureNote & { inkAt: number; read: NoteReadStatus };

/** One segment of a lecture's ink: consecutive strokes in write order. */
export interface NoteSegment {
	/** "g…": time-based, so segments sort in write order. */
	id: string;
	/** Epoch ms of the segment's first and last stroke. */
	startedAt: number;
	endedAt: number;
	strokes: SketchStroke[];
}

/** A note with its ink, as the canvas loads it: every stroke in write order, each carrying its `seg`. */
export interface LectureNoteInk {
	note: LectureNote;
	strokes: SketchStroke[];
}

export const NOTE_ID_RE = /^ln_[A-Za-z0-9]{6,32}$/;
export const SEGMENT_ID_RE = /^g[a-z0-9]{6,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const NOTE_TITLE_MAX = 120;
/** A segment file may not be larger than this (JSON characters). Shape and size only: render limits are for transcription. */
export const SEGMENT_MAX_CHARS = 2_000_000;

export function newNoteId(): string {
	return `ln_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function newSegmentId(now = Date.now()): string {
	return `g${now.toString(36)}`;
}

/** When a segment began (epoch ms): its id is the draw time of its first stroke. */
export function segmentStartOf(segId: string): number {
	const n = Number.parseInt(segId.slice(1), 36);
	return Number.isFinite(n) ? n : 0;
}

/** A calendar date as YYYY-MM-DD, or null when it is not a real day. */
export function parseNoteDate(value: unknown): string | null {
	if (typeof value !== "string" || !DATE_RE.test(value)) return null;
	const d = new Date(`${value}T00:00:00Z`);
	return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

export function todayDate(now = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function normalizeNoteTitle(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const t = value.replace(/\s+/g, " ").trim().slice(0, NOTE_TITLE_MAX);
	return t.length > 0 ? t : null;
}

/** The default title for a lecture note dated `date` ("Lecture 12 Mar"). */
export function defaultNoteTitle(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	return `Lecture ${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

// ─── segments ────────────────────────────────────────────────────────────────

/** A segment closes when its ink passes this box (world px, about one 2000 px image tile), has this many strokes, or
 *  the writer pauses this long (owner, 2026-11-19; tune on the Tab). */
export const SEGMENT_MAX_EXTENT = 1600;
export const SEGMENT_MAX_STROKES = 400;
export const SEGMENT_PAUSE_MS = 3 * 60_000;

export interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export function strokeBox(points: readonly number[]): Box {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (let k = 0; k + 1 < points.length; k += 3) {
		const x = points[k]!, y = points[k + 1]!;
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
	}
	return { x0, y0, x1, y1 };
}

/** The segment strokes are being drawn into. */
export interface OpenSegment {
	id: string;
	startedAt: number;
	endedAt: number;
	count: number;
	box: Box;
}

function union(a: Box, b: Box): Box {
	return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * Where does the next stroke go? Returns the open segment with the stroke added: the same one while it has room,
 * else a fresh one (`opened` is true). Membership is fixed here, at draw time, by the stroke's own id: a later pixel cut,
 * move or erase never shifts a boundary.
 */
export function placeStroke(open: OpenSegment | null, box: Box, now: number): { segment: OpenSegment; opened: boolean } {
	if (open !== null) {
		const grown = union(open.box, box);
		const fits =
			open.count < SEGMENT_MAX_STROKES &&
			now - open.endedAt <= SEGMENT_PAUSE_MS &&
			grown.x1 - grown.x0 <= SEGMENT_MAX_EXTENT &&
			grown.y1 - grown.y0 <= SEGMENT_MAX_EXTENT;
		if (fits) return { segment: { ...open, endedAt: now, count: open.count + 1, box: grown }, opened: false };
	}
	// a new segment's id is the draw time; keep it unique even when two open in the same millisecond
	const id = newSegmentId(open !== null && newSegmentId(now) <= open.id ? Number.parseInt(open.id.slice(1), 36) + 1 : now);
	return { segment: { id, startedAt: now, endedAt: now, count: 1, box }, opened: true };
}

/** The open segment to carry on with after a note is loaded: its newest segment, so a lecture resumed within the pause goes on in it. */
export function openSegmentOf(strokes: readonly SketchStroke[], endedAt: number): OpenSegment | null {
	let last: string | undefined;
	for (const s of strokes) if (s.seg !== undefined && (last === undefined || s.seg > last)) last = s.seg;
	if (last === undefined) return null;
	let count = 0;
	let box: Box | null = null;
	for (const s of strokes) {
		if (s.seg !== last) continue;
		count++;
		const b = strokeBox(s.points);
		box = box === null ? b : union(box, b);
	}
	return box === null ? null : { id: last, startedAt: Number.parseInt(last.slice(1), 36), endedAt, count, box };
}

/** Split a flat stroke list into its segments, in segment order. Strokes without a `seg` are dropped (a note has none). */
export function groupBySegment(strokes: readonly SketchStroke[]): Map<string, SketchStroke[]> {
	const out = new Map<string, SketchStroke[]>();
	for (const s of strokes) {
		if (s.seg === undefined) continue;
		const list = out.get(s.seg);
		if (list) list.push(s);
		else out.set(s.seg, [s]);
	}
	return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ─── thumbnail ───────────────────────────────────────────────────────────────

const INK = "#1c1917";

/**
 * A fit-all overview of a note's ink as an SVG of `width` x `height` px on white: every stroke as a plain polyline
 * (the outline renderer is far too heavy for thousands of strokes), at least one pixel thick so small writing still shows.
 * `null` when there is no ink.
 */
export function noteThumbnailSvg(strokes: readonly SketchStroke[], width: number, height: number): string | null {
	let box: Box | null = null;
	for (const s of strokes) {
		const b = strokeBox(s.points);
		box = box === null ? b : union(box, b);
	}
	if (box === null) return null;
	const pad = 12;
	const bw = Math.max(1, box.x1 - box.x0), bh = Math.max(1, box.y1 - box.y0);
	const scale = Math.min((width - 2 * pad) / bw, (height - 2 * pad) / bh);
	const ox = (width - bw * scale) / 2 - box.x0 * scale;
	const oy = (height - bh * scale) / 2 - box.y0 * scale;
	const r1 = (n: number) => Math.round(n * 10) / 10;
	const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>`];
	for (const s of strokes) {
		const pts: string[] = [];
		for (let k = 0; k + 1 < s.points.length; k += 3) pts.push(`${r1(s.points[k]! * scale + ox)},${r1(s.points[k + 1]! * scale + oy)}`);
		const w = Math.max(1, r1(s.size * scale));
		out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color ?? INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`);
	}
	out.push("</svg>");
	return out.join("");
}
