/**
 * "Replace this device with the repo" (src/server/sync/engine.ts runReplace and
 * the service's previewReplace / replaceFromRepo). Pinned: nothing is pushed;
 * files only here are removed, differing ones replaced, repo-only ones added;
 * everything replaced or removed is copied to sync/replaced-<time> first; a
 * network failure before the apply leaves the device exactly as it was; an
 * empty repo is refused; a chat in use, a course still drafting and a file that
 * changed meanwhile are skipped; device-only settings and a still-reading
 * material stay; the next normal round starts from the repo's state.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ReplaceRefused, runReplace, runSync } from "../src/server/sync/engine.ts";
import { GitHubError, type RemoteRepo } from "../src/server/sync/github.ts";
import { createSyncService } from "../src/server/sync/service.ts";
import { FakeRemote } from "./sync-fake-remote.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-replace-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function device(remote: FakeRemote, isBusy?: (rel: string) => boolean) {
	const dataDir = path.join(TMP, `d${n++}`, "data");
	const syncDir = path.join(dataDir, "sync");
	fs.mkdirSync(dataDir, { recursive: true });
	const deps = { dataDir, syncDir, remote: remote as unknown as RemoteRepo, repoName: "me/sync", branch: "main", now: () => new Date("2026-03-01T00:00:00Z"), isBusy };
	return {
		dataDir,
		syncDir,
		deps,
		w(rel: string, content: string | Uint8Array) {
			const f = path.join(dataDir, rel);
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, content);
		},
		r(rel: string): string | null {
			try {
				return fs.readFileSync(path.join(dataDir, rel), "utf8");
			} catch {
				return null;
			}
		},
		exists: (rel: string) => fs.existsSync(path.join(dataDir, rel)),
		sync: () => runSync(deps),
		replace: (opts?: { dryRun?: boolean }) => runReplace(deps, opts),
	};
}

const j = (v: unknown) => JSON.stringify(v, null, "\t");
const chat = (id: string, over: Record<string, unknown> = {}) => ({ id, title: id, createdAt: "1", updatedAt: "2026-01-01T00:00:00Z", messages: [], version: 1, ...over });

/** A repo holding what device "source" pushed, so a second device can be replaced from it. */
async function seeded() {
	const remote = new FakeRemote();
	const src = device(remote);
	src.w("chats/keep.json", j(chat("keep", { title: "repo version" })));
	src.w("chats/repo_only.json", j(chat("repo_only")));
	src.w("courses/course_1.json", j({ id: "course_1", status: "active", version: 1 }));
	src.w("settings.json", j({ version: 1, models: { strong: "from-repo" } }));
	await src.sync();
	return { remote, src };
}

