/**
 * The Sync settings screen's requests (components/settings/sync-client.ts)
 * against a fetch stub: which endpoint and body each action uses, that a
 * server refusal comes back as the server's own sentence, and that nothing
 * throws when the network is down.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	loadSyncState,
	previewReplace,
	replaceFromRepo,
	removeSyncToken,
	runSyncRound,
	saveSyncRepo,
	saveSyncToken,
} from "../components/settings/sync-client.ts";

const real = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = real;
});

interface Seen {
	method: string;
	url: string;
	body: unknown;
}
function stub(routes: Record<string, { status?: number; json?: unknown } | "down">): Seen[] {
	const seen: Seen[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const url = String(input);
		seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const route = routes[`${method} ${url}`];
		if (route === "down") throw new TypeError("fetch failed");
		if (!route) return new Response(JSON.stringify({ error: "no route" }), { status: 500 });
		return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200 });
	}) as typeof fetch;
	return seen;
}

describe("sync-client", () => {
	it("saves the repo to the settings section", async () => {
		const seen = stub({ "PUT /api/settings/sync": { json: { settings: {} } } });
		assert.equal(await saveSyncRepo("me/sync"), null);
		assert.deepEqual(seen[0], { method: "PUT", url: "/api/settings/sync", body: { repo: "me/sync" } });
	});

	it("hands back the server's own sentence when it refuses", async () => {
		stub({ "PUT /api/settings/sync": { status: 400, json: { error: "repo must look like owner/repo" } } });
		assert.equal(await saveSyncRepo("nope"), "repo must look like owner/repo");
	});

	it("falls back to a plain sentence when the refusal has no body", async () => {
		globalThis.fetch = (async () => new Response("<html>", { status: 502 })) as typeof fetch;
		assert.equal(await saveSyncRepo("me/sync"), "Could not save the repository (502)");
	});

	it("sends the token to the key store and removes it from there", async () => {
		const seen = stub({
			"PUT /api/keys/LH_GITHUB_SYNC_TOKEN": { json: { status: {} } },
			"DELETE /api/keys/LH_GITHUB_SYNC_TOKEN": { json: { status: {} } },
		});
		assert.equal(await saveSyncToken("github_pat_abcdefghijklmnopqrstuvwxyz"), null);
		assert.deepEqual(seen[0]?.body, { value: "github_pat_abcdefghijklmnopqrstuvwxyz" });
		assert.equal(await removeSyncToken(), null);
		assert.equal(seen[1]?.method, "DELETE");
		assert.equal(seen[1]?.body, undefined);
	});

	it("reads the status and the saved repo together", async () => {
		stub({
			"GET /api/sync": { json: { configured: true, repo: "me/sync" } },
			"GET /api/settings": { json: { settings: { sync: { repo: "me/sync" } } } },
		});
		const s = await loadSyncState();
		assert.equal(s.status?.repo, "me/sync");
		assert.equal(s.repo, "me/sync");
	});

	it("reads a record with no sync section as an empty repo, and an unreadable one as unknown", async () => {
		stub({ "GET /api/sync": { json: {} }, "GET /api/settings": { json: { settings: null } } });
		assert.equal((await loadSyncState()).repo, "");
		stub({ "GET /api/sync": { json: {} }, "GET /api/settings": { status: 500, json: {} } });
		assert.equal((await loadSyncState()).repo, null);
	});

	it("runs a round and returns its status, or the error", async () => {
		stub({ "POST /api/sync/run": { json: { configured: true, lastOkAt: "t" } } });
		const ok = await runSyncRound();
		assert.equal(ok.error, null);
		assert.equal(ok.status?.lastOkAt, "t");
		stub({ "POST /api/sync/run": { status: 500, json: { error: "boom" } } });
		assert.deepEqual(await runSyncRound(), { status: null, error: "boom" });
	});

	it("asks for a replace preview with a dry run, and nothing else", async () => {
		const seen = stub({ "POST /api/sync/replace": { json: { preview: { write: { chats: 2 }, remove: { chats: 1 } }, error: null } } });
		const r = await previewReplace();
		assert.deepEqual(r, { preview: { write: { chats: 2 }, remove: { chats: 1 } }, error: null });
		assert.deepEqual(seen[0]?.body, { dryRun: true });
	});

	it("hands back the server's reason when the preview is refused", async () => {
		stub({ "POST /api/sync/replace": { json: { preview: null, error: { code: "empty-repo", message: "The repo holds no synced data." } } } });
		assert.deepEqual(await previewReplace(), { preview: null, error: "The repo holds no synced data." });
	});

	it("replaces only with an explicit confirm", async () => {
		const seen = stub({ "POST /api/sync/replace": { json: { configured: true, lastOkAt: "t" } } });
		const r = await replaceFromRepo();
		assert.equal(r.error, null);
		assert.equal(r.status?.lastOkAt, "t");
		assert.deepEqual(seen[0]?.body, { confirm: true });
	});

	it("never throws when the network is down", async () => {
		stub({ "PUT /api/settings/sync": "down", "POST /api/sync/run": "down", "GET /api/sync": "down", "GET /api/settings": "down" });
		assert.equal(await saveSyncRepo("me/sync"), "Could not save the repository");
		assert.deepEqual(await runSyncRound(), { status: null, error: "Sync failed" });
		assert.deepEqual(await loadSyncState(), { status: null, repo: null });
		stub({ "POST /api/sync/replace": "down" });
		assert.deepEqual(await previewReplace(), { preview: null, error: "Could not check the repo" });
		assert.deepEqual(await replaceFromRepo(), { status: null, error: "Replace failed" });
	});
});
