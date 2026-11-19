import type { LectureNoteListItem } from "@/src/core";

/** The lecture notes of a course, as the course page's row lists them (newest day first). [] on any failure. */
export type LectureNoteItem = Pick<LectureNoteListItem, "id" | "title" | "date" | "inkAt">;

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
export async function createLectureNote(courseId: string, input: { title: string; date: string }): Promise<LectureNoteItem | null> {
	try {
		const res = await fetch(base(courseId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
		if (!res.ok) return null;
		const note = ((await res.json()) as { note?: LectureNoteItem }).note;
		return note ? { ...note, inkAt: 0 } : null;
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
