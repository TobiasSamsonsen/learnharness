/**
 * GitHub sync, the transport (src/server/sync/github.ts), against a fake
 * fetch: no network. Pinned: the auth header, error mapping, the empty-repo
 * bootstrap, text files riding inline in the tree while binaries take the
 * blob endpoint, one commit per push, and a moved branch failing as
 * "conflict" rather than being forced.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError, GitHubRepo } from "../src/server/sync/github.ts";

interface Call {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
}
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };

/** A fake fetch: `routes` maps "METHOD /path" to a reply (or a function of the call). */
function fake(routes: Record<string, Reply | ((call: Call) => Reply)>) {
	const calls: Call[] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const call: Call = {
			method: init?.method ?? "GET",
			path: url.pathname + url.search,
			headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		calls.push(call);
		const route = routes[`${call.method} ${call.path}`];
		if (!route) return new Response(JSON.stringify({ message: `no route ${call.method} ${call.path}` }), { status: 500 });
		const reply = typeof route === "function" ? route(call) : route;
		const status = reply.status ?? 200;
		return new Response(status === 204 ? null : JSON.stringify(reply.json ?? {}), { status, headers: reply.headers });
	}) as typeof fetch;
	return { calls, repo: new GitHubRepo({ owner: "me", repo: "sync", token: "tok_123", fetch: impl }) };
}

const R = "/repos/me/sync";
const HEAD: Reply = { json: { commit: { sha: "c1", commit: { tree: { sha: "t1" } } } } };

describe("GitHubRepo requests", () => {
	it("sends the token as a Bearer header and only to the API", async () => {
		const { calls, repo } = fake({ [`GET ${R}`]: { json: { default_branch: "trunk", private: true } } });
		assert.deepEqual(await repo.info(), { defaultBranch: "trunk", private: true });
		assert.equal(calls[0]?.headers.authorization, "Bearer tok_123");
		assert.equal(calls[0]?.headers["x-github-api-version"], "2022-11-28");
	});

	it("reads the branch tip in one request", async () => {
		const { calls, repo } = fake({ [`GET ${R}/branches/main`]: HEAD });
		assert.deepEqual(await repo.head("main"), { commit: "c1", tree: "t1" });
		assert.equal(calls.length, 1);
	});

	it("reads a branch with a slash in its name", async () => {
		const { repo } = fake({ [`GET ${R}/branches/feature/x`]: HEAD });
		assert.deepEqual(await repo.head("feature/x"), { commit: "c1", tree: "t1" });
	});

	it("reads a missing branch, or an empty repo, as no head", async () => {
		const a = fake({ [`GET ${R}/branches/main`]: { status: 404, json: { message: "Branch not found" } } });
		assert.equal(await a.repo.head("main"), null);
		const b = fake({ [`GET ${R}/branches/main`]: { status: 409, json: { message: "Git Repository is empty." } } });
		assert.equal(await b.repo.head("main"), null);
	});

	it("lists a tree's files, skipping folders", async () => {
		const { repo } = fake({
			[`GET ${R}/git/trees/t1?recursive=1`]: {
				json: {
					tree: [
						{ path: "chats", type: "tree", sha: "d" },
						{ path: "chats/a.json", type: "blob", sha: "s1", size: 10 },
					],
				},
			},
		});
		assert.deepEqual(await repo.tree("t1"), { "chats/a.json": { sha: "s1", size: 10 } });
	});

	it("refuses a truncated listing rather than syncing half the repo", async () => {
		const { repo } = fake({ [`GET ${R}/git/trees/t1?recursive=1`]: { json: { tree: [], truncated: true } } });
		await assert.rejects(repo.tree("t1"), (e: GitHubError) => e.code === "truncated");
	});

	it("decodes blobs and fetches each SHA once", async () => {
		const { calls, repo } = fake({
			[`GET ${R}/git/blobs/s1`]: { json: { encoding: "base64", content: Buffer.from("hi").toString("base64") } },
		});
		const out = await repo.blobs(["s1", "s1"]);
		assert.equal(Buffer.from(out.s1 as Uint8Array).toString(), "hi");
		assert.equal(calls.length, 1);
	});
});

