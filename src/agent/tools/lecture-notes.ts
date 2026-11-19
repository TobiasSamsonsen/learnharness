import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { capOutput } from "./fs-shared.ts";
import { pickNote, searchNotes, segmentLabel, type LookupNote } from "../../core/lecture-note-text.ts";

/**
 * The lecture-note lookup tools (owner plan, 2026-11-19): what the learner wrote in the course's lectures, read to text
 * (src/agent/subagents/note-transcriber.ts). Read fresh per call, so a note read after the turn began is found at once.
 *
 *   lecture_note_search  regex/literal search across the course's lecture notes (or one), hits newest lecture first
 *   lecture_note_read    one lecture's text (or one segment of it), and with image: true the handwriting itself
 *
 * They are NOT the source-material tools: a look in the notes does not satisfy the sources gate (core/sources-gate.ts).
 */

export interface LectureNoteSource {
	/** The course's lecture notes with the text of every segment read so far. */
	notes(): LookupNote[];
	/** The rendered handwriting of one segment (a few images at most). */
	images(noteId: string, segId: string): Promise<{ data: string; mimeType: string }[]>;
}

const searchInput = Type.Object({
	query: Type.String({ minLength: 1, description: "What to find: a regex, or a literal string with literal: true" }),
	note: Type.Optional(Type.String({ description: "One lecture: its id, title, date (YYYY-MM-DD) or \"latest\" (default: every lecture)" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat query as a literal string (default: false)" })),
});

const readInput = Type.Object({
	note: Type.String({ description: "The lecture: its id, title, date (YYYY-MM-DD) or \"latest\"" }),
	segment: Type.Optional(Type.Number({ description: "One segment of the lecture, counted from 1 (default: the whole lecture)" })),
	image: Type.Optional(Type.Boolean({ description: "Also show the handwriting itself, for the segment you name: use it where the text says [diagram: …] or [unclear: …]" })),
});

export function lectureNoteTools(source: LectureNoteSource): Record<string, AgentTool<any>> {
	return {
		lecture_note_search: {
			name: "lecture_note_search",
			label: "lecture_note_search",
			description:
				"Search the learner's lecture notes (their own handwriting, read to text): what the lecturer covered and stressed, the examples and notation used, what the learner marked as hard. Returns hits with the lecture and segment, newest lecture first.",
			parameters: searchInput,
			execute: serverExecute("lecture_note_search", searchInput, async ({ query, note, literal }) => {
				const all = source.notes();
				let only: LookupNote | undefined;
				if (note) {
					const picked = pickNote(all, note);
					if (typeof picked === "string") return picked;
					only = picked;
				}
				let pattern: RegExp;
				try {
					pattern = new RegExp(literal ? query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : query, "i");
				} catch (err) {
					return `Invalid regex: ${(err as Error).message}`;
				}
				const hits = searchNotes(all, pattern, only);
				if (hits.length === 0) return `No matches for "${query}" in ${only ? `the lecture ${only.title}` : "the lecture notes"}.`;
				return capOutput(hits.join("\n\n").split("\n")).content;
			}),
		},
		lecture_note_read: {
			name: "lecture_note_read",
			label: "lecture_note_read",
			description:
				"Read one lecture's notes as text (every segment, in the order they were written), or one segment of it (segment: 2). With image: true and a segment, you also SEE the handwriting, for a diagram or a part the text marks [unclear]. The text is the learner's own words, possibly misread: the sources win on exact wording.",
			parameters: readInput,
			execute: serverExecute("lecture_note_read", readInput, async ({ note, segment, image }): Promise<string | ImageFileResult> => {
				const picked = pickNote(source.notes(), note);
				if (typeof picked === "string") return picked;
				const segs = segment === undefined ? picked.segments : picked.segments.filter((s) => s.index === Math.round(segment));
				if (segs.length === 0) return `${picked.date} ${picked.title} has no segment ${segment}: it has ${picked.segments.length}.`;
				const body = segs
					.map((s) => {
						const flag = s.state === "changed" ? " (the ink changed after the learner corrected this text)" : s.state === "unread" ? " (not read to text yet)" : "";
						return `[${segmentLabel(picked, s)}]${flag}\n${s.text || "(nothing read yet)"}`;
					})
					.join("\n\n");
				const text = capOutput(body.split("\n")).content;
				if (!image) return text;
				if (segment === undefined || segs.length !== 1) return `${text}\n\n[image: name one segment to see its handwriting]`;
				const images = (await source.images(picked.id, segs[0]!.id)).slice(0, 2);
				return images.length > 0 ? { text, images } : `${text}\n\n[the handwriting is not available on this device]`;
			}),
		},
	};
}
