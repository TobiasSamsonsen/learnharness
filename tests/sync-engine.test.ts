/**
 * GitHub sync, one round end to end (src/server/sync/engine.ts): two devices,
 * each with its own data dir and manifest, share one in-memory "repo". Pinned:
 * a first sync, an idle second round, pulling, device-only settings left
 * alone, a chat continued on both devices (newer kept, loser saved), a delete
 * against an edit (the edit survives), a file changed on this device while the
 * round was fetching (skipped, never clobbered), and a branch that moved
 * mid-push (the round restarts, never forces).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { runSync, type AppliedChange } from "../src/server/sync/engine.ts";
import { GitHubError, type RemoteRepo } from "../src/server/sync/github.ts";
import { FakeRemote } from "./sync-fake-remote.ts";
import { CURRENT_CHAT_VERSION } from "../src/core/contracts/chat.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-engine-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let devices = 0;
function device(remote: FakeRemote) {
	const root = path.join(TMP, `device-${devices++}`);
	const dataDir = path.join(root, "data");
	const syncDir = path.join(dataDir, "sync");
	fs.mkdirSync(dataDir, { recursive: true });
	const applied: AppliedChange[] = [];
	return {
		dataDir,
		syncDir,
		applied,
		write(rel: string, content: string) {
			const f = path.join(dataDir, rel);
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, content);
		},
		read(rel: string): string | null {
			try {
				return fs.readFileSync(path.join(dataDir, rel), "utf8");
			} catch {
				return null;
			}
		},
		sync: () =>
			runSync({
				dataDir,
				syncDir,
				remote: remote as unknown as RemoteRepo,
				repoName: "me/sync",
				branch: "main",
				now: () => new Date("2026-03-01T00:00:00Z"),
				onApplied: (c) => applied.push(...c),
			}),
	};
}

const j = (v: unknown) => JSON.stringify(v, null, "\t");
const chat = (over: Record<string, unknown>) => ({
	id: "chat_1",
	title: "T",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	messages: [] as unknown[],
	// what this build writes (a version 1 fixture hid a merge that held back every current chat)
	version: CURRENT_CHAT_VERSION,
	...over,
});
const m = (id: string) => ({ id, role: "user", content: id, timestamp: 1 });
const ids = (text: string | null) => (JSON.parse(text ?? "{}") as { messages: { id: string }[] }).messages.map((x) => x.id);

describe("a round", () => {
	it("pushes a first sync, then finds nothing to do", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		a.write("chats/chat_1.json", j(chat({ messages: [m("m1")] })));
		a.write("models/big.bin", "never synced");
		const r = await a.sync();
		assert.deepEqual(r.pushed, ["chats/chat_1.json"]);
		assert.deepEqual([...remote.files.keys()], ["chats/chat_1.json"]);
		const again = await a.sync();
		assert.equal(again.idle, true);
		assert.equal(remote.pushes, 1);
	});

	it("pulls a chat onto a second device and reports it as applied", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("chats/chat_1.json", j(chat({ messages: [m("m1")] })));
		await a.sync();
		const r = await b.sync();
		assert.deepEqual(r.pulled, ["chats/chat_1.json"]);
		assert.deepEqual(ids(b.read("chats/chat_1.json")), ["m1"]);
		assert.deepEqual(b.applied, [{ path: "chats/chat_1.json", kind: "written" }]);
		assert.equal((await b.sync()).idle, true);
	});

	it("carries a later append from one device to the other", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("chats/chat_1.json", j(chat({ messages: [m("m1")] })));
		await a.sync();
		await b.sync();
		a.write("chats/chat_1.json", j(chat({ updatedAt: "2026-02-01T00:00:00Z", messages: [m("m1"), m("m2")] })));
		await a.sync();
		const r = await b.sync();
		assert.deepEqual(r.pulled, ["chats/chat_1.json"]);
		assert.deepEqual(ids(b.read("chats/chat_1.json")), ["m1", "m2"]);
	});

	it("leaves a file a person put in the repo alone", async () => {
		const remote = new FakeRemote();
		remote.put("README.md", "hello"); // a person's file in the repo
		remote.n = 1;
		const a = device(remote);
		a.write("courses/course_1.json", j({ id: "course_1", version: 1 }));
		await a.sync();
		assert.ok(remote.files.has("courses/course_1.json"));
		assert.equal(remote.text("README.md"), "hello");
		assert.equal(a.read("README.md"), null);
	});

	it("leaves a device's own settings alone when it pulls another's", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("settings.json", j({ version: 1, models: { strong: "a" }, appearance: { fontFamily: "Inter" } }));
		await a.sync();
		b.write("settings.json", j({ version: 1, customProvider: { baseUrl: "http://localhost:11434" }, appearance: { fontFamily: "Lato" } }));
		await b.sync();
		const out = JSON.parse(b.read("settings.json") ?? "{}") as Record<string, unknown>;
		assert.deepEqual(out.models, { strong: "a" });
		assert.deepEqual(out.customProvider, { baseUrl: "http://localhost:11434" });
		assert.deepEqual(out.appearance, { fontFamily: "Lato" });
		assert.ok(!(remote.text("settings.json") ?? "").includes("customProvider"));
		// a device-only change is not a change
		b.write("settings.json", j({ ...out, appearance: { fontFamily: "Roboto" } }));
		assert.equal((await b.sync()).idle, true);
	});

	it("keeps the newer chat when both devices continued it, and saves the other as a conflict copy", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("chats/chat_1.json", j(chat({ messages: [m("m1")] })));
		await a.sync();
		await b.sync();
		a.write("chats/chat_1.json", j(chat({ updatedAt: "2026-02-01T00:00:00Z", messages: [m("m1"), m("from-a")] })));
		b.write("chats/chat_1.json", j(chat({ updatedAt: "2026-02-02T00:00:00Z", messages: [m("m1"), m("from-b")] })));
		await a.sync(); // a pushes first
		const r = await b.sync(); // b merges
		assert.equal(r.conflicts.length, 1);
		assert.deepEqual(ids(b.read("chats/chat_1.json")), ["m1", "from-b"]);
		const copy = path.join(b.syncDir, r.conflicts[0]?.copy ?? "");
		assert.deepEqual(ids(fs.readFileSync(copy, "utf8")), ["m1", "from-a"]);
		await a.sync();
		assert.deepEqual(ids(a.read("chats/chat_1.json")), ["m1", "from-b"], "the devices converge");
		assert.equal((await a.sync()).idle, true);
		assert.equal((await b.sync()).idle, true);
	});

	it("merges a chat both devices changed at the current schema version, and the next round is quiet", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("chats/chat_1.json", j(chat({ title: "Old", messages: [m("m1")] })));
		await a.sync();
		await b.sync();
		a.write("chats/chat_1.json", j(chat({ title: "Old", updatedAt: "2026-02-01T00:00:00Z", messages: [m("m1"), m("m2")] })));
		b.write("chats/chat_1.json", j(chat({ title: "Renamed", messages: [m("m1")] })));
		await a.sync();
		const r = await b.sync();
		assert.equal(r.skipped.length, 0, "not held back as written by a newer version");
		assert.deepEqual(r.merged, ["chats/chat_1.json"]);
		const merged = JSON.parse(b.read("chats/chat_1.json") ?? "{}") as { title: string; version: number };
		assert.equal(merged.title, "Renamed");
		assert.equal(merged.version, CURRENT_CHAT_VERSION);
		assert.deepEqual(ids(b.read("chats/chat_1.json")), ["m1", "m2"]);
		await a.sync();
		assert.equal(a.read("chats/chat_1.json"), b.read("chats/chat_1.json"), "the devices converge");
		assert.equal((await a.sync()).idle, true);
		assert.equal((await b.sync()).idle, true);
	});

	it("propagates a delete, removing the folders it leaves empty", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("sketches/chat_1/sk_1/strokes.json", "[]");
		a.write("sketches/chat_1/sk_1/0.svg", "<svg/>");
		await a.sync();
		await b.sync();
		assert.equal(b.read("sketches/chat_1/sk_1/0.svg"), "<svg/>");
		fs.rmSync(path.join(a.dataDir, "sketches"), { recursive: true });
		const r = await a.sync();
		assert.equal(r.deletedRemote.length, 2);
		const rb = await b.sync();
		assert.equal(rb.deletedLocal.length, 2);
		assert.equal(fs.existsSync(path.join(b.dataDir, "sketches/chat_1")), false);
	});

	it("keeps the edit when one device deleted a chat the other edited", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("chats/chat_1.json", j(chat({ messages: [m("m1")] })));
		await a.sync();
		await b.sync();
		fs.rmSync(path.join(a.dataDir, "chats/chat_1.json"));
		b.write("chats/chat_1.json", j(chat({ updatedAt: "2026-02-01T00:00:00Z", messages: [m("m1"), m("m2")] })));
		await b.sync(); // b pushes its edit
		const r = await a.sync(); // a deleted it, the repo has the edit
		assert.deepEqual(r.pulled, ["chats/chat_1.json"]);
		assert.deepEqual(ids(a.read("chats/chat_1.json")), ["m1", "m2"]);
		assert.match(r.notes.join(" "), /kept the edited copy/);
	});

	it("skips a file this device changed while the round was fetching, and picks it up next round", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("chats/chat_1.json", j(chat({ messages: [m("m1")] })));
		await a.sync();
		await b.sync();
		a.write("chats/chat_1.json", j(chat({ updatedAt: "2026-02-01T00:00:00Z", messages: [m("m1"), m("m2")] })));
		await a.sync();
		// b is about to pull m2; while it fetches, b's own server appends m3
		const during = j(chat({ updatedAt: "2026-02-02T00:00:00Z", messages: [m("m1"), m("m3")] }));
		remote.duringBlobs = () => b.write("chats/chat_1.json", during);
		const r = await b.sync();
		assert.equal(r.skipped.length, 1);
		assert.equal(b.read("chats/chat_1.json"), during, "the live write was not clobbered");
		const r2 = await b.sync();
		assert.equal(r2.skipped.length, 0);
		assert.deepEqual(ids(b.read("chats/chat_1.json")), ["m1", "m3"]);
	});

	it("holds back a course that is still being drafted, on either side, until it settles", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("courses/course_1.json", j({ id: "course_1", status: "drafting", version: 1 }));
		const r = await a.sync();
		assert.equal(r.skipped[0]?.path, "courses/course_1.json");
		assert.equal(remote.files.has("courses/course_1.json"), false, "a drafting course is not pushed");
		a.write("courses/course_1.json", j({ id: "course_1", status: "draft", version: 1 }));
		await a.sync();
		assert.equal(JSON.parse(b.read("courses/course_1.json") ?? "null"), null);
		await b.sync();
		assert.equal((JSON.parse(b.read("courses/course_1.json") ?? "{}") as { status: string }).status, "draft");
		// the other device starts drafting it again: that state is not pulled either
		remote.put("courses/course_1.json", j({ id: "course_1", status: "drafting", version: 1 }));
		remote.n++;
		const rb = await b.sync();
		assert.equal(rb.skipped[0]?.path, "courses/course_1.json");
		assert.equal((JSON.parse(b.read("courses/course_1.json") ?? "{}") as { status: string }).status, "draft");
	});

	it("leaves a file alone while this device is using it", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		a.write("chats/chat_1.json", j(chat({ messages: [m("m1")] })));
		await a.sync();
		const busy = await runSync({
			dataDir: b.dataDir,
			syncDir: b.syncDir,
			remote: remote as unknown as RemoteRepo,
			repoName: "me/sync",
			branch: "main",
			isBusy: (rel) => rel === "chats/chat_1.json",
		});
		assert.equal(busy.skipped[0]?.reason, "in use on this device right now");
		assert.equal(b.read("chats/chat_1.json"), null);
		assert.deepEqual((await b.sync()).pulled, ["chats/chat_1.json"], "the next round takes it");
	});

	it("never sends or removes a material that is still being read", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		const b = device(remote);
		const mat = (id: string, status: string) => ({ id, kind: "pdf", name: id, file: "source.pdf", bytes: 1, addedAt: "1", status });
		a.write("materials/chat_1/index.json", j([mat("m_done", "ready"), mat("m_busy", "reading")]));
		await a.sync();
		assert.deepEqual((JSON.parse(remote.text("materials/chat_1/index.json") ?? "[]") as { id: string }[]).map((x) => x.id), ["m_done"]);
		// b has its own reading item; pulling a's index keeps it
		b.write("materials/chat_1/index.json", j([mat("b_busy", "reading")]));
		await b.sync();
		const ids = (JSON.parse(b.read("materials/chat_1/index.json") ?? "[]") as { id: string }[]).map((x) => x.id);
		assert.deepEqual(ids.sort(), ["b_busy", "m_done"]);
		assert.equal((await b.sync()).idle, true);
	});

	it("restarts the round, never forcing, when the branch moved mid-push", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		a.write("chats/chat_1.json", j(chat({ messages: [m("m1")] })));
		remote.failPushes = 1;
		const r = await a.sync();
		assert.deepEqual(r.pushed, ["chats/chat_1.json"]);
		assert.equal(remote.pushes, 1);
	});

	it("gives up with the conflict error after repeated moves", async () => {
		const remote = new FakeRemote();
		const a = device(remote);
		a.write("chats/chat_1.json", j(chat({})));
		remote.failPushes = 5;
		await assert.rejects(a.sync(), (e: GitHubError) => e.code === "conflict");
	});
});