describe("GitHubRepo errors", () => {
	const code = (status: number, headers: Record<string, string> = {}, message = "x") =>
		fake({ [`GET ${R}`]: { status, headers, json: { message } } }).repo.info().then(
			() => null,
			(e: GitHubError) => e,
		);

	it("maps 401 and a plain 403 to auth, 404 to not-found", async () => {
		assert.equal((await code(401))?.code, "auth");
		assert.equal((await code(403, {}, "Resource not accessible by personal access token"))?.code, "auth");
		assert.equal((await code(404))?.code, "not-found");
	});

	it("maps an exhausted limit to rate-limit with the reset time", async () => {
		const e = await code(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" }, "API rate limit exceeded");
		assert.equal(e?.code, "rate-limit");
		assert.equal(e?.resetAt, 1_700_000_000_000);
		assert.equal((await code(429))?.code, "rate-limit");
	});

	it("reports a network failure as network, not a crash", async () => {
		const repo = new GitHubRepo({
			owner: "me",
			repo: "sync",
			token: "t",
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		});
		await assert.rejects(repo.info(), (e: GitHubError) => e.code === "network");
	});

	it("never puts the token in an error message", async () => {
		const e = await code(401);
		assert.ok(e && !e.message.includes("tok_123"));
	});
});

describe("GitHubRepo.push", () => {
	const parent = { commit: "c1", tree: "t1" };

	it("makes one commit: text inline in the tree, binary through the blob endpoint, deletes as null", async () => {
		const { calls, repo } = fake({
			[`POST ${R}/git/blobs`]: { json: { sha: "blob-bin" } },
			[`POST ${R}/git/trees`]: { json: { sha: "t2" } },
			[`POST ${R}/git/commits`]: { json: { sha: "c2" } },
			[`PATCH ${R}/git/refs/heads/main`]: { json: {} },
		});
		const out = await repo.push(
			"main",
			parent,
			[
				{ path: "chats/a.json", content: Buffer.from('{"a":1}\n') },
				{ path: "sketches/c/s/0.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) },
				{ path: "chats/old.json", content: null },
			],
			"sync",
		);
		assert.deepEqual(out, { commit: "c2", tree: "t2" });

		const blobs = calls.filter((c) => c.path.endsWith("/git/blobs"));
		assert.equal(blobs.length, 1, "only the binary file takes a blob request");
		assert.equal((blobs[0]?.body as { encoding: string }).encoding, "base64");

		const tree = calls.find((c) => c.path.endsWith("/git/trees"))?.body as { base_tree: string; tree: Record<string, unknown>[] };
		assert.equal(tree.base_tree, "t1");
		const byPath = Object.fromEntries(tree.tree.map((e) => [e.path as string, e]));
		assert.equal(byPath["chats/a.json"]?.content, '{"a":1}\n');
		assert.equal(byPath["sketches/c/s/0.png"]?.sha, "blob-bin");
		assert.equal(byPath["chats/old.json"]?.sha, null);

		const commit = calls.find((c) => c.path.endsWith("/git/commits"))?.body as { tree: string; parents: string[] };
		assert.deepEqual(commit, { message: "sync", tree: "t2", parents: ["c1"] });
		const ref = calls.find((c) => c.method === "PATCH")?.body as { sha: string; force: boolean };
		assert.deepEqual(ref, { sha: "c2", force: false });
	});

	it("sends text with a NUL or invalid UTF-8 as a blob, not inline", async () => {
		const { calls, repo } = fake({
			[`POST ${R}/git/blobs`]: { json: { sha: "b" } },
			[`POST ${R}/git/trees`]: { json: { sha: "t2" } },
			[`POST ${R}/git/commits`]: { json: { sha: "c2" } },
			[`PATCH ${R}/git/refs/heads/main`]: { json: {} },
		});
		await repo.push("main", parent, [{ path: "chats/a.json", content: new Uint8Array([0x7b, 0xc3, 0x28]) }], "m");
		assert.equal(calls.filter((c) => c.path.endsWith("/git/blobs")).length, 1);
	});

	it("builds a large push as chained trees, each on the last", async () => {
		let n = 0;
		const { calls, repo } = fake({
			[`POST ${R}/git/trees`]: () => ({ json: { sha: `t${++n + 1}` } }),
			[`POST ${R}/git/commits`]: { json: { sha: "c2" } },
			[`PATCH ${R}/git/refs/heads/main`]: { json: {} },
		});
		const changes = Array.from({ length: 650 }, (_, i) => ({ path: `chats/c${i}.json`, content: Buffer.from("{}") }));
		await repo.push("main", parent, changes, "m");
		const trees = calls.filter((c) => c.path.endsWith("/git/trees")).map((c) => (c.body as { base_tree: string }).base_tree);
		assert.deepEqual(trees, ["t1", "t2", "t3"]);
		const commit = calls.find((c) => c.path.endsWith("/git/commits"))?.body as { tree: string };
		assert.equal(commit.tree, "t4");
	});

	it("does nothing when there are no changes", async () => {
		const { calls, repo } = fake({});
		assert.deepEqual(await repo.push("main", parent, [], "m"), parent);
		assert.equal(calls.length, 0);
	});

	it("starts an empty repo with a marker file, then builds on that commit", async () => {
		const { calls, repo } = fake({
			[`PUT ${R}/contents/.learnharness-sync`]: { json: { commit: { sha: "c0", tree: { sha: "t0" } } } },
			[`POST ${R}/git/trees`]: { json: { sha: "t2" } },
			[`POST ${R}/git/commits`]: { json: { sha: "c2" } },
			[`PATCH ${R}/git/refs/heads/main`]: { json: {} },
		});
		await repo.push("main", null, [{ path: "chats/a.json", content: Buffer.from("{}") }], "m");
		assert.equal(calls[0]?.method, "PUT");
		assert.equal((calls.find((c) => c.path.endsWith("/git/trees"))?.body as { base_tree: string }).base_tree, "t0");
		assert.deepEqual((calls.find((c) => c.path.endsWith("/git/commits"))?.body as { parents: string[] }).parents, ["c0"]);
	});

	it("fails as a conflict, never forcing, when the branch moved", async () => {
		const { repo } = fake({
			[`POST ${R}/git/trees`]: { json: { sha: "t2" } },
			[`POST ${R}/git/commits`]: { json: { sha: "c2" } },
			[`PATCH ${R}/git/refs/heads/main`]: { status: 422, json: { message: "Update is not a fast forward" } },
		});
		await assert.rejects(
			repo.push("main", parent, [{ path: "chats/a.json", content: Buffer.from("{}") }], "m"),
			(e: GitHubError) => e.code === "conflict",
		);
	});
});
