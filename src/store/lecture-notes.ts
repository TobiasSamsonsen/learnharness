import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { SketchStroke } from "../core/contracts/sketch.ts";
import type { NoteDigest, NoteTranscript } from "../core/lecture-note-text.ts";
import {
	NOTE_ID_RE,
	SEGMENT_ID_RE,
	type LectureNote,
	type NoteSegment,
	autoTitle,
	newNoteId,
	normalizeNoteTitle,
	parseNoteDate,
	todayDate,
} from "../core/lecture-notes.ts";

/**
 * Lecture notes on disk (fork addition, 2026-11-19) — sole writer of data/lecture-notes:
 *
 *   lecture-notes/<courseId>/<noteId>/note.json        LectureNote (title, date: changes only on rename)
 *   lecture-notes/<courseId>/<noteId>/seg-<segId>.json  { startedAt, endedAt, strokes } in write order
 *   lecture-notes/<courseId>/<noteId>/tr-<segId>.json   NoteTranscript: a segment read to text (synced)
 *   lecture-notes/<courseId>/<noteId>/digest.json       NoteDigest: the lecture's one line (synced)
 *   lecture-notes/<courseId>/<noteId>/thumb.png         derived overview, never synced
 *   lecture-notes/pending.json                          device-local: notes this device wrote ink for and has not read yet
 *
 * Synchronous fs like the other stores. Changes that the course page shows (create, rename, delete) announce
 * courses-changed; a segment save does not (the canvas is open, and the page must not refetch every few seconds).
 */

const SAFE = /^[A-Za-z0-9_-]+$/;

function courseDir(courseId: string): string {
	if (!SAFE.test(courseId)) throw new Error(`invalid course id: ${courseId}`);
	return path.join(/* turbopackIgnore: true */ PATHS.lectureNotes, courseId);
}

function noteDir(courseId: string, noteId: string): string {
	if (!NOTE_ID_RE.test(noteId)) throw new Error(`invalid note id: ${noteId}`);
	return path.join(courseDir(courseId), noteId);
}

const noteFile = (courseId: string, noteId: string) => path.join(noteDir(courseId, noteId), "note.json");
const segFile = (courseId: string, noteId: string, segId: string) => {
	if (!SEGMENT_ID_RE.test(segId)) throw new Error(`invalid segment id: ${segId}`);
	return path.join(noteDir(courseId, noteId), `seg-${segId}.json`);
};
export const thumbFile = (courseId: string, noteId: string) => path.join(noteDir(courseId, noteId), "thumb.png");

function writeNote(note: LectureNote): void {
	fs.mkdirSync(noteDir(note.courseId, note.id), { recursive: true });
	fs.writeFileSync(noteFile(note.courseId, note.id), JSON.stringify(note, null, "\t"), "utf8");
}

export function getNote(courseId: string, noteId: string): LectureNote | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(noteFile(courseId, noteId), "utf8")) as LectureNote;
		return typeof parsed?.id === "string" ? parsed : null;
	} catch {
		return null;
	}
}

