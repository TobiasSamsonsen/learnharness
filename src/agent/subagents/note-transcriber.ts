import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { completeOnce, type MaterialProfilerOptions } from "./material-profiler.ts";
import { cutDigest } from "../../core/lecture-note-text.ts";

/**
 * The lecture-note reader (owner plan, 2026-11-19): turns one SEGMENT of a learner's handwritten lecture notes (its rendered
 * image, or a few) into text, with a one-line digest, so the tutor can search and read the notes. And makes the lecture's own
 * one-line digest from its segments' digests. Same engine and slot as the source profiler (the vision slot). One model call each,
 * no tools.
 */

export const DIGEST_SPLIT = "=== DIGEST ===";

const SEGMENT_INSTRUCTIONS = `You read a learner's handwritten notes from one lecture and turn them into text for their tutor. You get the notes as one or more images of the same part of an infinite canvas, in reading order.

Transcribe everything exactly as written, in reading order: words in the language the learner wrote them, formulas as LaTeX between $ signs. Do not correct, complete or explain anything; copy mistakes as written.
- Where there is a diagram, graph or sketch, write [diagram: …] with one or two sentences saying what it shows and any labels on it.
- Where handwriting cannot be read with confidence, write [unclear: your best guess?].
- Where the learner marked something (underlined, starred, boxed, "!!", "exam", an arrow to it), put [marked: …] right after that text.
- Keep what shows the learner did not understand something ("?", "why?", "hard", "not sure") exactly where it stands.

Then write a line containing exactly ${DIGEST_SPLIT} and, after it, ONE line of at most 200 characters saying what this part of the lecture is about: the topics, anything marked as important or as relevant to the exam, anything the learner found hard.`;

const LECTURE_INSTRUCTIONS = `You summarise one lecture, from the one-line digests of its parts, for a tutor's index. Write ONE line of at most 200 characters: the lecture's topics in order, then anything marked as important or exam-relevant, then anything the learner found hard. No preamble, no quotation marks.`;

export interface SegmentInput {
	title: string;
	date: string;
	images: { data: string; mimeType: string }[];
	/** The end of the segment before this one, for a formula that is cut at the boundary. */
	previous?: string;
}

/** Split a reply at the digest line. A reply without one gets an empty digest (the text is still good). Pure. */
export function splitTranscript(reply: string): { text: string; digest: string } {
	const at = reply.indexOf(DIGEST_SPLIT);
	if (at < 0) return { text: reply.trim(), digest: "" };
	return { text: reply.slice(0, at).trim(), digest: cutDigest(reply.slice(at + DIGEST_SPLIT.length)) };
}

/** Read one segment. Throws when the model cannot be reached or answers nothing. */
export async function transcribeSegment(input: SegmentInput, opts: MaterialProfilerOptions): Promise<{ text: string; digest: string }> {
	const content: (TextContent | ImageContent)[] = [
		{
			type: "text",
			text: `Lecture: ${input.title} (${input.date}).${input.previous ? `\nThe part before this one ended with:\n${input.previous.slice(-600)}\n(Use it only to read a cut-off formula; do not repeat it.)` : ""}`,
		},
		...input.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
	];
	return splitTranscript(await completeOnce(opts, SEGMENT_INSTRUCTIONS, content));
}

/** The lecture's one-line digest from its segments' digests (in order). */
export async function digestLecture(input: { title: string; date: string; digests: string[] }, opts: MaterialProfilerOptions): Promise<string> {
	const lines = input.digests.filter((d) => d !== "").map((d, i) => `${i + 1}. ${d}`).join("\n");
	if (lines === "") return "";
	return cutDigest(await completeOnce(opts, LECTURE_INSTRUCTIONS, [{ type: "text", text: `Lecture: ${input.title} (${input.date}).\nParts:\n${lines}` }]));
}
