/**
 * GitHub sync, the service (src/server/sync/service.ts): when rounds run and
 * what stops them. A fake repo and a hand-driven clock; no timers, no network.
 * Pinned: one round at a time, an unconfigured service does nothing, a public
 * repo is refused, a bad token stops the automatic rounds until the config
 * changes (the manual button still tries), a rate limit pauses until it
 * lifts, a pull on the first look and every five minutes after, and a push
 * only once the data has been still for the quiet period.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { GitHubError, type RemoteRepo } from "../src/server/sync/github.ts";
import { createSyncService, parseRepo, type SyncConfig } from "../src/server/sync/service.ts";
import { FakeRemote } from "./sync-fake-remote.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-service-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function setup(over: { config?: SyncConfig; remote?: FakeRemote; makeRemote?: () => RemoteRepo } = {}) {
	const dataDir = path.join(TMP, `d${n++}`, "data");
	const syncDir = path.join(dataDir, "sync");
	fs.mkdirSync(path.join(dataDir, "chats"), { recursive: true });
	const remote = over.remote ?? new FakeRemote();
	const config: SyncConfig = over.config ?? { repo: "me/sync", token: "tok" };
	let t = Date.parse("2026-03-01T00:00:00Z");
	const service = createSyncService({
		dataDir,
		syncDir,
		readConfig: () => config,
		makeRemote: over.makeRemote ?? (() => remote as unknown as RemoteRepo),
		now: () => new Date(t),
		tickMs: 10_000,
	});
	return {
		dataDir,
		remote,
		config,
		service,
		advance: (ms: number) => (t += ms),
		write: (rel: string, content: string) => fs.writeFileSync(path.join(dataDir, rel), content),
		/** One look, then wait for whatever round it started (if any). */
		look: async () => {
			service.tick();
			await service.whenIdle();
		},
	};
}

describe("parseRepo", () => {
	it("takes owner/repo, a pasted URL, and .git", () => {
		assert.deepEqual(parseRepo("me/sync"), { owner: "me", repo: "sync" });
		assert.deepEqual(parseRepo("https://github.com/me/sync.git"), { owner: "me", repo: "sync" });
		assert.deepEqual(parseRepo("  me/my.repo_1  "), { owner: "me", repo: "my.repo_1" });
	});
	it("refuses anything else", () => {
		for (const bad of ["", "me", "me/", "/sync", "a/b/c", "me/sy nc", "-me/sync", null, undefined]) assert.equal(parseRepo(bad as string), null, String(bad));
	});
});

describe("the service", () => {
	it("does nothing, and says so, until a repo and a token are set", async () => {
		const s = setup({ config: { repo: "me/sync", token: null } });
		const st = await s.service.syncNow();
		assert.equal(st.configured, false);
		assert.equal(s.remote.heads, 0);
		assert.equal(st.error, null);
	});

	it("runs a round on demand and reports it", async () => {
		const s = setup();
		s.write("chats/chat_1.json", "{}");
		const st = await s.service.syncNow();
		assert.equal(st.configured, true);
		assert.equal(st.error, null);
		assert.equal(st.last?.pushed, 1);
		assert.ok(st.lastOkAt);
		assert.ok(s.remote.files.has("chats/chat_1.json"));
	});

	it("joins a round already running instead of starting a second", async () => {
		const s = setup();
		s.write("chats/chat_1.json", "{}");
		const [a, b] = await Promise.all([s.service.syncNow(), s.service.syncNow()]);
		assert.equal(a.last?.pushed, 1);
		assert.deepEqual(a, b);
		assert.equal(s.remote.pushes, 1);
	});

	it("refuses a public repo, stops trying by itself, and recovers when it is made private", async () => {
		const remote = new FakeRemote();
		remote.isPrivate = false;
		const s = setup({ remote });
		s.write("chats/chat_1.json", "{}");
		const st = await s.service.syncNow();
		assert.equal(st.error?.code, "public-repo");
		assert.equal(remote.files.size, 0, "nothing was pushed to a public repo");
		const heads = remote.heads;
		s.advance(10 * 60_000);
		await s.look();
		assert.equal(remote.heads, heads, "the automatic loop does not retry");
		remote.isPrivate = true;
		const again = await s.service.syncNow(); // the manual button always tries
		assert.equal(again.error, null);
		assert.ok(remote.files.has("chats/chat_1.json"));
	});

	it("stops the automatic rounds on a bad token until the config changes", async () => {
		let calls = 0;
		const bad = {
			info: async () => ({ defaultBranch: "main", private: true }),
			head: async () => {
				calls++;
				throw new GitHubError("Bad credentials", "auth", 401);
			},
		} as unknown as RemoteRepo;
		const s = setup({ makeRemote: () => bad });
		const st = await s.service.syncNow();
		assert.equal(st.error?.code, "auth");
		assert.match(st.error?.message ?? "", /refused the token/);
		s.advance(10 * 60_000);
		await s.look();
		assert.equal(calls, 1, "no automatic retry with the same token");
		s.config.token = "new-token";
		s.advance(10 * 60_000);
		await s.look();
		assert.equal(calls, 2, "a changed token is tried again");
	});

	it("pauses until a rate limit lifts", async () => {
		let calls = 0;
		const resetAt = Date.parse("2026-03-01T01:00:00Z");
		const limited = {
			info: async () => ({ defaultBranch: "main", private: true }),
			head: async () => {
				calls++;
				throw new GitHubError("rate limit", "rate-limit", 403, resetAt);
			},
		} as unknown as RemoteRepo;
		const s = setup({ makeRemote: () => limited });
		const st = await s.service.syncNow();
		assert.equal(st.error?.code, "rate-limit");
		s.advance(10 * 60_000);
		await s.look();
		assert.equal(calls, 1, "still paused");
		s.advance(60 * 60_000);
		await s.look();
		assert.equal(calls, 2, "resumes after the reset");
	});

	it("pulls on the first look, then every five minutes", async () => {
		const s = setup();
		await s.look();
		const first = s.remote.heads;
		assert.ok(first >= 1);
		s.advance(60_000);
		await s.look();
		assert.equal(s.remote.heads, first, "not yet");
		s.advance(5 * 60_000);
		await s.look();
		assert.ok(s.remote.heads > first, "due");
	});

	it("pushes only after the data has been still for the quiet period", async () => {
		const s = setup();
		await s.look(); // the first round
		s.write("chats/chat_1.json", "{}");
		s.advance(10_000);
		await s.look();
		assert.equal(s.remote.pushes, 0, "the change was just seen");
		s.advance(10_000);
		await s.look();
		assert.equal(s.remote.pushes, 0, "only 10 seconds quiet");
		s.advance(25_000);
		await s.look();
		assert.equal(s.remote.pushes, 1, "35 seconds quiet: pushed");
		s.advance(60_000);
		await s.look();
		assert.equal(s.remote.pushes, 1, "and not again while nothing changed");
	});

	it("starts the quiet period over while the data is still changing", async () => {
		const s = setup();
		await s.look();
		s.write("chats/chat_1.json", "{}");
		s.advance(10_000);
		await s.look();
		for (let i = 0; i < 6; i++) {
			s.advance(20_000);
			s.write("chats/chat_1.json", `{"edit":${i}}`);
			fs.utimesSync(path.join(s.dataDir, "chats/chat_1.json"), new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000));
			await s.look();
		}
		assert.equal(s.remote.pushes, 0, "never quiet, never pushed");
	});
});
