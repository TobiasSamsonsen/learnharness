/**
 * The ink-draft route (owner plan, 2026-11-15): PUT validates like a submit, GET returns it, DELETE removes it, keys are safe.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-drafts-route-"));
process.env.LH_DATA_DIR = dir;
const { GET, PUT, DELETE } = await import("../app/api/ink-drafts/[key]/route.ts");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ctx = (key: string) => ({ params: Promise.resolve({ key }) });
const put = (key: string, body: string) => PUT(new Request("http://x/api/ink-drafts/" + key, { method: "PUT", body }), ctx(key));
const strokes = JSON.stringify([{ size: 4, points: [1, 2, 0.5, 3, 4, 0.5] }]);

describe("/api/ink-drafts/[key]", () => {
	it("stores a valid page, returns it, and deletes it", async () => {
		assert.equal((await put("toolu_1", strokes)).status, 204);
		const got = await GET(new Request("http://x"), ctx("toolu_1"));
		assert.equal(got.status, 200);
		assert.equal(await got.text(), strokes);
		assert.equal((await DELETE(new Request("http://x", { method: "DELETE" }), ctx("toolu_1"))).status, 204);
		assert.equal((await GET(new Request("http://x"), ctx("toolu_1"))).status, 404);
	});

	it("refuses a damaged or empty page and stores nothing", async () => {
		assert.equal((await put("toolu_2", "{nope")).status, 400);
		assert.equal((await put("toolu_2", "[]")).status, 400);
		assert.equal((await put("toolu_2", JSON.stringify([{ size: 4, points: [1, 2] }]))).status, 400);
		assert.equal((await GET(new Request("http://x"), ctx("toolu_2"))).status, 404);
	});

	it("refuses unsafe keys on every method", async () => {
		for (const key of ["../x", "a b", "a.b", ""]) {
			assert.equal((await put(key, strokes)).status, 400, key);
			assert.equal((await GET(new Request("http://x"), ctx(key))).status, 400, key);
			assert.equal((await DELETE(new Request("http://x", { method: "DELETE" }), ctx(key))).status, 400, key);
		}
	});
});
