/**
 * The server copy of unsent ink (owner plan, 2026-11-15): saved, read back, deleted, pruned by age, and keyed safely.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-drafts-"));
process.env.LH_DATA_DIR = dir;
const { saveInkDraft, readInkDraft, deleteInkDraft, pruneInkDrafts, INK_DRAFT_MAX_BYTES } = await import("../src/store/ink-drafts.ts");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("ink drafts on disk", () => {
	it("round-trips a draft and deletes it", () => {
		saveInkDraft("toolu_abc-1", "[1,2]");
		assert.equal(readInkDraft("toolu_abc-1"), "[1,2]");
		saveInkDraft("toolu_abc-1", "[3]");
		assert.equal(readInkDraft("toolu_abc-1"), "[3]", "the newest write replaces it");
		deleteInkDraft("toolu_abc-1");
		assert.equal(readInkDraft("toolu_abc-1"), null);
		deleteInkDraft("toolu_abc-1"); // a second delete is harmless
	});

	it("refuses unsafe keys and oversize drafts", () => {
		assert.throws(() => saveInkDraft("../escape", "[]"));
		assert.throws(() => saveInkDraft("a/b", "[]"));
		assert.equal(readInkDraft("../escape"), null);
		assert.throws(() => saveInkDraft("big", "x".repeat(INK_DRAFT_MAX_BYTES + 1)));
	});

	it("prunes drafts older than the age limit and keeps newer ones", () => {
		saveInkDraft("old", "[1]");
		saveInkDraft("new", "[2]");
		const file = path.join(dir, "ink-drafts", "old.json");
		const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
		fs.utimesSync(file, past, past);
		pruneInkDrafts(Date.now(), 30 * 24 * 3600 * 1000 - 1);
		assert.equal(readInkDraft("old"), null);
		assert.equal(readInkDraft("new"), "[2]");
	});
});
