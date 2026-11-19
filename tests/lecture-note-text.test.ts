/**
 * What the tutor has of a lecture note (owner plan, 2026-11-19): read states, the prompt index, the lookup, the reading call
 * against a scripted model, the two tools, the service's Text view and the course-session wiring. Deterministic: no network,
 * LH_DATA_DIR isolates.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-text-"));
process.env.LH_DATA_DIR = TMP_DATA;

const text = await import("../src/core/lecture-note-text.ts");
const transcriberModule = await import("../src/agent/subagents/note-transcriber.ts");
const { splitTranscript, transcribeSegment, digestLecture, DIGEST_SPLIT } = transcriberModule;
const { lectureNoteTools } = await import("../src/agent/tools/lecture-notes.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const notes = await import("../src/store/lecture-notes.ts");
const svc = await import("../src/server/lecture-notes.ts");
const reading = await import("../src/server/lecture-note-reading.ts");
const { materialsForTurn } = await import("../src/server/materials.ts");
const { syncScope } = await import("../src/core/sync-plan.ts");

import type { NoteTranscript } from "../src/core/lecture-note-text.ts";

const tr = (segId: string, fingerprint: string, over: Partial<NoteTranscript> = {}): NoteTranscript => ({ segId, fingerprint, text: "t", digest: "d", edited: false, at: "2026-11-19T10:00:00Z", ...over });

async function call(tool: { execute: (...a: never[]) => Promise<unknown> }, args: unknown) {
	return (await (tool.execute as (id: string, a: unknown) => Promise<{ content: { type: string; text?: string }[] }>)("c1", args)).content;
}
const textOf = (c: { type: string; text?: string }[]) => c.map((x) => x.text ?? "").join("");

describe("read state and the index", () => {
	it("a reading is current while the ink has the fingerprint it had; a corrected one is kept when the ink changes", () => {
		assert.equal(text.readState(undefined, "a"), "unread");
		assert.equal(text.readState(tr("g1", "a"), "a"), "read");
		assert.equal(text.readState(tr("g1", "a"), "b"), "unread");
		assert.equal(text.readState(tr("g1", "a"), null), "unread", "no such segment");
		assert.equal(text.readState(tr("g1", "a", { edited: true }), "b"), "changed");
		assert.equal(text.readState(tr("g1", "a", { edited: true }), "a"), "read");
	});

	it("the index is empty until a lecture has a digest, lists newest first, and folds the oldest past 40", () => {
		assert.equal(text.lectureIndexSection([{ id: "ln_a", title: "A", date: "2026-11-01", digest: "" }]), "");
		const one = text.lectureIndexSection([
			{ id: "ln_a", title: "Limits", date: "2026-11-10", digest: "epsilon-delta; exam: yes" },
			{ id: "ln_b", title: "Series", date: "2026-11-12", digest: "Taylor; hard: remainder" },
		]);
		assert.match(one, /^## The learner's lecture notes\n/);
		assert.match(one, /sources win/);
		assert.ok(one.indexOf("12 Nov · Series") < one.indexOf("10 Nov · Limits"));
		const many = Array.from({ length: 43 }, (_, i) => ({ id: `ln_${i}`, title: `L${i}`, date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`, digest: "x" }));
		const out = text.lectureIndexSection(many);
		assert.equal(out.split("\n").filter((l) => l.startsWith("- ")).length, 41, "40 in full plus one folded line");
		assert.match(out, /\+3 earlier lectures \(.* to .*\), searchable/);
	});

	it("a digest is cut at 200 characters on a word edge of the whole line", () => {
		assert.equal(text.cutDigest("  one   two \n three "), "one two three");
		const cut = text.cutDigest("word ".repeat(100));
		assert.ok(cut.length <= text.LECTURE_DIGEST_CHARS);
		assert.ok(cut.endsWith("…"));
	});
});

describe("looking up a note", () => {
	const mk = (id: string, title: string, date: string, texts: string[]): import("../src/core/lecture-note-text.ts").LookupNote => ({
		id,
		title,
		date,
		segments: texts.map((t, i) => ({ index: i + 1, id: `g${i}aaaaaa`, startedAt: 1_700_000_000_000, text: t, state: t ? ("read" as const) : ("unread" as const) })),
	});
	const all = [mk("ln_1", "Limits", "2026-11-10", ["epsilon-delta\nlim x->0 [marked: exam]", ""]), mk("ln_2", "Series", "2026-11-12", ["Taylor $f(x)$\nwhy remainder?"])];

	it("names a note by id, exact title, date, latest or a unique part of the title; refuses an ambiguous or unknown one", () => {
		const id = (r: string) => (text.pickNote(all, r) as { id: string }).id;
		assert.equal(id("ln_1"), "ln_1");
		assert.equal(id("series"), "ln_2");
		assert.equal(id("2026-11-10"), "ln_1");
		assert.equal(id("latest"), "ln_2");
		assert.equal(id("lim"), "ln_1");
		assert.match(text.pickNote(all, "zzz") as string, /No lecture note "zzz"/);
		const plus = [...all, mk("ln_3", "Limits II", "2026-11-14", ["x"])];
		assert.equal((text.pickNote(plus, "limits") as { id: string }).id, "ln_1", "an exact title wins over a longer one");
		assert.match(text.pickNote(plus, "limit") as string, /matches several lectures/);
		assert.match(text.pickNote([], "x") as string, /no lecture notes yet/);
	});

	it("searches line by line with context, newest lecture first, skipping what is not read", () => {
		const hits = text.searchNotes(all, /\bwhy\b|exam/i);
		assert.equal(hits.length, 2);
		assert.match(hits[0]!, /^\[2026-11-12 Series · segment 1 of 1.*line 2\]\n {4}Taylor \$f\(x\)\$\n>>> why remainder\?/);
		assert.match(hits[1]!, /2026-11-10 Limits · segment 1 of 2/);
		assert.equal(text.searchNotes(all, /zymurgy/).length, 0);
		assert.equal(text.searchNotes(all, /x/, all[0]).length, 1, "one lecture only");
	});
});

describe("reading a segment (scripted model)", () => {
	function engine(steps: FauxResponseStep[]) {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}
	const say = (t: string) => () => fauxAssistantMessage(t);

	it("splits the lecture reply into a topic and a digest, cleaning the topic", () => {
		const { splitLectureReply } = transcriberModule;
		assert.deepEqual(splitLectureReply('TITLE: "Taylor Polynomials."\nDIGEST: Taylor; exam hint'), { topic: "Taylor Polynomials", digest: "Taylor; exam hint" });
		assert.deepEqual(splitLectureReply("just a digest line"), { topic: null, digest: "just a digest line" });
		assert.deepEqual(splitLectureReply("TITLE: Limits"), { topic: "Limits", digest: "" });
	});

	it("splits the reply at the digest line, and a reply without one still gives the text", () => {
		assert.deepEqual(splitTranscript(`line 1\n${DIGEST_SPLIT}\nlimits, exam hint`), { text: "line 1", digest: "limits, exam hint" });
		assert.deepEqual(splitTranscript("just text"), { text: "just text", digest: "" });
	});

	it("reads a segment to text and a digest, then makes the lecture's line from the parts", async () => {
		const seg = await transcribeSegment({ title: "Limits", date: "2026-11-10", images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }], previous: "the lim" }, { engine: engine([say(`$\\lim x$ [marked: exam]\n${DIGEST_SPLIT}\nlimits; exam`)]) });
		assert.equal(seg.text, "$\\lim x$ [marked: exam]");
		assert.equal(seg.digest, "limits; exam");
		assert.deepEqual(await digestLecture({ title: "Limits", date: "2026-11-10", digests: ["limits; exam", "series; hard: remainder"], language: "English" }, { engine: engine([say("TITLE: Limits and Series\nDIGEST: Limits then series; exam hint; remainder is hard")]) }), { topic: "Limits and Series", digest: "Limits then series; exam hint; remainder is hard" });
		assert.deepEqual(await digestLecture({ title: "x", date: "2026-11-10", digests: [""], language: "English" }, { engine: engine([]) }), { topic: null, digest: "" });
	});
});

describe("the tools", () => {
	const lookup: import("../src/core/lecture-note-text.ts").LookupNote[] = [
		{ id: "ln_1", title: "Limits", date: "2026-11-10", segments: [
			{ index: 1, id: "g1aaaaaa", startedAt: 0, text: "epsilon-delta", state: "read" },
			{ index: 2, id: "g2aaaaaa", startedAt: 0, text: "[diagram: a graph]", state: "changed" },
		] },
	];
	const asked: string[] = [];
	const tools = lectureNoteTools({ notes: () => lookup, images: async (n, s) => (asked.push(`${n}/${s}`), [{ data: "AAAA", mimeType: "image/png" }]) });

	it("search and read return the text; read with image shows the handwriting of one named segment", async () => {
		assert.match(textOf(await call(tools.lecture_note_search!, { query: "epsilon", literal: true })), /Limits · segment 1 of 2.*line 1/s);
		assert.match(textOf(await call(tools.lecture_note_search!, { query: "zymurgy" })), /No matches/);
		assert.match(textOf(await call(tools.lecture_note_search!, { query: "(" })), /Invalid regex/);
		const whole = textOf(await call(tools.lecture_note_read!, { note: "latest" }));
		assert.match(whole, /segment 1 of 2[\s\S]*epsilon-delta[\s\S]*segment 2 of 2\]\s*\(the ink changed after the learner corrected this text\)/);
		assert.match(textOf(await call(tools.lecture_note_read!, { note: "Limits", segment: 9 })), /has no segment 9: it has 2/);
		assert.match(textOf(await call(tools.lecture_note_read!, { note: "Limits", image: true })), /name one segment/);
		const withImage = await call(tools.lecture_note_read!, { note: "Limits", segment: 2, image: true });
		assert.ok(withImage.some((c) => c.type === "image"), "the model is shown the handwriting");
		assert.deepEqual(asked, ["ln_1/g2aaaaaa"]);
	});
});

describe("the service and the course session", () => {
	const course = courseStore.createCourse("Matte 1");
	const stroke = (x: number) => ({ size: 4, points: [x, 0, 0.5, x + 10, 10, 0.5] });
	const body = (n: number) => JSON.stringify({ startedAt: 1000, endedAt: 2000, strokes: Array.from({ length: n }, (_, i) => stroke(i * 20)) });

	it("saving ink marks the note as written here; reading with no vision model is said plainly and the note stays pending", async () => {
		const n = svc.createLectureNote(course.id, { title: "Limits", date: "2026-11-10" })!;
		svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body(3));
		assert.ok(notes.pendingNotes().some((p) => p.noteId === n.id));
		assert.equal(svc.listLectureNotes(course.id)![0]!.read, "unread");
		await reading.readLectureNote(course.id, n.id);
		assert.equal(svc.lectureNoteTranscript(course.id, n.id)!.status, "error");
		assert.equal(svc.lectureNoteTranscript(course.id, n.id)!.error, reading.NO_VISION_MODEL);
		assert.ok(notes.pendingNotes().some((p) => p.noteId === n.id), "retried on the next start");
	});

	it("a note that only arrived by sync is never read here: leaving it starts nothing", async () => {
		const n = svc.createLectureNote(course.id, { title: "Synced", date: "2026-11-11" })!;
		fs.writeFileSync(path.join(TMP_DATA, "lecture-notes", course.id, n.id, "seg-g1aaaaaaa.json"), body(2));
		assert.equal(notes.pendingNotes().some((p) => p.noteId === n.id), false);
		assert.equal(svc.leaveLectureNote(course.id, n.id), true);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(svc.lectureNoteTranscript(course.id, n.id)!.error, undefined, "no reading was tried");
	});

	it("a correction is kept as written; a later change of the ink marks it instead of replacing it", () => {
		const n = svc.createLectureNote(course.id, { title: "Series", date: "2026-11-12" })!;
		svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body(2));
		assert.equal(svc.editLectureNoteSegment(course.id, n.id, "g1aaaaaaa", "Taylor $f(x)$ corrected"), true);
		let view = svc.lectureNoteTranscript(course.id, n.id)!;
		assert.deepEqual(view.segments.map((s) => [s.state, s.edited, s.text]), [["read", true, "Taylor $f(x)$ corrected"]]);
		svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body(5)); // the learner moved or added ink
		view = svc.lectureNoteTranscript(course.id, n.id)!;
		assert.equal(view.segments[0]!.state, "changed");
		assert.equal(view.segments[0]!.text, "Taylor $f(x)$ corrected");
		assert.equal(svc.editLectureNoteSegment(course.id, n.id, "gnosuchseg", "x"), false);
		svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", JSON.stringify({ startedAt: 1, endedAt: 2, strokes: [] }));
		assert.equal(notes.readTranscripts(course.id, n.id).size, 0, "emptying a segment removes its reading too");
	});

	it("a course session's prompt gets the index and the tools once a lecture is read; a lesson outside a course gets nothing", () => {
		const n = svc.createLectureNote(course.id, { title: "Taylor", date: "2026-11-13" })!;
		svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body(2));
		const fingerprint = notes.segmentFingerprint(course.id, n.id, "g1aaaaaaa")!;
		notes.writeTranscript(course.id, n.id, tr("g1aaaaaaa", fingerprint, { text: "Taylor $f$ [marked: exam]", digest: "Taylor; exam" }));
		notes.writeDigest(course.id, n.id, { text: "Taylor series; exam hint", from: ["g1aaaaaaa:t"], at: "t" });
		const chat = chatStore.createChat("Practice", "practice", { courseId: course.id, mode: "practice", skillIds: [] });
		const turn = materialsForTurn(chat.id)!;
		assert.match(turn.section, /13 Nov · Taylor: Taylor series; exam hint/);
		assert.deepEqual(turn.tools.map((t) => t.name).sort(), ["lecture_note_read", "lecture_note_search"]);
		assert.equal(materialsForTurn(chatStore.createChat("Plain").id), undefined);
	});

	it("a recolour or a move that keeps the file's size still changes the fingerprint, and the reading is marked", () => {
		const n = svc.createLectureNote(course.id, { title: "Same size", date: "2026-11-14" })!;
		const stroke = (color: string, x: number) => ({ size: 4, color, points: [x, 0, 0.5, x + 10, 10, 0.5] });
		const save = (s: unknown) => svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", JSON.stringify({ startedAt: 1, endedAt: 2, strokes: [s] }));
		save(stroke("#dc2626", 10));
		const before = notes.segmentFingerprint(course.id, n.id, "g1aaaaaaa")!;
		save(stroke("#2563eb", 10)); // another colour, the same number of characters
		const after = notes.segmentFingerprint(course.id, n.id, "g1aaaaaaa")!;
		assert.equal(before.split("-")[0], after.split("-")[0], "the file is exactly as large");
		assert.notEqual(before, after);
		assert.equal(notes.segmentFingerprint(course.id, n.id, "g1aaaaaaa"), after, "stable while the file is untouched (served from the cache)");
		assert.equal(notes.segmentFingerprint(course.id, n.id, "g9nosuchsg"), null);
	});

	it("looking a note up never parses its ink, and changing the ink drops its thumbnail", async () => {
		const n = svc.createLectureNote(course.id, { title: "Heavy", date: "2026-11-15" })!;
		svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body(3));
		notes.writeTranscript(course.id, n.id, tr("g1aaaaaaa", notes.segmentFingerprint(course.id, n.id, "g1aaaaaaa")!, { text: "epsilon", digest: "d" }));
		notes.writeDigest(course.id, n.id, { text: "heavy lecture", from: ["g1aaaaaaa:t"], at: "t" });
		// a segment file that could not be parsed at all is still listed, with its reading: only ids and fingerprints are used
		fs.writeFileSync(path.join(TMP_DATA, "lecture-notes", course.id, n.id, "seg-g2aaaaaaa.json"), "{ not json");
		const chat = chatStore.createChat("Practice", "practice", { courseId: course.id, mode: "practice", skillIds: [] });
		const turn = materialsForTurn(chat.id)!;
		const search = turn.tools.find((t) => t.name === "lecture_note_search")!;
		const out = (await (search.execute as (id: string, a: unknown) => Promise<{ content: { text: string }[] }>)("c1", { query: "epsilon", note: n.id })).content[0]!.text;
		assert.match(out, /Heavy · segment 1 of 2/);
		// the overview: made once, and gone when the ink changes
		assert.ok((await svc.lectureNoteThumbnail(course.id, n.id)) !== null);
		assert.ok(fs.existsSync(notes.thumbFile(course.id, n.id)));
		svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body(4));
		assert.equal(fs.existsSync(notes.thumbFile(course.id, n.id)), false);
	});

	it("readings and the digest travel with the note; the device-local list does not", () => {
		assert.equal(syncScope("lecture-notes/course_1/ln_abc123def456/tr-g1abc2def.json"), "include");
		assert.equal(syncScope("lecture-notes/course_1/ln_abc123def456/digest.json"), "include");
		assert.equal(syncScope("lecture-notes/pending.json"), "exclude");
	});
});
