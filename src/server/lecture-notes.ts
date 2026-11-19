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
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { lectureNoteTools } from "../agent/tools/lecture-notes.ts";
import { cutDigest, lectureIndexSection, readState, type LookupNote } from "../core/lecture-note-text.ts";
import { noteLabel, segmentStartOf } from "../core/lecture-notes.ts";
import * as notes from "../store/lecture-notes.ts";
import { editSegmentText, noteReadError, noteReadStatus, readLectureNote as readNoteToText, segmentImages } from "./lecture-note-reading.ts";
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
	return notes.listNotes(courseId).map((n) => ({ ...n, inkAt: Math.round(notes.inkModifiedAt(courseId, n.id)), read: noteReadStatus(courseId, n.id) }));
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
	if (!saved) return { ok: false, status: 404, error: "Unknown note" };
	notes.markPending(courseId, noteId); // this device wrote the ink: it reads it to text when the learner leaves
	return { ok: true };
}

const THUMB_W = 480;
const THUMB_H = 360;

/** The overview PNG of a note, rendered once per change of its ink (cached beside it). null: unknown note or no ink. */
export async function lectureNoteThumbnail(courseId: string, noteId: string): Promise<{ png: Uint8Array; etag: string } | null> {
	const note = courseExists(courseId) ? notes.getNote(courseId, noteId) : null;
	if (!note) return null;
	const file = notes.thumbFile(courseId, noteId);
	const inkAt = notes.inkModifiedAt(courseId, noteId);
	if (inkAt === 0) return null;
	try {
		const st = fs.statSync(file);
		if (st.mtimeMs >= inkAt) return { png: new Uint8Array(fs.readFileSync(file)), etag: `"${Math.round(st.mtimeMs)}-${st.size}"` };
	} catch {
		// not rendered yet (a change to the ink removes it)
	}
	const strokes = notes.readSegments(courseId, noteId).flatMap((s) => s.strokes);
	const svg = noteThumbnailSvg(strokes, THUMB_W, THUMB_H);
	if (svg === null) return null;
	const { Resvg } = await import("@resvg/resvg-js");
	const png = new Uint8Array(new Resvg(svg, { fitTo: { mode: "width", value: THUMB_W } }).render().asPng());
	fs.writeFileSync(file, png);
	const st = fs.statSync(file);
	return { png, etag: `"${Math.round(st.mtimeMs)}-${st.size}"` };
}

/** The learner left the note: the course page refetches its row (the thumbnail follows the ink). */
export function leaveLectureNote(courseId: string, noteId: string): boolean {
	if (!courseExists(courseId) || notes.getNote(courseId, noteId) === null) return false;
	notes.touchNote(courseId, noteId);
	// only the device that wrote ink for the note reads it (a synced copy waits for the writer's readings)
	if (notes.pendingNotes().some((p) => p.courseId === courseId && p.noteId === noteId)) void readNoteToText(courseId, noteId);
	return true;
}

export interface TranscriptView {
	segments: { id: string; index: number; startedAt: number; state: "unread" | "read" | "changed"; text: string; digest: string; edited: boolean }[];
	digest: string;
	status: ReturnType<typeof noteReadStatus>;
	error?: string;
}

/** What the tutor has of a note, segment by segment (the learner's Text view). */
export function lectureNoteTranscript(courseId: string, noteId: string): TranscriptView | null {
	if (!courseExists(courseId) || notes.getNote(courseId, noteId) === null) return null;
	const trs = notes.readTranscripts(courseId, noteId);
	const segments = notes.readSegmentFiles(courseId, noteId).map((seg, i) => {
		const tr = trs.get(seg.id);
		return { id: seg.id, index: i + 1, startedAt: segmentStartOf(seg.id), state: readState(tr, notes.segmentFingerprint(courseId, noteId, seg.id)), text: tr?.text ?? "", digest: tr?.digest ?? "", edited: tr?.edited ?? false };
	});
	return { segments, digest: notes.readDigest(courseId, noteId)?.text ?? "", status: noteReadStatus(courseId, noteId), error: noteReadError(courseId, noteId) };
}

/** The learner's correction of one segment's text. false: no such segment. */
export function editLectureNoteSegment(courseId: string, noteId: string, segId: string, text: string): boolean {
	if (!courseExists(courseId) || notes.getNote(courseId, noteId) === null || !SEGMENT_ID_RE.test(segId)) return false;
	return editSegmentText(courseId, noteId, segId, text.slice(0, 100_000));
}

/** Read again: the named segments, or all. Starts in the background. false: no such note. */
export function rereadLectureNote(courseId: string, noteId: string, segIds: string[] | null): boolean {
	if (!courseExists(courseId) || notes.getNote(courseId, noteId) === null) return false;
	void readNoteToText(courseId, noteId, segIds ? new Set(segIds.filter((id) => SEGMENT_ID_RE.test(id))) : "all");
	return true;
}

/** Remove a course's notes (the course is being deleted). */
export function removeCourseLectureNotes(courseId: string): void {
	notes.deleteCourseNotes(courseId);
}

/** The course's lecture notes as the lookup tools see them: every segment with the text read so far. */
function lookupNotes(courseId: string): LookupNote[] {
	return notes.listNotes(courseId).map((n) => {
		const trs = notes.readTranscripts(courseId, n.id);
		return {
			id: n.id,
			title: noteLabel(n),
			date: n.date,
			// ids and fingerprints only: a lookup never parses a lecture's ink
			segments: notes.readSegmentFiles(courseId, n.id).map((seg, i) => {
				const tr = trs.get(seg.id);
				return { index: i + 1, id: seg.id, startedAt: segmentStartOf(seg.id), text: tr?.text ?? "", state: readState(tr, notes.segmentFingerprint(courseId, n.id, seg.id)) };
			}),
		};
	});
}

/**
 * A course session's view of the learner's lecture notes (owner plan, 2026-11-19): the one-line-per-lecture index for the prompt and
 * the two lookup tools; undefined outside a course session or while no lecture has been read to text. Teach, practice and clarify
 * turns all get it through materialsForTurn.
 */
export function lectureNotesForTurn(chatId: string): { section: string; tools: AgentTool<any>[] } | undefined {
	const courseId = stores.chatStore.getChat(chatId)?.course?.courseId;
	if (!courseId || !courseExists(courseId)) return undefined;
	const lectures = notes.listNotes(courseId).map((n) => ({ id: n.id, title: noteLabel(n), date: n.date, digest: cutDigest(notes.readDigest(courseId, n.id)?.text ?? "") }));
	const section = lectureIndexSection(lectures);
	if (!section) return undefined;
	return { section, tools: Object.values(lectureNoteTools({ notes: () => lookupNotes(courseId), images: (noteId, segId) => segmentImages(courseId, noteId, segId) })) };
}
