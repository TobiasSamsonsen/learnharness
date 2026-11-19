/**
 * Lecture notes (owner plan, 2026-11-19): the segment rules, the stroke ids, the store and service over a temp data dir, the
 * sync scope, the thumbnail, and the client session (stamping, changed-segment saves, the device copy). Deterministic: no
 * network (a scripted fetch), LH_DATA_DIR isolates.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-notes-"));
process.env.LH_DATA_DIR = TMP_DATA;

const core = await import("../src/core/lecture-notes.ts");
const sketch = await import("../src/core/sketch.ts");
const { syncScope } = await import("../src/core/sync-plan.ts");
const { courseStore } = await import("../src/store/courses.ts");
const svc = await import("../src/server/lecture-notes.ts");
const courses = await import("../src/server/courses.ts");
const { PATHS } = await import("../config.ts");
const { subscribe } = await import("../src/core/events.ts");
const noteInk = await import("../components/sketch/note-ink.ts");
const inkMemory = await import("../components/sketch/ink-memory.ts");
const { memoryInkStore } = await import("../components/sketch/ink-store.ts");

import type { SketchStroke } from "../src/core/contracts/sketch.ts";

const stroke = (x: number, y: number, extra: Partial<SketchStroke> = {}): SketchStroke => ({ size: 4, points: [x, y, 0.5, x + 10, y + 10, 0.5], ...extra });

describe("segment rules", () => {
	const box = (x: number, y: number) => core.strokeBox(stroke(x, y).points);

	it("the first stroke opens a segment; later strokes join it while it has room", () => {
		const a = core.placeStroke(null, box(0, 0), 1000);
		assert.equal(a.opened, true);
		assert.equal(a.segment.count, 1);
		const b = core.placeStroke(a.segment, box(50, 50), 2000);
		assert.equal(b.opened, false);
		assert.equal(b.segment.id, a.segment.id);
		assert.equal(b.segment.count, 2);
		assert.equal(b.segment.endedAt, 2000);
	});

	it("closes at the stroke cap, on a pause, and when its ink passes the extent", () => {
		const open = { ...core.placeStroke(null, box(0, 0), 1000).segment };
		assert.equal(core.placeStroke({ ...open, count: core.SEGMENT_MAX_STROKES }, box(5, 5), 1100).opened, true, "stroke cap");
		assert.equal(core.placeStroke(open, box(5, 5), 1000 + core.SEGMENT_PAUSE_MS + 1).opened, true, "pause");
		assert.equal(core.placeStroke(open, box(core.SEGMENT_MAX_EXTENT, 0), 1100).opened, true, "extent");
		assert.equal(core.placeStroke(open, box(core.SEGMENT_MAX_EXTENT - 20, 0), 1100).opened, false, "just inside");
	});

	it("a new segment's id sorts after the one it follows, even in the same millisecond", () => {
		const now = 1_800_000_000_000;
		const a = core.placeStroke(null, box(0, 0), now).segment;
		const b = core.placeStroke({ ...a, count: core.SEGMENT_MAX_STROKES }, box(0, 0), now).segment;
		assert.ok(b.id > a.id);
		assert.match(b.id, core.SEGMENT_ID_RE);
	});

	it("groups a flat list by segment in segment order and resumes the newest one", () => {
		const strokes = [stroke(0, 0, { seg: "gb00000b" }), stroke(0, 0, { seg: "ga00000a" }), stroke(5, 5, { seg: "gb00000b" }), stroke(9, 9)];
		const groups = core.groupBySegment(strokes);
		assert.deepEqual([...groups.keys()], ["ga00000a", "gb00000b"]);
		assert.equal(groups.get("gb00000b")!.length, 2);
		const open = core.openSegmentOf(strokes, 777)!;
		assert.equal(open.id, "gb00000b");
		assert.equal(open.count, 2);
		assert.equal(open.endedAt, 777);
		assert.equal(core.openSegmentOf([], 0), null);
	});
});

describe("note fields", () => {
	it("dates are real calendar days; titles are trimmed and bounded; the default title names the day", () => {
		assert.equal(core.parseNoteDate("2026-11-19"), "2026-11-19");
		assert.equal(core.parseNoteDate("2026-02-30"), null);
		assert.equal(core.parseNoteDate("19/11/2026"), null);
		assert.equal(core.normalizeNoteTitle("  Taylor   series \n"), "Taylor series");
		assert.equal(core.normalizeNoteTitle("   "), null);
		assert.equal(core.normalizeNoteTitle("x".repeat(500))!.length, core.NOTE_TITLE_MAX);
		assert.equal(core.defaultNoteTitle("2026-03-12"), "Lecture 12 Mar");
		assert.match(core.todayDate(), /^\d{4}-\d{2}-\d{2}$/);
	});

	it("the thumbnail svg is null without ink and fits all of it inside the box otherwise", () => {
		assert.equal(core.noteThumbnailSvg([], 480, 360), null);
		const svg = core.noteThumbnailSvg([stroke(-3000, -2000), stroke(5000, 4000)], 480, 360)!;
		assert.match(svg, /^<svg /);
		const nums = [...svg.matchAll(/points="([^"]+)"/g)].flatMap((m) => m[1]!.split(/[ ,]/).map(Number));
		assert.ok(nums.every((n) => n >= 0 && n <= 480));
	});
});

describe("stroke ids", () => {
	it("a stroke keeps a valid id and seg through the parser; a bad one is refused", () => {
		const ok = sketch.parseSketchStroke(stroke(0, 0, { id: "kabc123", seg: "g12345678" }));
		assert.equal(ok.id, "kabc123");
		assert.equal(ok.seg, "g12345678");
		assert.throws(() => sketch.parseSketchStroke({ ...stroke(0, 0), id: "has space" }), /id is invalid/);
		assert.throws(() => sketch.parseSketchStroke({ ...stroke(0, 0), seg: "x".repeat(40) }), /seg is invalid/);
		assert.equal("id" in sketch.parseSketchStroke(stroke(0, 0)), false, "an answer sketch's strokes stay as they were");
	});

	it("the pixel eraser's pieces stay in the parent's segment with ids of their own", () => {
		const parent: SketchStroke = { size: 4, id: "kparent1", seg: "g12345678", points: Array.from({ length: 41 }, (_, i) => [i * 5, 0, 0.5]).flat() };
		const pieces = sketch.sketchStrokeCut(parent, [100, -5, 100, 5], 6)!;
		assert.ok(pieces.length >= 2);
		assert.ok(pieces.every((p) => p.seg === "g12345678" && typeof p.id === "string" && p.id !== "kparent1"));
		assert.equal(new Set(pieces.map((p) => p.id)).size, pieces.length);
		const plain = sketch.sketchStrokeCut({ size: 4, points: parent.points }, [100, -5, 100, 5], 6)!;
		assert.ok(plain.every((p) => p.id === undefined && p.seg === undefined));
	});
});

describe("sync scope", () => {
	it("a note's title record and ink segments travel; the thumbnail and a half-write do not", () => {
		assert.equal(syncScope("lecture-notes/course_1/ln_abc123def456/note.json"), "include");
		assert.equal(syncScope("lecture-notes/course_1/ln_abc123def456/seg-g1abc2def.json"), "include");
		assert.equal(syncScope("lecture-notes/course_1/ln_abc123def456/thumb.png"), "exclude");
		assert.equal(syncScope("lecture-notes/course_1/ln_abc123def456/seg-g1abc2def.json.tmp"), "exclude");
		assert.equal(syncScope("lecture-notes/course_1/../x/note.json"), "exclude");
	});
});

describe("the service over the store", () => {
	const course = courseStore.createCourse("Matte 1");
	const body = (strokes: unknown[], startedAt = 1000, endedAt = 2000) => JSON.stringify({ startedAt, endedAt, strokes });

	it("creates, lists newest day first, renames, redates and announces only what the page shows", () => {
		let announced = 0;
		const off = subscribe((e) => {
			if (e.type === "courses-changed") announced++;
		});
		assert.equal(svc.createLectureNote("course_missing", {}), null);
		const a = svc.createLectureNote(course.id, { title: "  Limits ", date: "2026-11-10" })!;
		const b = svc.createLectureNote(course.id, { date: "2026-11-12" })!;
		assert.equal(a.title, "Limits");
		assert.equal(b.title, "Lecture 12 Nov");
		assert.match(a.id, core.NOTE_ID_RE);
		assert.deepEqual(svc.listLectureNotes(course.id)!.map((n) => n.id), [b.id, a.id]);
		assert.equal(svc.updateLectureNote(course.id, a.id, { title: "Limits and continuity", date: "2026-11-13" })!.date, "2026-11-13");
		assert.deepEqual(svc.listLectureNotes(course.id)!.map((n) => n.id), [a.id, b.id], "redating reorders");
		assert.equal(svc.updateLectureNote(course.id, a.id, { title: "   " }), null, "an empty title is refused");
		assert.equal(svc.updateLectureNote(course.id, a.id, { date: "nope" }), null);
		const before = announced;
		const saved = svc.saveLectureNoteSegment(course.id, a.id, "g1abc2def", body([stroke(0, 0)]));
		assert.deepEqual(saved, { ok: true });
		assert.equal(announced, before, "a segment save does not announce");
		svc.leaveLectureNote(course.id, a.id);
		assert.equal(announced, before + 1, "leaving the note does");
		off();
	});

	it("saves segments in write order, flattens them with their seg, and an empty save removes one", () => {
		const n = svc.createLectureNote(course.id, { title: "Ink" })!;
		assert.deepEqual(svc.saveLectureNoteSegment(course.id, n.id, "g2bbbbbbb", body([stroke(20, 20, { id: "k2" })])), { ok: true });
		assert.deepEqual(svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body([stroke(0, 0, { id: "k1" }), stroke(5, 5, { id: "k1b" })])), { ok: true });
		const read = svc.readLectureNote(course.id, n.id)!;
		assert.deepEqual(read.strokes.map((s) => s.id), ["k1", "k1b", "k2"]);
		assert.deepEqual(read.strokes.map((s) => s.seg), ["g1aaaaaaa", "g1aaaaaaa", "g2bbbbbbb"]);
		assert.deepEqual(read.segments.map((s) => s.id), ["g1aaaaaaa", "g2bbbbbbb"]);
		assert.deepEqual(svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body([])), { ok: true });
		assert.deepEqual(svc.readLectureNote(course.id, n.id)!.segments.map((s) => s.id), ["g2bbbbbbb"]);
	});

	it("refuses a bad shape or an oversized body, but never a render limit (a tall, sparse segment saves)", () => {
		const n = svc.createLectureNote(course.id, {})!;
		const bad = (text: string) => svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", text);
		assert.deepEqual(bad("{nope"), { ok: false, status: 400, error: "Body is not JSON" });
		assert.equal((bad(body([{ size: 4, points: [1, 2] }])) as { status: number }).status, 400);
		assert.equal((bad(JSON.stringify({ strokes: [] })) as { status: number }).status, 400, "times are required");
		assert.equal((svc.saveLectureNoteSegment(course.id, n.id, "nope", body([])) as { status: number }).status, 400);
		assert.equal((svc.saveLectureNoteSegment(course.id, "ln_unknown000000", "g1aaaaaaa", body([])) as { status: number }).status, 404);
		assert.equal((bad("x".repeat(core.SEGMENT_MAX_CHARS + 1)) as { status: number }).status, 413);
		const tall = [stroke(0, 0), stroke(0, 90_000), stroke(0, 500_000)];
		assert.deepEqual(bad(body(tall)), { ok: true });
	});

	it("renders a thumbnail once per change of the ink and has none for an empty note", async () => {
		const n = svc.createLectureNote(course.id, {})!;
		assert.equal(await svc.lectureNoteThumbnail(course.id, n.id), null);
		svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body([stroke(0, 0), stroke(300, 200)]));
		const png = (await svc.lectureNoteThumbnail(course.id, n.id))!;
		assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
		const again = (await svc.lectureNoteThumbnail(course.id, n.id))!;
		assert.equal(Buffer.compare(Buffer.from(png), Buffer.from(again)), 0, "served from the cache");
		const list = svc.listLectureNotes(course.id)!.find((x) => x.id === n.id)!;
		assert.ok(list.inkAt > 0);
	});

	it("deleting a note, or its course, removes the ink", () => {
		const n = svc.createLectureNote(course.id, {})!;
		svc.saveLectureNoteSegment(course.id, n.id, "g1aaaaaaa", body([stroke(0, 0)]));
		assert.equal(svc.deleteLectureNote(course.id, n.id), true);
		assert.equal(svc.readLectureNote(course.id, n.id), null);
		assert.equal(svc.deleteLectureNote(course.id, n.id), false);
		const keep = svc.createLectureNote(course.id, {})!;
		svc.saveLectureNoteSegment(course.id, keep.id, "g1aaaaaaa", body([stroke(0, 0)]));
		assert.ok(fs.existsSync(path.join(PATHS.lectureNotes, course.id)));
		assert.equal(courses.deleteCourse(course.id), true);
		assert.equal(fs.existsSync(path.join(PATHS.lectureNotes, course.id)), false);
	});
});

describe("the client session", () => {
	type Call = { url: string; method: string; body?: string };
	const setup = (over: { fail?: () => boolean; serverStrokes?: SketchStroke[]; segments?: { id: string; startedAt: number; endedAt: number }[] } = {}) => {
		const calls: Call[] = [];
		let clock = 10_000;
		const store = memoryInkStore();
		noteInk.configureNoteInk({
			store,
			now: () => clock,
			saveDelayMs: 5,
			fetch: async (input: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push({ url: input, method, body: init?.body as string | undefined });
				if (method === "GET") {
					return Response.json({
						note: { id: "ln_testnote0001", courseId: "course_1", title: "T", date: "2026-11-19", createdAt: "", updatedAt: "" },
						strokes: over.serverStrokes ?? [],
						segments: over.segments ?? [],
					});
				}
				if (method === "PUT" && over.fail?.()) return new Response("no", { status: 500 });
				return new Response(null, { status: 204 });
			},
		});
		return { calls, store, tick: (ms: number) => (clock += ms) };
	};
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("stamps new strokes in place with an id and the open segment, and opens another after a pause", async () => {
		const { tick } = setup();
		const session = noteInk.noteSession("course_1", "ln_testnote0001");
		await session.load();
		const a = stroke(0, 0), b = stroke(5, 5);
		session.stamp(a);
		session.stamp(b);
		assert.ok(a.id && b.id && a.id !== b.id);
		assert.equal(a.seg, b.seg);
		tick(core.SEGMENT_PAUSE_MS + 1);
		const c = stroke(9, 9);
		session.stamp(c);
		assert.notEqual(c.seg, a.seg);
		await session.leave();
	});

	it("saves only the segments that changed, and the device copy is gone once the server has them", async () => {
		const old = [stroke(0, 0, { id: "k1", seg: "g1aaaaaaa" })];
		const { calls, store, tick } = setup({ serverStrokes: old, segments: [{ id: "g1aaaaaaa", startedAt: 1, endedAt: 2 }] });
		const session = noteInk.noteSession("course_1", "ln_testnote0001");
		await session.load();
		await sleep(560); // the canvas's own debounce hands the loaded ink to the session
		await session.flush();
		assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "loaded ink is not dirty");
		const loaded = inkMemory.readInk("ln_testnote0001").strokes;
		assert.equal(loaded.length, 1);
		tick(core.SEGMENT_PAUSE_MS + 1);
		const fresh = stroke(40, 40);
		session.stamp(fresh);
		session.onState({ strokes: [...loaded, fresh], undo: [], redo: [] });
		assert.ok(store.data.has("lndirty:ln_testnote0001"), "the device copy is written first");
		await session.flush();
		const puts = calls.filter((c) => c.method === "PUT");
		assert.equal(puts.length, 1, "only the new segment");
		assert.ok(puts[0]!.url.endsWith(`/segments/${fresh.seg}`));
		assert.equal(JSON.parse(puts[0]!.body!).strokes.length, 1);
		assert.equal(store.data.has("lndirty:ln_testnote0001"), false, "removed once confirmed");
		await session.leave();
		assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/leave")));
	});

	it("a failed save keeps the device copy, says so, and a later open restores the unconfirmed ink", async () => {
		let failing = true;
		const { calls, store } = setup({ fail: () => failing });
		const session = noteInk.noteSession("course_1", "ln_testnote0001");
		await session.load();
		const s = stroke(1, 1);
		session.stamp(s);
		session.onState({ strokes: [s], undo: [], redo: [] });
		await session.flush();
		assert.equal(inkMemory.inkSaveFailed("ln_testnote0001"), true);
		assert.ok(store.data.has("lndirty:ln_testnote0001"));
		assert.equal(session.unsaved, true);
		// the next open (the server still has nothing) takes the copy back, and saves it
		failing = false;
		const reopened = noteInk.noteSession("course_1", "ln_testnote0001");
		await reopened.load();
		await sleep(560);
		const held = inkMemory.readInk("ln_testnote0001").strokes;
		assert.equal(held.length, 1);
		assert.equal(held[0]!.id, s.id);
		await reopened.flush();
		assert.ok(calls.filter((c) => c.method === "PUT").length >= 2);
		assert.equal(inkMemory.inkSaveFailed("ln_testnote0001"), false);
		await reopened.leave();
	});
});