/** A course's lectures, newest day first. */
export function listNotes(courseId: string): LectureNote[] {
	let ids: string[];
	try {
		ids = fs.readdirSync(courseDir(courseId)).filter((f) => NOTE_ID_RE.test(f));
	} catch {
		return [];
	}
	return ids
		.map((id) => getNote(courseId, id))
		.filter((n): n is LectureNote => n !== null)
		.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export function createNote(courseId: string, input: { title?: unknown; date?: unknown }): LectureNote {
	const date = parseNoteDate(input.date) ?? todayDate();
	const now = new Date().toISOString();
	// a title the learner typed is theirs for good; a blank field gets the date and, once the notes are read, their topic
	const typed = normalizeNoteTitle(input.title);
	const note: LectureNote = {
		id: newNoteId(),
		courseId,
		title: typed ?? autoTitle(date),
		titleBy: typed ? "learner" : "auto",
		date,
		createdAt: now,
		updatedAt: now,
	};
	writeNote(note);
	emit("courses-changed", {});
	return note;
}

export function updateNote(courseId: string, noteId: string, patch: { title?: unknown; date?: unknown }): LectureNote | null {
	const note = getNote(courseId, noteId);
	if (!note) return null;
	const typed = patch.title === undefined ? undefined : normalizeNoteTitle(patch.title);
	const date = patch.date === undefined ? note.date : parseNoteDate(patch.date);
	if (typed === null || date === null) return null;
	let next: LectureNote = { ...note, date, updatedAt: new Date().toISOString() };
	if (typed !== undefined) next = { ...next, title: typed, titleBy: "learner" };
	else if (note.titleBy === "auto") next = { ...next, title: autoTitle(date, note.topic) }; // redated: the date half follows
	writeNote(next);
	emit("courses-changed", {});
	return next;
}

/** What the notes are about, as read from them: an automatic title takes it (the learner's own title is left alone). */
export function setNoteTopic(courseId: string, noteId: string, topic: string): void {
	const note = getNote(courseId, noteId);
	if (!note || note.topic === topic) return;
	writeNote({ ...note, topic, ...(note.titleBy === "auto" ? { title: autoTitle(note.date, topic) } : {}) });
	emit("courses-changed", {});
}

/** The learner left the note: announce it so the course page refetches the row (thumbnail, order). */
export function touchNote(_courseId: string, _noteId: string): void {
	emit("courses-changed", {});
}

export function deleteNote(courseId: string, noteId: string): boolean {
	if (!getNote(courseId, noteId)) return false;
	fs.rmSync(noteDir(courseId, noteId), { recursive: true, force: true });
	emit("courses-changed", {});
	return true;
}

export function deleteCourseNotes(courseId: string): void {
	fs.rmSync(courseDir(courseId), { recursive: true, force: true });
}

/** The ids of a note's segment files, in write order, without reading them. */
export function readSegmentFiles(courseId: string, noteId: string): { id: string }[] {
	try {
		return fs
			.readdirSync(noteDir(courseId, noteId))
			.filter((f) => /^seg-g[a-z0-9]{6,12}\.json$/.test(f))
			.sort()
			.map((f) => ({ id: f.slice(4, -5) }));
	} catch {
		return [];
	}
}

/** One segment with its strokes (null: none, or unreadable). */
export function readSegment(courseId: string, noteId: string, segId: string): NoteSegment | null {
	try {
		const raw = JSON.parse(fs.readFileSync(segFile(courseId, noteId, segId), "utf8")) as Partial<NoteSegment>;
		return Array.isArray(raw.strokes) ? { id: segId, startedAt: Number(raw.startedAt) || 0, endedAt: Number(raw.endedAt) || 0, strokes: raw.strokes as SketchStroke[] } : null;
	} catch {
		return null;
	}
}

/** Every segment of a note, in write order. */
export function readSegments(courseId: string, noteId: string): NoteSegment[] {
	let files: string[];
	try {
		files = fs.readdirSync(noteDir(courseId, noteId)).filter((f) => /^seg-g[a-z0-9]{6,12}\.json$/.test(f));
	} catch {
		return [];
	}
	const out: NoteSegment[] = [];
	for (const f of files.sort()) {
		const id = f.slice(4, -5);
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(noteDir(courseId, noteId), f), "utf8")) as Partial<NoteSegment>;
			if (Array.isArray(raw.strokes)) {
				out.push({ id, startedAt: Number(raw.startedAt) || 0, endedAt: Number(raw.endedAt) || 0, strokes: raw.strokes as SketchStroke[] });
			}
		} catch {
			// a torn or unreadable segment is skipped, never fatal to the note
		}
	}
	return out;
}

/** Save one segment (empty strokes remove it). Returns false when the note does not exist. */
export function writeSegment(courseId: string, noteId: string, seg: NoteSegment): boolean {
	if (!getNote(courseId, noteId)) return false;
	const file = segFile(courseId, noteId, seg.id);
	// the overview is of the ink as it was: any change to a segment drops it (it is drawn again when the card asks)
	fs.rmSync(thumbFile(courseId, noteId), { force: true });
	if (seg.strokes.length === 0) {
		fs.rmSync(file, { force: true });
		fs.rmSync(trFile(courseId, noteId, seg.id), { force: true });
		return true;
	}
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ startedAt: seg.startedAt, endedAt: seg.endedAt, strokes: seg.strokes }), "utf8");
	fs.renameSync(tmp, file);
	return true;
}

