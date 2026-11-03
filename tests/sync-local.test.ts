/**
 * GitHub sync, the local half (src/server/sync/local.ts): git blob SHAs, the
 * scan of what a device would sync, and the manifest. Everything runs in a
 * tmp dir; the real profile is never touched.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { gitBlobSha, readManifest, scanLocal, writeManifest } from "../src/server/sync/local.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-local-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function put(root: string, rel: string, content: string | Uint8Array): void {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("gitBlobSha", () => {
	it("matches what `git hash-object` prints", () => {
		assert.equal(gitBlobSha(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
		assert.equal(gitBlobSha(new Uint8Array()), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	});
});

describe("scanLocal", () => {
	const data = path.join(TMP, "data");

	before(() => {
		put(data, "chats/chat_1.json", "{}\n");
		put(data, "courses/course_1.json", "{}\n");
		put(data, "graph/skills.jsonl", "");
		put(data, "settings.json", "{}\n");
		put(data, "prompts/teacher/style.md", "# style\n");
		put(data, "materials/chat_1/index.json", "[]\n");
		put(data, "materials/chat_1/mat_1/content.md", "text\n");
		put(data, "materials/chat_1/mat_1/source.pdf", "%PDF");
		// a drawn sketch: the PNG is a render, it must not travel
		put(data, "sketches/chat_1/sk_drawn/strokes.json", "[]");
		put(data, "sketches/chat_1/sk_drawn/0.svg", "<svg/>");
		put(data, "sketches/chat_1/sk_drawn/0.png", new Uint8Array([0x89, 0x50]));
		// a photo sketch: the PNG slot holds the camera's original, it must travel
		put(data, "sketches/chat_1/sk_photo/strokes.json", JSON.stringify({ producer: "photo" }));
		put(data, "sketches/chat_1/sk_photo/0.svg", "<svg/>");
		put(data, "sketches/chat_1/sk_photo/0.png", new Uint8Array([0xff, 0xd8, 0xff]));
		// never synced
		put(data, "models/stt/ggml-base.bin", "big");
		put(data, "jobs/job_1.json", "{}");
		put(data, "debug/x.jsonl", "");
		put(data, "sync/manifest.json", "{}");
		put(data, "chats/chat_1.json.tmp", "partial");
	});

	it("finds exactly the synced files, keyed by repo path", () => {
		assert.deepEqual(Object.keys(scanLocal(data)).sort(), [
			"chats/chat_1.json",
			"courses/course_1.json",
			"graph/skills.jsonl",
			"materials/chat_1/index.json",
			"materials/chat_1/mat_1/content.md",
			"prompts/teacher/style.md",
			"settings.json",
			"sketches/chat_1/sk_drawn/0.svg",
			"sketches/chat_1/sk_drawn/strokes.json",
			"sketches/chat_1/sk_photo/0.png",
			"sketches/chat_1/sk_photo/0.svg",
			"sketches/chat_1/sk_photo/strokes.json",
		]);
	});

	it("hashes content, so an edit changes the SHA", () => {
		const before = scanLocal(data)["chats/chat_1.json"];
		put(data, "chats/chat_1.json", '{"edited":true}\n');
		assert.notEqual(scanLocal(data)["chats/chat_1.json"], before);
	});

	it("hashes only the portable part of settings.json, so a device-only change is not a change", () => {
		const settings = (extra: object) => JSON.stringify({ version: 1, models: { strong: "a" }, ...extra });
		put(data, "settings.json", settings({ appearance: { fontFamily: "Inter" } }));
		const before = scanLocal(data)["settings.json"];
		put(data, "settings.json", settings({ appearance: { fontFamily: "Lato" }, customProvider: { baseUrl: "http://x" } }));
		assert.equal(scanLocal(data)["settings.json"], before);
		put(data, "settings.json", settings({ models: { strong: "b" } }));
		assert.notEqual(scanLocal(data)["settings.json"], before);
	});

	it("keeps graph's device-path files out of the scan", () => {
		put(data, "graph/sources.json", "{}");
		put(data, "graph/source-organization.json", "{}");
		put(data, "graph/sessions.jsonl", "");
		const keys = Object.keys(scanLocal(data));
		assert.ok(keys.includes("graph/skills.jsonl"));
		assert.ok(!keys.some((k) => /sources|source-organization|sessions/.test(k)));
	});

	it("reads an absent data dir as empty", () => {
		assert.deepEqual(scanLocal(path.join(TMP, "nope")), {});
	});
});

describe("manifest", () => {
	const dir = path.join(TMP, "sync");

	it("reads as a first sync when absent or corrupt", () => {
		assert.deepEqual(readManifest(dir, "o/r", "main"), { version: 1, repo: "o/r", branch: "main", commit: null, files: {} });
		put(dir, "manifest.json", "{not json");
		assert.deepEqual(readManifest(dir, "o/r", "main").files, {});
	});

	it("round-trips", () => {
		writeManifest(dir, { version: 1, repo: "o/r", branch: "main", commit: "abc", files: { "chats/a.json": "1" } });
		assert.deepEqual(readManifest(dir, "o/r", "main"), {
			version: 1,
			repo: "o/r",
			branch: "main",
			commit: "abc",
			files: { "chats/a.json": "1" },
		});
		assert.equal(fs.existsSync(path.join(dir, "manifest.json.tmp")), false);
	});

	it("is no base for a different repo or branch", () => {
		writeManifest(dir, { version: 1, repo: "o/r", branch: "main", commit: "abc", files: { "chats/a.json": "1" } });
		assert.deepEqual(readManifest(dir, "o/other", "main").files, {});
		assert.deepEqual(readManifest(dir, "o/r", "dev").files, {});
	});

	it("drops non-string entries from a hand-edited file", () => {
		put(dir, "manifest.json", JSON.stringify({ version: 1, repo: "o/r", branch: "main", commit: 5, files: { a: "1", b: 2 } }));
		const m = readManifest(dir, "o/r", "main");
		assert.deepEqual(m.files, { a: "1" });
		assert.equal(m.commit, null);
	});
});
