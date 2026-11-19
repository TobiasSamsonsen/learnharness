import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { SketchStroke } from "../core/contracts/sketch.ts";
import {
	NOTE_ID_RE,
	SEGMENT_ID_RE,
	type LectureNote,
	type NoteSegment,
	defaultNoteTitle,
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
 *   lecture-notes/<courseId>/<noteId>/thumb.png         derived overview, never synced
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
	const note: LectureNote = {
		id: newNoteId(),
		courseId,
		title: normalizeNoteTitle(input.title) ?? defaultNoteTitle(date),
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
	const title = patch.title === undefined ? note.title : normalizeNoteTitle(patch.title);
	const date = patch.date === undefined ? note.date : parseNoteDate(patch.date);
	if (title === null || date === null) return null;
	const next: LectureNote = { ...note, title, date, updatedAt: new Date().toISOString() };
	writeNote(next);
	emit("courses-changed", {});
	return next;
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
	if (seg.strokes.length === 0) {
		fs.rmSync(file, { force: true });
		return true;
	}
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ startedAt: seg.startedAt, endedAt: seg.endedAt, strokes: seg.strokes }), "utf8");
	fs.renameSync(tmp, file);
	return true;
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
