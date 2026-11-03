/**
 * GitHub sync wired into the app (src/server/sync-service.ts): which chats it
 * will not touch, what it tells open views after a round, and that the
 * background loop stays off under test. The data dir is isolated before any
 * server module loads.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-wiring-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { subscribe } = await import("../src/core/events.ts");
const { announceApplied, getSyncService, isRepoPathBusy, startSyncLoop, syncStatus } = await import("../src/server/sync-service.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function collect(run: () => void): { type: string; chatId?: string }[] {
	const seen: { type: string; chatId?: string }[] = [];
	const off = subscribe((e) => seen.push({ type: e.type, ...("chatId" in e ? { chatId: e.chatId } : {}) }));
	try {
		run();
	} finally {
		off();
	}
	return seen;
}

describe("isRepoPathBusy", () => {
	it("holds back a chat that is mid-turn, and only that chat", () => {
		assert.equal(beginTurn("chat_busy"), true);
		try {
			assert.equal(isRepoPathBusy("chats/chat_busy.json"), true);
			assert.equal(isRepoPathBusy("chats/chat_other.json"), false);
			assert.equal(isRepoPathBusy("courses/course_1.json"), false);
			assert.equal(isRepoPathBusy("sketches/chat_busy/sk_1/0.svg"), false);
		} finally {
			endTurn("chat_busy");
		}
		assert.equal(isRepoPathBusy("chats/chat_busy.json"), false);
	});
});

describe("announceApplied", () => {
	it("refreshes the list and each changed chat once", () => {
		const seen = collect(() =>
			announceApplied([
				{ path: "chats/chat_a.json", kind: "written" },
				{ path: "sketches/chat_a/sk_1/0.svg", kind: "written" },
				{ path: "materials/chat_b/index.json", kind: "written" },
				{ path: "chats/chat_c.json", kind: "removed" },
			]),
		);
		assert.equal(seen.filter((e) => e.type === "chats-changed").length, 1);
		assert.deepEqual(
			seen.filter((e) => e.type === "record-changed").map((e) => e.chatId).sort(),
			["chat_a", "chat_b", "chat_c"],
		);
	});

	it("refreshes course pages when a course changed", () => {
		const seen = collect(() => announceApplied([{ path: "courses/course_1.json", kind: "written" }]));
		assert.deepEqual(seen.map((e) => e.type), ["courses-changed"]);
	});

	it("says nothing for files no open view shows", () => {
		assert.deepEqual(collect(() => announceApplied([{ path: "graph/nodes.jsonl", kind: "written" }, { path: "settings.json", kind: "written" }])), []);
	});
});

describe("the service", () => {
	it("is one per process and reports an unconfigured status", () => {
		assert.equal(getSyncService(), getSyncService());
		const s = syncStatus();
		assert.equal(s.configured, false);
		assert.equal(s.running, false);
		assert.equal(s.hasToken, false);
	});

	it("does not start its loop under test", () => {
		startSyncLoop();
		assert.equal(syncStatus().lastRunAt, null);
	});
});
