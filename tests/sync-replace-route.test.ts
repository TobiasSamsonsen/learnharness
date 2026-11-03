/**
 * POST /api/sync/replace (app/api/sync/replace/route.ts): it never replaces
 * anything without an explicit {confirm: true}, a dry run only previews, and
 * with no repo or token set it answers with an error in the status instead of
 * failing. The data dir is isolated before any server module loads.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-replace-route-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_GITHUB_SYNC_TOKEN;

const { POST } = await import("../app/api/sync/replace/route.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const post = (body: unknown) =>
	POST(new Request("http://x/api/sync/replace", { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));

describe("POST /api/sync/replace", () => {
	it("refuses anything that is not an explicit dry run or confirm", async () => {
		for (const body of [undefined, {}, { confirm: false }, { confirm: "yes" }, { replace: true }]) {
			const res = await post(body);
			assert.equal(res.status, 400, JSON.stringify(body));
		}
	});

	it("previews without a repo: an error, nothing else", async () => {
		const res = await post({ dryRun: true });
		assert.equal(res.status, 200);
		const body = (await res.json()) as { preview: unknown; error: { message: string } | null };
		assert.equal(body.preview, null);
		assert.match(body.error?.message ?? "", /Set a repo and a token/);
	});

	it("reports an unconfigured confirm as an error in the status, and touches nothing", async () => {
		fs.mkdirSync(path.join(TMP, "chats"), { recursive: true });
		fs.writeFileSync(path.join(TMP, "chats", "mine.json"), "{}");
		const res = await post({ confirm: true });
		assert.equal(res.status, 200);
		const status = (await res.json()) as { configured: boolean; error: { message: string } | null };
		assert.equal(status.configured, false);
		assert.match(status.error?.message ?? "", /Set a repo and a token/);
		assert.ok(fs.existsSync(path.join(TMP, "chats", "mine.json")));
	});
});