const trFile = (courseId: string, noteId: string, segId: string) => {
	if (!SEGMENT_ID_RE.test(segId)) throw new Error(`invalid segment id: ${segId}`);
	return path.join(noteDir(courseId, noteId), `tr-${segId}.json`);
};

const fingerprints = new Map<string, { mtimeMs: number; size: number; value: string }>();

/**
 * A segment file's fingerprint (its size and a hash of its content), or null when there is no such segment. What a reading records, so a
 * changed segment is told from an unchanged one whatever the change (a move or a recolour can keep the size). The hash is kept per file
 * until its size or modification time changes, so listing notes stays cheap.
 */
export function segmentFingerprint(courseId: string, noteId: string, segId: string): string | null {
	const file = segFile(courseId, noteId, segId);
	try {
		const st = fs.statSync(file);
		const hit = fingerprints.get(file);
		if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
		const value = `${st.size}-${createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 16)}`;
		fingerprints.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
		return value;
	} catch {
		return null;
	}
}

export function readTranscripts(courseId: string, noteId: string): Map<string, NoteTranscript> {
	const out = new Map<string, NoteTranscript>();
	let files: string[];
	try {
		files = fs.readdirSync(noteDir(courseId, noteId)).filter((f) => /^tr-g[a-z0-9]{6,12}\.json$/.test(f));
	} catch {
		return out;
	}
	for (const f of files) {
		try {
			const tr = JSON.parse(fs.readFileSync(path.join(noteDir(courseId, noteId), f), "utf8")) as NoteTranscript;
			if (typeof tr?.text === "string" && typeof tr.fingerprint === "string") out.set(f.slice(3, -5), { ...tr, segId: f.slice(3, -5) });
		} catch {
			// a torn reading is as good as none: the segment reads as unread
		}
	}
	return out;
}

export function writeTranscript(courseId: string, noteId: string, tr: NoteTranscript): void {
	fs.writeFileSync(trFile(courseId, noteId, tr.segId), JSON.stringify(tr), "utf8");
}

export function readDigest(courseId: string, noteId: string): NoteDigest | null {
	try {
		const d = JSON.parse(fs.readFileSync(path.join(noteDir(courseId, noteId), "digest.json"), "utf8")) as NoteDigest;
		return typeof d?.text === "string" && Array.isArray(d.from) ? d : null;
	} catch {
		return null;
	}
}

export function writeDigest(courseId: string, noteId: string, digest: NoteDigest): void {
	fs.writeFileSync(path.join(noteDir(courseId, noteId), "digest.json"), JSON.stringify(digest), "utf8");
}

// ─── device-local: which notes this device wrote ink for (only the writer reads it) ──────────────────────

const pendingFile = () => path.join(/* turbopackIgnore: true */ PATHS.lectureNotes, "pending.json");

function readPending(): string[] {
	try {
		const v = JSON.parse(fs.readFileSync(pendingFile(), "utf8")) as unknown;
		return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
	} catch {
		return [];
	}
}

function writePending(keys: string[]): void {
	fs.mkdirSync(PATHS.lectureNotes, { recursive: true });
	fs.writeFileSync(pendingFile(), JSON.stringify(keys), "utf8");
}

/** This device wrote ink for the note: it, and only it, reads the note's segments to text. */
export function markPending(courseId: string, noteId: string): void {
	const key = `${courseId}/${noteId}`;
	const all = readPending();
	if (!all.includes(key)) writePending([...all, key]);
}

export function clearPending(courseId: string, noteId: string): void {
	const key = `${courseId}/${noteId}`;
	const all = readPending();
	if (all.includes(key)) writePending(all.filter((k) => k !== key));
}

export function pendingNotes(): { courseId: string; noteId: string }[] {
	return readPending().flatMap((k) => {
		const [courseId, noteId] = k.split("/");
		return courseId && noteId && NOTE_ID_RE.test(noteId) ? [{ courseId, noteId }] : [];
	});
}

/** The newest write to a note's ink (ms), or 0. */
export function inkModifiedAt(courseId: string, noteId: string): number {
	let newest = 0;
	try {
		const dir = noteDir(courseId, noteId);
		for (const f of fs.readdirSync(dir)) {
			if (/^seg-g[a-z0-9]{6,12}\.json$/.test(f)) newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs);
		}
	} catch {
		// no folder: no ink
	}
	return newest;
}
