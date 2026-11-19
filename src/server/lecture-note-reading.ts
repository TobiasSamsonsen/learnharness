import { emit } from "../core/events.ts";
import { planSketch } from "../core/sketch.ts";
import type { SketchPayload, SketchStroke } from "../core/contracts/sketch.ts";
import { cutDigest, readState, type NoteDigest, type NoteTranscript } from "../core/lecture-note-text.ts";
import { noteLabel, type NoteReadStatus, type NoteSegment } from "../core/lecture-notes.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { digestLecture, transcribeSegment } from "../agent/subagents/note-transcriber.ts";
import * as notes from "../store/lecture-notes.ts";
import { renderSketchImages } from "./sketches.ts";
import { stores } from "./stores.ts";

/**
 * Reading lecture notes to text (owner plan, 2026-11-19). When the learner LEAVES a note, the device that wrote its ink reads
 * every segment that has no current reading (once each, in write order, each call told how the previous part ended) and then makes
 * the lecture's one-line digest. A device that only received the ink through sync never reads: the writer's readings arrive by sync
 * as well. A reading the learner corrected is kept; an automatic one never overwrites it, even when the ink has changed since.
 * A note left open or an app killed mid-lecture is caught up on the next start (catchUpLectureNotes) and on the next leave.
 */

const key = (courseId: string, noteId: string) => `${courseId}/${noteId}`;
const reading = new Map<string, Promise<void>>();
const lastError = new Map<string, string>();

export const NO_VISION_MODEL = "no vision model is configured (Settings → Agent: the vision slot reads handwriting)";

/** How far a note has been read, for the course page's card. */
export function noteReadStatus(courseId: string, noteId: string): NoteReadStatus {
	const segments = notes.readSegmentFiles(courseId, noteId);
	if (segments.length === 0) return "none";
	if (reading.has(key(courseId, noteId))) return "reading";
	const trs = notes.readTranscripts(courseId, noteId);
	if (segments.every((s) => readState(trs.get(s.id), notes.segmentFingerprint(courseId, noteId, s.id)) !== "unread")) return "read";
	return lastError.has(key(courseId, noteId)) ? "error" : "unread";
}

export function noteReadError(courseId: string, noteId: string): string | undefined {
	return lastError.get(key(courseId, noteId));
}

/** The images of some strokes, split in write order into halves until each fits the render (the 6-tile limit). null: one stroke is too much. */
async function imagesFor(strokes: SketchStroke[]): Promise<{ data: string; mimeType: string }[][] | null> {
	if (strokes.length === 0) return [];
	const payload: SketchPayload = { id: "sk_lecture_read", producer: "web-canvas", strokes };
	try {
		planSketch(payload);
	} catch {
		if (strokes.length < 2) return null;
		const mid = Math.floor(strokes.length / 2);
		const [a, b] = await Promise.all([imagesFor(strokes.slice(0, mid)), imagesFor(strokes.slice(mid))]);
		return a && b ? [...a, ...b] : null;
	}
	return [await renderSketchImages(payload)];
}

/** What one segment looks like, for the model and for `lecture_note_read` with an image: the rendered pages (maybe several parts). */
export async function segmentImages(courseId: string, noteId: string, segId: string): Promise<{ data: string; mimeType: string }[]> {
	const seg = notes.readSegment(courseId, noteId, segId);
	if (!seg) return [];
	return ((await imagesFor(seg.strokes)) ?? []).flat();
}

async function readOneSegment(
	seg: NoteSegment,
	fingerprint: string,
	ctx: { title: string; date: string; previous?: string },
	engine: ReturnType<typeof piEngineForSpec>,
): Promise<NoteTranscript | null> {
	const parts = await imagesFor(seg.strokes);
	if (parts === null || parts.length === 0) return null;
	let text = "";
	const digests: string[] = [];
	let previous = ctx.previous;
	for (const images of parts) {
		const out = await transcribeSegment({ title: ctx.title, date: ctx.date, images, previous }, { engine });
		text += (text ? "\n\n" : "") + out.text;
		if (out.digest) digests.push(out.digest);
		previous = out.text;
	}
	return { segId: seg.id, fingerprint, text, digest: cutDigest(digests.join(" ")), edited: false, at: new Date().toISOString() };
}

