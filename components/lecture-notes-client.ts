import type { LectureNoteListItem } from "@/src/core";

/** The lecture notes of a course, as the course page's row lists them (newest day first). [] on any failure. */
export type LectureNoteItem = Pick<LectureNoteListItem, "id" | "title" | "date" | "inkAt" | "read">;
/** Send `title` only when the learner typed or changed it: the server then keeps it as theirs for good (a blank one is made from the date and the topic read from the notes). */

const base = (courseId: string) => `/api/courses/${encodeURIComponent(courseId)}/lecture-notes`;

export async function fetchLectureNotes(courseId: string): Promise<LectureNoteItem[]> {
	try {
		const res = await fetch(base(courseId), { cache: "no-store" });
		if (!res.ok) return [];
		return ((await res.json()) as { notes?: LectureNoteItem[] }).notes ?? [];
	} catch {
		return [];
	}
}

/** The new note, or null when the server refused (the course is gone). */
export async function createLectureNote(courseId: string, input: { title?: string; date: string }): Promise<LectureNoteItem | null> {
	try {
		const res = await fetch(base(courseId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
		if (!res.ok) return null;
		const note = ((await res.json()) as { note?: LectureNoteItem }).note;
		return note ? { ...note, inkAt: 0, read: "none" } : null;
	} catch {
		return null;
	}
}

export async function updateLectureNote(courseId: string, noteId: string, patch: { title?: string; date?: string }): Promise<boolean> {
	try {
		const res = await fetch(`${base(courseId)}/${encodeURIComponent(noteId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
		return res.ok;
	} catch {
		return false;
	}
}

export async function deleteLectureNote(courseId: string, noteId: string): Promise<boolean> {
	try {
		return (await fetch(`${base(courseId)}/${encodeURIComponent(noteId)}`, { method: "DELETE" })).ok;
	} catch {
		return false;
	}
}

/** The thumbnail of a note's ink; `inkAt` keys the cache (the picture changes only when the ink does). */
export const thumbnailUrl = (courseId: string, noteId: string, inkAt: number) => `${base(courseId)}/${encodeURIComponent(noteId)}/thumbnail?v=${inkAt}`;

/** What the tutor has of a note, segment by segment (GET .../transcript). */
export interface NoteTranscriptView {
	segments: { id: string; index: number; startedAt: number; state: "unread" | "read" | "changed"; text: string; digest: string; edited: boolean }[];
	digest: string;
	status: LectureNoteItem["read"];
	error?: string;
}

export async function fetchTranscript(courseId: string, noteId: string): Promise<NoteTranscriptView | null> {
	try {
		const res = await fetch(`${base(courseId)}/${encodeURIComponent(noteId)}/transcript`, { cache: "no-store" });
		return res.ok ? ((await res.json()) as NoteTranscriptView) : null;
	} catch {
		return null;
	}
}

export async function saveSegmentText(courseId: string, noteId: string, segId: string, text: string): Promise<boolean> {
	try {
		const res = await fetch(`${base(courseId)}/${encodeURIComponent(noteId)}/transcript/${encodeURIComponent(segId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
		return res.ok;
	} catch {
		return false;
	}
}

/** Read again: the named segments, or (null) all of them. */
export async function rereadNote(courseId: string, noteId: string, segments: string[] | null): Promise<boolean> {
	try {
		const res = await fetch(`${base(courseId)}/${encodeURIComponent(noteId)}/transcribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(segments ? { segments } : {}) });
		return res.ok;
	} catch {
		return false;
	}
}
