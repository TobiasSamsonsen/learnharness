/**
 * COURSE FOLDERS on the server (owner, 2026-11-14): the folder field on the course, the PATCH, the rename/remove route,
 * the summaries the sidebar reads, and the sync merge. LH_DATA_DIR is set before the first import that loads config.ts.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-folders-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { courseStore } = await import("../src/store/courses.ts");
const courses = await import("../src/server/courses.ts");
const { PATCH } = await import("../app/api/courses/[id]/route.ts");
const { POST } = await import("../app/api/courses/folders/route.ts");
const { GET: listGET } = await import("../app/api/courses/route.ts");
const { mergeFile } = await import("../src/core/sync-merge.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const patch = (id: string, body: unknown) => PATCH(new Request(`http://x/api/courses/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const folders = (body: unknown) => POST(new Request("http://x/api/courses/folders", { method: "POST", body: JSON.stringify(body) }));
const folderOf = (id: string) => courseStore.getCourse(id)!.folder;
const make = (title: string) => courseStore.createCourse(title);

describe("the folder field", () => {
	it("is set and cleared through PATCH, and the response carries it", async () => {
		const a = make("Matte 1");
		const res = await patch(a.id, { folder: "  2026-2   Høst " });
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { folder?: string }).folder, "2026-2 Høst");
		assert.equal(folderOf(a.id), "2026-2 Høst");
		assert.equal((await patch(a.id, { folder: null })).status, 200);
		assert.equal(folderOf(a.id), undefined);
		await patch(a.id, { folder: "Temp" });
		assert.equal((await patch(a.id, { folder: "   " })).status, 200, "blank text clears it too");
		assert.equal(folderOf(a.id), undefined);
	});

	it("refuses a name that is too long or not text, and an unknown course", async () => {
		const a = make("A");
		assert.equal((await patch(a.id, { folder: "x".repeat(61) })).status, 400);
		assert.equal((await patch(a.id, { folder: 5 })).status, 400);
		assert.equal(folderOf(a.id), undefined);
		assert.equal((await patch("course_nope", { folder: "X" })).status, 404);
	});

	it("takes the spelling an existing folder already has", async () => {
		const a = make("A");
		const b = make("B");
		await patch(a.id, { folder: "2026-2 Høst" });
		await patch(b.id, { folder: "2026-2 høst" });
		assert.equal(folderOf(b.id), "2026-2 Høst");
	});

	it("rides the sidebar's course list", async () => {
		const a = make("Listed");
		await patch(a.id, { folder: "2027 Vår" });
		const body = (await (await listGET()).json()) as { courses: Array<{ id: string; folder?: string }> };
		assert.equal(body.courses.find((c) => c.id === a.id)?.folder, "2027 Vår");
		assert.equal(body.courses.find((c) => c.id === make("Unfiled").id)?.folder, undefined);
	});
});

describe("the folders route", () => {
	it("renames a folder on every course in it, merging into an existing folder, and removes one without deleting a course", async () => {
		const a = make("A1");
		const b = make("B1");
		const c = make("C1");
		await patch(a.id, { folder: "Rename me" });
		await patch(b.id, { folder: "rename me" });
		await patch(c.id, { folder: "Target" });
		const renamed = await folders({ action: "rename", from: "Rename Me", to: "target" });
		assert.equal(renamed.status, 200);
		assert.deepEqual(await renamed.json(), { changed: 2 });
		assert.deepEqual([folderOf(a.id), folderOf(b.id), folderOf(c.id)], ["Target", "Target", "Target"]);
		const removed = await folders({ action: "remove", name: "TARGET" });
		assert.deepEqual(await removed.json(), { changed: 3 });
		assert.deepEqual([folderOf(a.id), folderOf(b.id), folderOf(c.id)], [undefined, undefined, undefined]);
		assert.ok(courseStore.getCourse(a.id) && courseStore.getCourse(b.id) && courseStore.getCourse(c.id), "no course was deleted");
	});

	it("refuses a bad body and a bad new name, and changes nothing for an unknown folder", async () => {
		assert.equal((await folders({})).status, 400);
		assert.equal((await folders({ action: "rename", from: "a" })).status, 400);
		assert.equal((await folders({ action: "rename", from: "a", to: "x".repeat(61) })).status, 400);
		assert.deepEqual(await (await folders({ action: "remove", name: "No such folder" })).json(), { changed: 0 });
		assert.equal(courses.changeCourseFolders({ action: "rename", from: "x", to: " " }).ok, false);
	});
});

describe("sync: the folder is a per-field value", () => {
	const course = (over: Record<string, unknown>) => ({ id: "course_1", title: "T", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", status: "active", skills: ["a"], version: 1, ...over });
	const merged = (local: unknown, remote: unknown, base: unknown) => {
		const r = mergeFile({ path: "courses/course_1.json", base: JSON.stringify(base), prefer: "local", local: JSON.stringify(local), remote: JSON.stringify(remote) });
		return JSON.parse(r.content ?? "null") as Record<string, unknown>;
	};
	const base = course({});

	it("a folder set on one device and a rename on the other both survive", () => {
		const moved = course({ folder: "2026-2 Høst", updatedAt: "2026-01-02T00:00:00Z" });
		const renamed = course({ title: "Renamed", updatedAt: "2026-01-03T00:00:00Z" });
		for (const [l, r] of [[moved, renamed], [renamed, moved]]) {
			const out = merged(l, r, base);
			assert.equal(out.folder, "2026-2 Høst");
			assert.equal(out.title, "Renamed");
		}
	});

	it("a folder taken away stays away", () => {
		const had = course({ folder: "Old" });
		const cleared = course({ updatedAt: "2026-01-02T00:00:00Z" });
		assert.equal("folder" in merged(cleared, had, had), false);
	});
});
