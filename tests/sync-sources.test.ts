/**
 * Syncing source files (owner, 2026-11-18): a per-device switch (settings.json sync.sources, default off). Off: the original
 * files of lesson and course sources stay on the device that added them. On: they travel like any synced file.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ownedByApp, syncScope } from "../src/core/sync-plan.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseSyncSettingsBody } from "../src/server/settings-body.ts";
import { runSync } from "../src/server/sync/engine.ts";
import { quickFingerprint, scanLocal } from "../src/server/sync/local.ts";
import type { RemoteRepo } from "../src/server/sync/github.ts";
import { FakeRemote } from "./sync-fake-remote.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-sources-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("the scope", () => {
	const sources = ["materials/course_1/mat_1/source.pdf", "materials/chat_1/mat_2/source.md", "materials/chat_1/mat_3/source.png"];

	it("source files stay on the device by default, and travel with the switch on", () => {
		for (const rel of sources) {
			assert.equal(syncScope(rel), "exclude", rel);
			assert.equal(syncScope(rel, {}), "exclude", rel);
			assert.equal(syncScope(rel, { sources: false }), "exclude", rel);
			assert.equal(syncScope(rel, { sources: true }), "include", rel);
		}
	});

	it("the switch opens nothing else: models, jobs, secrets, odd names and other files in a material's folder stay out", () => {
		for (const rel of [
			"models/big.bin", "jobs/job_1.json", "auth.json", "materials/chat_1/mat_1/profile.tmp", "materials/chat_1/mat_1/other.pdf",
			"materials/chat_1/source.pdf", "materials/chat_1/mat_1/sub/source.pdf", "materials/chat_1/mat_1/source.", "materials/../x/mat_1/source.pdf",
			"materials/chat_1/mat_1/source.toolongextension",
		]) {
			assert.equal(syncScope(rel, { sources: true }), "exclude", rel);
		}
	});

	it("the repo listing is cut the same way", () => {
		const listing = { "materials/c/m/source.pdf": 1, "materials/c/index.json": 2, "README.md": 3 };
		assert.deepEqual(Object.keys(ownedByApp(listing)), ["materials/c/index.json"]);
		assert.deepEqual(Object.keys(ownedByApp(listing, { sources: true })).sort(), ["materials/c/index.json", "materials/c/m/source.pdf"]);
	});
});

describe("the scan and the change detector", () => {
	it("list sources only with the switch on", () => {
		const data = path.join(TMP, "scan");
		fs.mkdirSync(path.join(data, "materials/course_1/mat_1"), { recursive: true });
		fs.writeFileSync(path.join(data, "materials/course_1/index.json"), "[]\n");
		fs.writeFileSync(path.join(data, "materials/course_1/mat_1/source.pdf"), "%PDF-1.4");
		assert.deepEqual(Object.keys(scanLocal(data)), ["materials/course_1/index.json"]);
		assert.deepEqual(Object.keys(scanLocal(data, { sources: true })).sort(), ["materials/course_1/index.json", "materials/course_1/mat_1/source.pdf"]);
		assert.notEqual(quickFingerprint(data), quickFingerprint(data, { sources: true }), "turning the switch on counts as a change, so a push follows");
	});
});

describe("the setting", () => {
	it("is stored per device, only when on, and survives a repo save", () => {
		assert.deepEqual(sanitizeUserSettings({ sync: { repo: "me/sync", sources: true } })?.sync, { repo: "me/sync", sources: true });
		assert.deepEqual(sanitizeUserSettings({ sync: { repo: "me/sync", sources: false } })?.sync, { repo: "me/sync" });
		assert.deepEqual(sanitizeUserSettings({ sync: { sources: "yes" } })?.sync, {});
		const parsed = parseSyncSettingsBody({ repo: "https://github.com/me/sync.git", sources: true });
		assert.deepEqual(parsed, { ok: true, settings: { repo: "me/sync", sources: true } });
		assert.deepEqual(parseSyncSettingsBody({ repo: "me/sync" }), { ok: true, settings: { repo: "me/sync" } });
		assert.deepEqual(parseSyncSettingsBody({ repo: "", sources: true }), { ok: true, settings: { sources: true } });
		assert.equal(parseSyncSettingsBody({ repo: "me/sync", sources: "yes" }).ok, false);
	});
});

describe("a round between two devices", () => {
	let n = 0;
	function device(remote: FakeRemote, sources: boolean) {
		const dataDir = path.join(TMP, `device-${n++}`, "data");
		fs.mkdirSync(dataDir, { recursive: true });
		return {
			dataDir,
			put(rel: string, content: string | Uint8Array) {
				const f = path.join(dataDir, rel);
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f, content);
			},
			has: (rel: string) => fs.existsSync(path.join(dataDir, rel)),
			bytes: (rel: string) => fs.readFileSync(path.join(dataDir, rel)),
			sync: () =>
				runSync({ dataDir, syncDir: path.join(dataDir, "sync"), remote: remote as unknown as RemoteRepo, repoName: "me/sync", branch: "main", scope: { sources }, now: () => new Date("2026-03-01T00:00:00Z") }),
		};
	}
	const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x10]); // binary, as a PDF is
	const index = JSON.stringify([{ id: "mat_1", kind: "pdf", name: "slides.pdf", file: "source.pdf", bytes: 8, addedAt: "2026-03-01T00:00:00Z", status: "ready", profile: "P" }], null, "\t") + "\n";

	it("with the switch on at both ends, the original file arrives byte for byte", async () => {
		const remote = new FakeRemote();
		const a = device(remote, true);
		const b = device(remote, true);
		a.put("materials/course_1/index.json", index);
		a.put("materials/course_1/mat_1/source.pdf", pdf);
		await a.sync();
		await b.sync();
		assert.ok(b.has("materials/course_1/mat_1/source.pdf"), "the original travelled");
		assert.deepEqual([...b.bytes("materials/course_1/mat_1/source.pdf")], [...pdf]);
	});

	it("with it off on the receiving device, only the summary arrives, and nothing there is deleted", async () => {
		const remote = new FakeRemote();
		const a = device(remote, true);
		const b = device(remote, false);
		a.put("materials/course_1/index.json", index);
		a.put("materials/course_1/mat_1/source.pdf", pdf);
		await a.sync();
		await b.sync();
		assert.ok(b.has("materials/course_1/index.json"), "the text summary travels");
		assert.equal(b.has("materials/course_1/mat_1/source.pdf"), false, "the original stays where it was added");
		b.put("materials/course_1/mat_9/source.pdf", pdf); // an original only on b, with the switch off: never uploaded, never touched
		await b.sync();
		assert.equal(b.has("materials/course_1/mat_9/source.pdf"), true);
		await a.sync();
		assert.equal(a.has("materials/course_1/mat_9/source.pdf"), false, "and it never reached the other device");
		assert.ok(a.has("materials/course_1/mat_1/source.pdf"), "a's own original is still there");
	});

	it("with it off on the sending device, nothing of the original is uploaded", async () => {
		const remote = new FakeRemote();
		const a = device(remote, false);
		a.put("materials/course_1/index.json", index);
		a.put("materials/course_1/mat_1/source.pdf", pdf);
		await a.sync();
		const b = device(remote, true);
		await b.sync();
		assert.equal(b.has("materials/course_1/mat_1/source.pdf"), false);
	});
});
