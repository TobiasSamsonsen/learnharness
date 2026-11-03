/**
 * GitHub sync, the pure half (src/core/sync-plan.ts): the three-way compare
 * and the scope rules. Pinned: no clocks, identical sides need nothing,
 * a first sync (empty base) merges rather than discards, a delete against a
 * change is a conflict, and only the learner's data is in scope.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeSyncPlan, ownedByApp, syncScope, type SyncAction } from "../src/core/sync-plan.ts";

const kinds = (actions: SyncAction[]) => Object.fromEntries(actions.map((a) => [a.path, a.kind]));

describe("computeSyncPlan", () => {
	it("lists nothing when nothing changed", () => {
		const same = { "chats/a.json": "1", "settings.json": "2" };
		assert.deepEqual(computeSyncPlan(same, same, same), []);
	});

	it("pushes a local edit and a local new file", () => {
		const plan = computeSyncPlan({ "chats/a.json": "1" }, { "chats/a.json": "2", "chats/b.json": "3" }, { "chats/a.json": "1" });
		assert.deepEqual(kinds(plan), { "chats/a.json": "push", "chats/b.json": "push" });
	});

	it("pulls a remote edit and a remote new file", () => {
		const plan = computeSyncPlan({ "chats/a.json": "1" }, { "chats/a.json": "1" }, { "chats/a.json": "2", "chats/b.json": "3" });
		assert.deepEqual(kinds(plan), { "chats/a.json": "pull", "chats/b.json": "pull" });
	});

	it("propagates a local delete to the repo and a remote delete to the device", () => {
		const base = { "chats/a.json": "1", "chats/b.json": "2" };
		const plan = computeSyncPlan(base, { "chats/b.json": "2" }, base);
		assert.deepEqual(kinds(plan), { "chats/a.json": "delete-remote" });
		const plan2 = computeSyncPlan(base, { "chats/a.json": "1", "chats/b.json": "2" }, { "chats/b.json": "2" });
		assert.deepEqual(kinds(plan2), { "chats/a.json": "delete-local" });
	});

	it("merges when both sides changed the same file differently", () => {
		const plan = computeSyncPlan({ "chats/a.json": "1" }, { "chats/a.json": "2" }, { "chats/a.json": "3" });
		assert.deepEqual(plan, [{ path: "chats/a.json", kind: "merge" }]);
	});

	it("settles, moving nothing, when both sides already agree", () => {
		assert.deepEqual(computeSyncPlan({ "chats/a.json": "1" }, { "chats/a.json": "2" }, { "chats/a.json": "2" }), [
			{ path: "chats/a.json", kind: "settled" },
		]);
		// both deleted it
		assert.deepEqual(computeSyncPlan({ "chats/a.json": "1" }, {}, {}), [{ path: "chats/a.json", kind: "settled" }]);
		// a first sync where both hold identical content
		assert.deepEqual(computeSyncPlan({}, { "chats/a.json": "1" }, { "chats/a.json": "1" }), [{ path: "chats/a.json", kind: "settled" }]);
	});

	it("flags a delete against a change as a conflict, naming who deleted", () => {
		const base = { "chats/a.json": "1" };
		assert.deepEqual(computeSyncPlan(base, {}, { "chats/a.json": "2" }), [
			{ path: "chats/a.json", kind: "conflict-delete", deleted: "local" },
		]);
		assert.deepEqual(computeSyncPlan(base, { "chats/a.json": "2" }, {}), [
			{ path: "chats/a.json", kind: "conflict-delete", deleted: "remote" },
		]);
	});

	it("treats a first sync (empty base) as: copy what is on one side, merge what differs", () => {
		const plan = computeSyncPlan(
			{},
			{ "chats/only-here.json": "1", "chats/both.json": "2" },
			{ "chats/only-there.json": "3", "chats/both.json": "4" },
		);
		assert.deepEqual(kinds(plan), {
			"chats/both.json": "merge",
			"chats/only-here.json": "push",
			"chats/only-there.json": "pull",
		});
	});

	it("is sorted by path, so runs are deterministic", () => {
		const plan = computeSyncPlan({}, { "chats/z.json": "1", "chats/a.json": "1", "chats/m.json": "1" }, {});
		assert.deepEqual(plan.map((a) => a.path), ["chats/a.json", "chats/m.json", "chats/z.json"]);
	});
});

describe("syncScope", () => {
	it("includes the learner's data", () => {
		for (const p of [
			"chats/chat_mvp8ug1f_f53c1f73.json",
			"courses/course_1.json",
			"graph/skills.jsonl",
			"graph/nodes.jsonl",
			"graph/chains.jsonl",
			"graph/coverage.jsonl",
			"graph/positions.json",
			"graph/render-settings.json",
			"graph/format.json",
			"sketches/chat_1/sk_1/strokes.json",
			"sketches/chat_1/sk_1/0.svg",
			"settings.json",
			"prompts/system-prompt.md",
			"prompts/teacher/style.md",
			"materials/chat_1/index.json",
			"materials/chat_1/mat_1/content.md",
		]) {
			assert.equal(syncScope(p), "include", p);
		}
	});

	it("marks a sketch page PNG for the photo check, not as included", () => {
		assert.equal(syncScope("sketches/chat_1/sk_1/0.png"), "sketch-png");
	});

	it("keeps models, jobs, secrets, material sources, debug output and sync bookkeeping out", () => {
		for (const p of [
			"models/stt/ggml-base.bin",
			"jobs/job_1.json",
			"auth.json",
			"chatgpt-credentials.json",
			"materials/chat_1/mat_1/source.pdf",
			"debug/provider-events/chat_1.jsonl",
			"sync/manifest.json",
			"graph/sources.json",
			"graph/source-organization.json",
			"graph/sessions.jsonl",
			"chats/nested/dir/x.json",
			"chats/x.json.tmp",
			"README.md",
			".learnharness-sync",
		]) {
			assert.equal(syncScope(p), "exclude", p);
		}
	});

	it("refuses anything that walks out of the folder", () => {
		assert.equal(syncScope("chats/../auth.json"), "exclude");
		assert.equal(syncScope("/etc/passwd"), "exclude");
	});
});

describe("ownedByApp", () => {
	it("drops files a person put in the repo, keeps the app's", () => {
		const out = ownedByApp({ "README.md": "x", ".learnharness-sync": "y", "chats/a.json": "1", "sketches/c/s/0.png": "2" });
		assert.deepEqual(Object.keys(out).sort(), ["chats/a.json", "sketches/c/s/0.png"]);
	});
});