async function readNote(courseId: string, noteId: string, force: ReadonlySet<string> | "all" | null): Promise<void> {
	const note = notes.getNote(courseId, noteId);
	if (!note) return;
	const spec = resolveRoleSpec("pdfReader", stores.settingsStore.readSettings());
	const k = key(courseId, noteId);
	if (!spec) {
		lastError.set(k, NO_VISION_MODEL);
		return;
	}
	const engine = piEngineForSpec(spec);
	let trs = notes.readTranscripts(courseId, noteId);
	let previous: string | undefined;
	let changed = false;
	for (const { id } of notes.readSegmentFiles(courseId, noteId)) {
		const fingerprint = notes.segmentFingerprint(courseId, noteId, id);
		const have = trs.get(id);
		const forced = force === "all" || (force !== null && force.has(id));
		if (have && !forced && (readState(have, fingerprint) === "read" || have.edited)) {
			previous = have.text;
			continue;
		}
		// only a segment that needs reading is parsed
		const seg = notes.readSegment(courseId, noteId, id);
		if (!seg || fingerprint === null) continue;
		const tr = await readOneSegment(seg, fingerprint, { title: noteLabel(note), date: note.date, previous }, engine);
		if (!tr) continue;
		notes.writeTranscript(courseId, noteId, tr);
		trs = new Map(trs).set(id, tr);
		previous = tr.text;
		changed = true;
	}
	if (changed || !notes.readDigest(courseId, noteId)) await remakeDigest(courseId, noteId, engine);
}

async function remakeDigest(courseId: string, noteId: string, engine: ReturnType<typeof piEngineForSpec>): Promise<void> {
	const note = notes.getNote(courseId, noteId);
	if (!note) return;
	const trs = notes.readTranscripts(courseId, noteId);
	const ordered = notes.readSegmentFiles(courseId, noteId).flatMap((s) => (trs.has(s.id) ? [trs.get(s.id)!] : []));
	const from = ordered.map((t) => `${t.segId}:${t.at}`);
	const have = notes.readDigest(courseId, noteId);
	if (have && have.from.join("|") === from.join("|")) return;
	const digests = ordered.map((t) => t.digest).filter((d) => d !== "");
	if (digests.length === 0) return;
	// one call always (also for a single part): it gives the lecture's digest and its topic, the second half of an automatic title
	const language = stores.courseStore.getCourse(courseId)?.language === "nb" ? "Norwegian (Bokmål)" : "English";
	const out = await digestLecture({ title: note.title, date: note.date, digests, language }, { engine });
	const digest: NoteDigest = { text: out.digest || cutDigest(digests[0]!), from, at: new Date().toISOString() };
	notes.writeDigest(courseId, noteId, digest);
	if (out.topic) notes.setNoteTopic(courseId, noteId, out.topic);
}

/**
 * Read a note's unread segments now (or, with `force`, those named, or all). One reading per note at a time. Resolves when done; a
 * failure is kept for the card (noteReadError) and the note stays pending for the next start.
 */
export function readLectureNote(courseId: string, noteId: string, force: ReadonlySet<string> | "all" | null = null): Promise<void> {
	const k = key(courseId, noteId);
	const live = reading.get(k);
	if (live) return live;
	lastError.delete(k);
	const run = (async () => {
		try {
			await readNote(courseId, noteId, force);
			if (!lastError.has(k) && noteReadStatus(courseId, noteId) !== "unread") notes.clearPending(courseId, noteId);
		} catch (err) {
			lastError.set(k, err instanceof Error ? err.message : String(err));
		}
	})().finally(() => {
		reading.delete(k);
		emit("courses-changed", {});
	});
	reading.set(k, run);
	emit("courses-changed", {});
	return run;
}

/** On a start: read the notes this device wrote ink for and has not finished reading. */
export function catchUpLectureNotes(): void {
	for (const { courseId, noteId } of notes.pendingNotes()) {
		if (!notes.getNote(courseId, noteId)) {
			notes.clearPending(courseId, noteId);
			continue;
		}
		void readLectureNote(courseId, noteId);
	}
}

/** The learner corrected a segment's text: kept as written, and the lecture's digest is remade. */
export function editSegmentText(courseId: string, noteId: string, segId: string, text: string): boolean {
	const fingerprint = notes.segmentFingerprint(courseId, noteId, segId);
	if (fingerprint === null) return false;
	const have = notes.readTranscripts(courseId, noteId).get(segId);
	notes.writeTranscript(courseId, noteId, { segId, fingerprint, text, digest: have?.digest ?? "", edited: true, at: new Date().toISOString() });
	emit("courses-changed", {});
	return true;
}
