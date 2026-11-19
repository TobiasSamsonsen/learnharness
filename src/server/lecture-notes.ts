import * as fs from "node:fs";
import { parseSketchStroke, SketchPayloadError } from "../core/sketch.ts";
import type { SketchStroke } from "../core/contracts/sketch.ts";
import {
	SEGMENT_ID_RE,
	SEGMENT_MAX_CHARS,
	noteThumbnailSvg,
	type LectureNote,
	type LectureNoteListItem,
} from "../core/lecture-notes.ts";
export type { LectureNoteListItem };
import * as notes from "../store/lecture-notes.ts";
import { stores } from "./stores.ts";

/**
 * Lecture notes service (fork addition, 2026-11-19): validation and orchestration over the store. Ink is validated
 * for SHAPE and SIZE only: a lecture's ink may be far larger than one answer sketch, and render limits belong to the
 * transcription split, never to a save (a refused save would lose writing).
 */

export type NoteInput = { title?: unknown; date?: unknown };

const courseExists = (courseId: string) => stores.courseStore.getCourse(courseId) !== null;


export function listLectureNotes(courseId: string): LectureNoteListItem[] | null {
	if (!courseExists(courseId)) return null;
	return notes.listNotes(courseId).map((n) => ({ ...n, inkAt: Math.round(notes.inkModifiedAt(courseId, n.id)) }));
}

export function createLectureNote(courseId: string, input: NoteInput): LectureNote | null {
	if (!courseExists(courseId)) return null;
	return notes.createNote(courseId, input);
}

export function updateLectureNote(courseId: string, noteId: string, patch: NoteInput): LectureNote | null {
	return courseExists(courseId) ? notes.updateNote(courseId, noteId, patch) : null;
}

export function deleteLectureNote(courseId: string, noteId: string): boolean {
	return courseExists(courseId) && notes.deleteNote(courseId, noteId);
}

/** A note with all its ink, flat and in write order (each stroke carries its segment). */
export function readLectureNote(
	courseId: string,
	noteId: string,
): { note: LectureNote; strokes: SketchStroke[]; segments: { id: string; startedAt: number; endedAt: number }[] } | null {
	const note = courseExists(courseId) ? notes.getNote(courseId, noteId) : null;
	if (!note) return null;
	const segments = notes.readSegments(courseId, noteId);
	const strokes: SketchStroke[] = [];
	for (const seg of segments) for (const s of seg.strokes) strokes.push({ ...s, seg: seg.id });
	return { note, strokes, segments: segments.map(({ id, startedAt, endedAt }) => ({ id, startedAt, endedAt })) };
}

export type SaveResult = { ok: true } | { ok: false; status: 400 | 404 | 413; error: string };

/** Save one segment from a request body's text. Empty strokes remove the segment. */
export function saveLectureNoteSegment(courseId: string, noteId: string, segId: string, bodyText: string): SaveResult {
	if (!courseExists(courseId) || notes.getNote(courseId, noteId) === null) return { ok: false, status: 404, error: "Unknown note" };
	if (!SEGMENT_ID_RE.test(segId)) return { ok: false, status: 400, error: "Invalid segment id" };
	if (bodyText.length > SEGMENT_MAX_CHARS) return { ok: false, status: 413, error: "Segment is too large" };
	let body: { startedAt?: unknown; endedAt?: unknown; strokes?: unknown };
	try {
		body = JSON.parse(bodyText);
	} catch {
		return { ok: false, status: 400, error: "Body is not JSON" };
	}
	if (typeof body !== "object" || body === null || !Array.isArray(body.strokes)) return { ok: false, status: 400, error: "strokes must be an array" };
	if (typeof body.startedAt !== "number" || typeof body.endedAt !== "number") return { ok: false, status: 400, error: "startedAt and endedAt must be numbers" };
	let strokes: SketchStroke[];
	try {
		strokes = body.strokes.map((raw, i) => {
			const s = parseSketchStroke(raw, i);
			return { ...s, seg: segId };
		});
	} catch (e) {
		if (e instanceof SketchPayloadError) return { ok: false, status: 400, error: e.message };
		throw e;
	}
	const saved = notes.writeSegment(courseId, noteId, { id: segId, startedAt: body.startedAt, endedAt: body.endedAt, strokes });
	return saved ? { ok: true } : { ok: false, status: 404, error: "Unknown note" };
}

const THUMB_W = 480;
const THUMB_H = 360;

/** The overview PNG of a note, rendered once per change of its ink (cached beside it). null: unknown note or no ink. */
export async function lectureNoteThumbnail(courseId: string, noteId: string): Promise<Uint8Array | null> {
	const note = courseExists(courseId) ? notes.getNote(courseId, noteId) : null;
	if (!note) return null;
	const file = notes.thumbFile(courseId, noteId);
	const inkAt = notes.inkModifiedAt(courseId, noteId);
	if (inkAt === 0) return null;
	try {
		if (fs.statSync(file).mtimeMs >= inkAt) return new Uint8Array(fs.readFileSync(file));
	} catch {
		// not rendered yet
	}
	const strokes = notes.readSegments(courseId, noteId).flatMap((s) => s.strokes);
	const svg = noteThumbnailSvg(strokes, THUMB_W, THUMB_H);
	if (svg === null) return null;
	const { Resvg } = await import("@resvg/resvg-js");
	const png = new Uint8Array(new Resvg(svg, { fitTo: { mode: "width", value: THUMB_W } }).render().asPng());
	fs.writeFileSync(file, png);
	return png;
}

/** The learner left the note: the course page refetches its row (the thumbnail follows the ink). */
export function leaveLectureNote(courseId: string, noteId: string): boolean {
	if (!courseExists(courseId) || notes.getNote(courseId, noteId) === null) return false;
	notes.touchNote(courseId, noteId);
	return true;
}

/** Remove a course's notes (the course is being deleted). */
export function removeCourseLectureNotes(courseId: string): void {
	notes.deleteCourseNotes(courseId);
}

