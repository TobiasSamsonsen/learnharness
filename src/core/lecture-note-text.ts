/**
 * What the tutor knows of a lecture note (owner plan, 2026-11-19): each segment of a note's ink is transcribed once to text
 * (src/agent/subagents/note-transcriber.ts), and the tutor reads that text through two lookup tools and a one-line-per-lecture
 * index in its prompt. This module holds the shapes and the pure rules: the read state of a segment, the index, the search.
 */

/** One segment's reading. `bytes` is the size of the segment's ink file when it was read: the cheap test that the ink has not changed since. */
export interface NoteTranscript {
	segId: string;
	bytes: number;
	/** The learner's writing as text: math in LaTeX between $, `[diagram: …]` and `[unclear: …]` where the writing could not be read as text. */
	text: string;
	/** One line of what the segment is about (topics, emphasis, what the learner marked as hard). */
	digest: string;
	/** The learner corrected the text by hand: an automatic reading never overwrites it. */
	edited: boolean;
	at: string;
}

/** unread: no reading of the ink as it is now. read: the text matches the ink. changed: the learner's corrected text is kept but the ink changed since. */
export type SegmentReadState = "unread" | "read" | "changed";

export function readState(tr: NoteTranscript | undefined, bytes: number): SegmentReadState {
	if (!tr) return "unread";
	if (tr.bytes === bytes) return "read";
	return tr.edited ? "changed" : "unread";
}

/** The note's one-line digest, made from its segments' digests once they are read. */
export interface NoteDigest {
	text: string;
	/** The segments it was made from (ids), so a changed reading remakes it. */
	from: string[];
	at: string;
}

export const LECTURE_DIGEST_CHARS = 200;
/** The index lists this many lectures in full (newest first); older ones are folded into one searchable line. */
export const LECTURE_INDEX_FULL = 40;

export interface IndexedLecture {
	id: string;
	title: string;
	/** YYYY-MM-DD */
	date: string;
	/** The note's digest, already cut to LECTURE_DIGEST_CHARS; "" when it has not been read yet. */
	digest: string;
}

export function cutDigest(text: string): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length <= LECTURE_DIGEST_CHARS ? t : `${t.slice(0, LECTURE_DIGEST_CHARS - 1).trimEnd()}…`;
}

/** The rules the tutor gets with the index (wording to be confirmed by the owner). */
export const LECTURE_NOTES_RULES = [
	"These are the learner's own handwritten notes from this course's lectures, read to text. They show what the lecturer actually covered and stressed, the examples and notation used, and what the learner marked as hard. They are the learner's words and can be incomplete or misread: when the sources give the exact wording, a definition or a statement, the sources win.",
	"Use them to fit your teaching to the course as it was really given (its order, its emphasis, its notation), and to pick up what the learner wrote that they did not understand. Look in them with lecture_note_search and lecture_note_read before you say what the lecturer covered; never claim a lecture said something the notes do not show.",
].join("\n");

const SHORT_DATE = (iso: string) => {
	const d = new Date(`${iso}T00:00:00Z`);
	return Number.isNaN(d.getTime()) ? iso : `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
};

/** The prompt section: one line per lecture, newest first, the older ones folded. "" when no lecture has been read. */
export function lectureIndexSection(lectures: readonly IndexedLecture[]): string {
	const read = lectures.filter((l) => l.digest !== "");
	if (read.length === 0) return "";
	const sorted = [...read].sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
	const shown = sorted.slice(0, LECTURE_INDEX_FULL);
	const folded = sorted.slice(LECTURE_INDEX_FULL);
	const lines = shown.map((l) => `- ${SHORT_DATE(l.date)} · ${l.title}: ${l.digest}`);
	if (folded.length > 0) {
		const oldest = folded[folded.length - 1]!.date;
		lines.push(`- +${folded.length} earlier lecture${folded.length === 1 ? "" : "s"} (${SHORT_DATE(oldest)} to ${SHORT_DATE(folded[0]!.date)}), searchable`);
	}
	return `## The learner's lecture notes\n${LECTURE_NOTES_RULES}\n\n${lines.join("\n")}`;
}

// ─── lookup ─────────────────────────────────────────────────────────────────

export interface LookupSegment {
	index: number;
	id: string;
	startedAt: number;
	endedAt: number;
	text: string;
	state: SegmentReadState;
}
export interface LookupNote {
	id: string;
	title: string;
	date: string;
	segments: LookupSegment[];
}

/** A note named by id, title (exact, then a unique prefix or substring, case-insensitive), a date, or "latest"; or a message saying why not. */
export function pickNote(notes: readonly LookupNote[], ref: string): LookupNote | string {
	if (notes.length === 0) return "This course has no lecture notes yet.";
	const r = ref.trim().toLowerCase();
	if (r === "latest") return [...notes].sort((a, b) => b.date.localeCompare(a.date))[0]!;
	const exact = notes.filter((n) => n.id === ref.trim() || n.title.toLowerCase() === r || n.date === r);
	if (exact.length === 1) return exact[0]!;
	const loose = exact.length > 1 ? exact : notes.filter((n) => n.title.toLowerCase().includes(r));
	if (loose.length === 1) return loose[0]!;
	const names = notes.map((n) => `${n.id} (${n.date} ${n.title})`).join(", ");
	return loose.length > 1 ? `"${ref}" matches several lectures — name one: ${names}` : `No lecture note "${ref}" — the course's: ${names}`;
}

export function segmentLabel(note: LookupNote, seg: LookupSegment): string {
	const t = (ms: number) => (ms > 0 ? new Date(ms).toISOString().slice(11, 16) : "");
	const when = seg.startedAt > 0 ? `, written ${t(seg.startedAt)}–${t(seg.endedAt)} UTC` : "";
	return `${note.date} ${note.title} · segment ${seg.index} of ${note.segments.length}${when}`;
}

export const LOOKUP_MAX_HITS = 40;

/** Search every read segment's text, line by line (two lines of context): hits newest lecture first. Pure. */
export function searchNotes(notes: readonly LookupNote[], pattern: RegExp, only?: LookupNote): string[] {
	const hits: string[] = [];
	const pool = (only ? [only] : [...notes]).sort((a, b) => b.date.localeCompare(a.date));
	for (const note of pool) {
		for (const seg of note.segments) {
			if (seg.state === "unread" && seg.text === "") continue;
			const lines = seg.text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				if (hits.length >= LOOKUP_MAX_HITS) return hits;
				if (!pattern.test(lines[i]!)) continue;
				const from = Math.max(0, i - 2);
				const context = lines.slice(from, i + 3).map((l, j) => `${from + j === i ? ">>>" : "   "} ${l}`).join("\n");
				hits.push(`[${segmentLabel(note, seg)}, line ${i + 1}]\n${context}`);
			}
		}
	}
	return hits;
}
