/**
 * GitHub sync, the Settings status line (src/core/sync-status.ts): one
 * sentence for every state the screen can be in, and the extra notes about
 * held-back files and kept conflict copies.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replacePreviewLines, syncNotes, syncStatusLine, type SyncStatus } from "../src/core/index.ts";

const base: SyncStatus = {
	configured: true,
	repo: "me/sync",
	hasToken: true,
	running: false,
	lastRunAt: null,
	lastOkAt: null,
	error: null,
	last: null,
	skipped: [],
	conflictCopies: 0,
};
const done = (over: Partial<NonNullable<SyncStatus["last"]>>): SyncStatus => ({
	...base,
	lastRunAt: "2026-03-01T14:02:00",
	lastOkAt: "2026-03-01T14:02:00",
	last: { at: "2026-03-01T14:02:00", idle: false, pulled: 0, pushed: 0, merged: 0, deleted: 0, conflicts: 0, skipped: 0, notes: [], ...over },
});

describe("syncStatusLine", () => {
	it("says what is missing before anything is set up", () => {
		assert.equal(syncStatusLine(null), "Checking…");
		assert.match(syncStatusLine({ ...base, repo: null, hasToken: false, configured: false }), /Not set up/);
		assert.equal(syncStatusLine({ ...base, repo: null, configured: false }), "Add the repo to sync with.");
		assert.equal(syncStatusLine({ ...base, hasToken: false, configured: false }), "Add a token to sync with.");
		assert.match(syncStatusLine({ ...base, repo: "nope", configured: false }), /owner\/repo/);
	});

	it("shows a round in progress, ahead of everything else", () => {
		assert.equal(syncStatusLine({ ...base, running: true, error: { code: "auth", message: "x" } }), "Syncing…");
	});

	it("shows the error in the repo's own words", () => {
		assert.equal(syncStatusLine({ ...base, error: { code: "auth", message: "GitHub refused the token." } }), "GitHub refused the token.");
	});

	it("is ready, not synced, before the first round", () => {
		assert.equal(syncStatusLine(base), "Ready. Not synced yet.");
	});

	it("reports what moved, and says up to date when nothing did", () => {
		assert.match(syncStatusLine(done({ idle: true })), /^Up to date · checked /);
		const line = syncStatusLine(done({ pulled: 3, pushed: 2, merged: 1, deleted: 1 }));
		assert.match(line, /^Synced .* · 3 received · 2 sent · 1 merged · 1 deletion$/);
		assert.match(syncStatusLine(done({ deleted: 2 })), /2 deletions$/);
		assert.match(syncStatusLine(done({})), /^Synced \S+$/);
	});
});

describe("replace", () => {
	const replaced = (over: { backup: string | null }): SyncStatus =>
		done({ replaced: { written: 5, removed: 2, backup: over.backup } });

	it("reads as a replace in the status line", () => {
		assert.match(syncStatusLine(replaced({ backup: "replaced-x" })), /^Replaced from the repo .* · 5 received · 2 removed$/);
	});

	it("says where the backup is, and nothing when there is none", () => {
		assert.match(syncNotes(replaced({ backup: "replaced-2026-03-01T10-00-00-000Z" }))[0] ?? "", /sync\/replaced-2026-03-01T10-00-00-000Z/);
		assert.deepEqual(syncNotes(replaced({ backup: null })), []);
	});

	it("words the confirmation with counts by kind", () => {
		const both = replacePreviewLines({ remove: { chats: 12, courses: 1, sketches: 3 }, write: { chats: 40, graph: 2 } });
		assert.equal(both.remove, "Removed from this device (it is not in the repo): 12 chats, 1 course, 3 sketch files.");
		assert.equal(both.write, "Added or replaced from the repo: 40 chats, 2 graph files.");
		const none = replacePreviewLines({ remove: {}, write: {} });
		assert.match(none.remove, /Nothing on this device is missing/);
		assert.equal(none.write, "This device already matches the repo.");
	});
});

describe("syncNotes", () => {
	it("is empty when there is nothing to add", () => {
		assert.deepEqual(syncNotes(null), []);
		assert.deepEqual(syncNotes(done({})), []);
	});

	it("explains held-back items and kept conflict copies", () => {
		const notes = syncNotes({ ...done({ skipped: 2 }), conflictCopies: 1 });
		assert.equal(notes.length, 2);
		assert.match(notes[0] ?? "", /2 items held back/);
		assert.match(notes[1] ?? "", /1 older version kept/);
		assert.match(syncNotes({ ...done({ skipped: 1 }) })[0] ?? "", /1 item held back/);
	});
});