describe("runReplace", () => {
	it("makes the device's synced data the repo's, pushes nothing, and keeps a backup of what it replaced or removed", async () => {
		const { remote } = await seeded();
		const pushesBefore = remote.pushes;
		const b = device(remote);
		b.w("chats/keep.json", j(chat("keep", { title: "my local edit" }))); // differs: overwritten
		b.w("chats/only_here.json", j(chat("only_here"))); // only here: removed
		b.w("sketches/c/sk/strokes.json", "[]"); // only here: removed (with its folder)
		b.w("sketches/c/sk/0.svg", "<svg/>");
		b.w("settings.json", j({ version: 1, models: { strong: "mine" }, customProvider: { baseUrl: "http://localhost:11434" }, appearance: { fontFamily: "Lato" } }));
		b.w("models/big.bin", "device-only data");

		const r = await b.replace();
		assert.equal(remote.pushes, pushesBefore, "nothing was pushed");
		assert.equal(JSON.parse(b.r("chats/keep.json") ?? "{}").title, "repo version");
		assert.ok(b.exists("chats/repo_only.json"), "a repo-only chat was added");
		assert.ok(b.exists("courses/course_1.json"));
		assert.equal(b.exists("chats/only_here.json"), false, "a device-only chat was removed");
		assert.equal(b.exists("sketches/c"), false, "its empty folders went too");
		const settings = JSON.parse(b.r("settings.json") ?? "{}");
		assert.equal(settings.models.strong, "from-repo", "the shared settings were replaced");
		assert.equal(settings.customProvider.baseUrl, "http://localhost:11434", "device-only settings stayed");
		assert.equal(settings.appearance.fontFamily, "Lato");
		assert.equal(b.r("models/big.bin"), "device-only data", "never-synced data stayed");

		assert.ok(r.backup, "a backup folder was reported");
		const kept = (rel: string) => fs.readFileSync(path.join(b.syncDir, r.backup as string, rel), "utf8");
		assert.equal(JSON.parse(kept("chats/keep.json")).title, "my local edit", "the overwritten file was kept");
		assert.ok(kept("chats/only_here.json").includes("only_here"), "the removed file was kept");
		assert.ok(kept("sketches/c/sk/0.svg").includes("<svg"), "removed sketch files were kept");
		assert.equal(JSON.parse(kept("settings.json")).customProvider.baseUrl, "http://localhost:11434", "the whole old settings file was kept");
		assert.deepEqual(r.counts.remove, { chats: 1, sketches: 2 });
		assert.ok(r.counts.write.chats === 2 && r.counts.write.courses === 1);
	});

	it("starts the next normal round from the repo's state: idle, and the removed files are not pushed back", async () => {
		const { remote } = await seeded();
		const b = device(remote);
		b.w("chats/only_here.json", j(chat("only_here")));
		await b.replace();
		const pushes = remote.pushes;
		const next = await b.sync();
		assert.equal(next.idle, true);
		assert.equal(remote.pushes, pushes);
		assert.equal(remote.files.has("chats/only_here.json"), false);
	});

	it("counts without changing anything on a dry run", async () => {
		const { remote } = await seeded();
		const b = device(remote);
		b.w("chats/only_here.json", j(chat("only_here")));
		const r = await b.replace({ dryRun: true });
		assert.deepEqual(r.counts.remove, { chats: 1 });
		assert.equal(r.backup, null);
		assert.ok(b.exists("chats/only_here.json"), "nothing was removed");
		assert.equal(b.exists("chats/repo_only.json"), false, "nothing was added");
		assert.equal(b.exists("sync/manifest.json"), false);
	});

	it("refuses an empty repo, so it can never wipe a device for nothing", async () => {
		const remote = new FakeRemote();
		const b = device(remote);
		b.w("chats/mine.json", j(chat("mine")));
		await assert.rejects(b.replace(), (e: Error) => e instanceof ReplaceRefused);
		remote.put("README.md", "only a person's file"); // not the app's data either
		remote.n = 1;
		await assert.rejects(b.replace(), (e: Error) => e instanceof ReplaceRefused);
		assert.ok(b.exists("chats/mine.json"));
	});

	it("leaves the device exactly as it was when the repo cannot be read", async () => {
		const { remote } = await seeded();
		const b = device(remote);
		b.w("chats/only_here.json", j(chat("only_here")));
		const real = remote.blobs.bind(remote);
		remote.blobs = async () => {
			throw new GitHubError("Cannot reach GitHub", "network");
		};
		await assert.rejects(b.replace(), (e: GitHubError) => e.code === "network");
		remote.blobs = real;
		assert.ok(b.exists("chats/only_here.json"), "nothing was removed");
		assert.equal(b.exists("chats/repo_only.json"), false, "nothing was added");
		const kept = fs.existsSync(b.syncDir) ? fs.readdirSync(b.syncDir) : [];
		assert.equal(kept.some((name) => name.startsWith("replaced-")), false, "no backup folder either");
	});

	it("skips a chat in use, a course still drafting, and a file that changed while it fetched", async () => {
		const { remote } = await seeded();
		const b = device(remote, (rel) => rel === "chats/keep.json");
		b.w("chats/keep.json", j(chat("keep", { title: "in use" })));
		b.w("courses/course_1.json", j({ id: "course_1", status: "drafting", version: 1 }));
		b.w("chats/only_here.json", j(chat("only_here")));
		remote.duringBlobs = () => b.w("chats/only_here.json", j(chat("only_here", { title: "written meanwhile" })));
		const r = await b.replace();
		const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
		assert.equal(reasons["chats/keep.json"], "in use on this device right now");
		assert.equal(reasons["courses/course_1.json"], "still being drafted on a device");
		assert.equal(reasons["chats/only_here.json"], "changed on this device while replacing");
		assert.equal(JSON.parse(b.r("chats/keep.json") ?? "{}").title, "in use", "the busy chat was not touched");
		assert.ok(b.exists("chats/only_here.json"));
		assert.ok(b.exists("chats/repo_only.json"), "everything else was applied");
	});

	it("keeps this device's own still-reading material while removing the rest of a local-only index", async () => {
		const remote = new FakeRemote();
		const src = device(remote);
		src.w("chats/c.json", j(chat("c")));
		await src.sync();
		const b = device(remote);
		const mat = (id: string, status: string) => ({ id, kind: "pdf", name: id, file: "source.pdf", bytes: 1, addedAt: "1", status });
		b.w("materials/chat_1/index.json", j([mat("done", "ready"), mat("busy", "reading")]));
		await b.replace();
		const ids = (JSON.parse(b.r("materials/chat_1/index.json") ?? "[]") as { id: string }[]).map((m) => m.id);
		assert.deepEqual(ids, ["busy"]);
	});
});

describe("the service's replace", () => {
	function service(remote: FakeRemote, dataDir: string) {
		return createSyncService({
			dataDir,
			syncDir: path.join(dataDir, "sync"),
			readConfig: () => ({ repo: "me/sync", token: "tok" }),
			makeRemote: () => remote as unknown as RemoteRepo,
			now: () => new Date("2026-03-01T00:00:00Z"),
		});
	}

	it("previews, then replaces, and reports what it did and where the backup is", async () => {
		const { remote } = await seeded();
		const b = device(remote);
		b.w("chats/only_here.json", j(chat("only_here")));
		const svc = service(remote, b.dataDir);
		const p = await svc.previewReplace();
		assert.equal(p.error, null);
		assert.deepEqual(p.preview?.remove, { chats: 1 });
		const st = await svc.replaceFromRepo();
		assert.equal(st.error, null);
		assert.equal(st.last?.replaced?.removed, 1);
		assert.ok((st.last?.replaced?.written ?? 0) >= 3);
		assert.match(st.last?.replaced?.backup ?? "", /^replaced-2026-03-01T/);
		assert.equal(st.last?.idle, false);
	});

	it("explains an empty repo instead of crashing", async () => {
		const b = device(new FakeRemote());
		const svc = service(new FakeRemote(), b.dataDir);
		const p = await svc.previewReplace();
		assert.equal(p.preview, null);
		assert.equal(p.error?.code, "empty-repo");
		const st = await svc.replaceFromRepo();
		assert.equal(st.error?.code, "empty-repo");
	});

	it("refuses a public repo, like any round", async () => {
		const remote = new FakeRemote();
		remote.isPrivate = false;
		const b = device(remote);
		const st = await service(remote, b.dataDir).replaceFromRepo();
		assert.equal(st.error?.code, "public-repo");
	});

	it("will not start while a round is running", async () => {
		const { remote } = await seeded();
		const b = device(remote);
		const svc = service(remote, b.dataDir);
		const running = svc.syncNow();
		const st = await svc.replaceFromRepo();
		assert.equal(st.error?.code, "busy");
		await running;
	});
});
