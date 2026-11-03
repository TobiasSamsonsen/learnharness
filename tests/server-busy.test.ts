/**
 * Is the server busy? (src/server/busy.ts, GET /api/busy.) The Android app rests an unused server on this: the wake lock goes after
 * 10 idle minutes and the service stops after 45. Pinned: an idle server says so; each kind of work in progress makes it busy and
 * stops doing so when it ends; a leaked turn entry stops counting after its limit; a steer parked until a learner run is not work;
 * a process kept warm is not work. The data dir is isolated before any server module loads.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-busy-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { serverBusy } = await import("../src/server/busy.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { registerJobAbort, unregisterJobAbort } = await import("../src/agent/subagents/aborts.ts");
const { bgLlmSlots } = await import("../src/agent/subagents/bg-llm-semaphore.ts");
const { GET } = await import("../app/api/busy/route.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

type G = typeof globalThis & Record<string | symbol, unknown>;
const g = globalThis as G;

/** Put every registry back to empty between tests. */
beforeEach(() => {
	(g.__lhTurnRegistry as Map<string, number> | undefined)?.clear();
	(g.__lhJobAborts as Map<string, unknown> | undefined)?.clear();
	(g[Symbol.for("lh.courseDraftRuns")] as Map<string, unknown> | undefined)?.clear();
	(g[Symbol.for("lh.materialRuns")] as Map<string, unknown> | undefined)?.clear();
	(g.__lhCompaction as { inFlight: Map<string, unknown> } | undefined)?.inFlight.clear();
	const wake = g.__lhWakePipeline as { queues: Map<string, unknown>; userSteers: Map<string, unknown>; liveAgents: Map<string, unknown>; pumping: Set<string> } | undefined;
	wake?.queues.clear();
	wake?.userSteers.clear();
	wake?.liveAgents.clear();
	wake?.pumping.clear();
	bgLlmSlots().active = 0;
	bgLlmSlots().queue.length = 0;
});

describe("serverBusy", () => {
	it("says idle when nothing is happening", () => {
		assert.deepEqual(serverBusy(), { busy: false, reasons: [] });
	});

	it("is busy while a chat turn runs, and idle again when it ends", () => {
		assert.equal(beginTurn("chat_a"), true);
		assert.deepEqual(serverBusy(), { busy: true, reasons: ["a chat turn is running"] });
		endTurn("chat_a");
		assert.equal(serverBusy().busy, false);
	});

	it("stops counting a turn entry that outlived its limit (a leak), and counts a fresh one", () => {
		beginTurn("chat_old");
		const registry = g.__lhTurnRegistry as Map<string, number>;
		registry.set("chat_old", Date.now() - 31 * 60_000);
		assert.equal(serverBusy().busy, false);
		assert.equal(registry.has("chat_old"), false, "the stale entry was dropped");
		registry.set("chat_new", Date.now() - 5 * 60_000);
		assert.equal(serverBusy().busy, true);
	});

	it("is busy while a background job loop executes", () => {
		registerJobAbort("job_1", new AbortController());
		assert.deepEqual(serverBusy().reasons, ["a background job is running"]);
		unregisterJobAbort("job_1");
		assert.equal(serverBusy().busy, false);
	});

	it("is busy during a compaction, a course draft, a material read and a background model call", () => {
		(g.__lhCompaction ??= { inFlight: new Map() });
		(g.__lhCompaction as { inFlight: Map<string, Promise<void>> }).inFlight.set("chat_a", new Promise(() => {}));
		assert.deepEqual(serverBusy().reasons, ["a compaction is running"]);
		(g.__lhCompaction as { inFlight: Map<string, unknown> }).inFlight.clear();

		const drafts = (g[Symbol.for("lh.courseDraftRuns")] ??= new Map()) as Map<string, AbortController>;
		drafts.set("course_1", new AbortController());
		assert.deepEqual(serverBusy().reasons, ["a course is being drafted"]);
		drafts.clear();

		const reads = (g[Symbol.for("lh.materialRuns")] ??= new Map()) as Map<string, unknown>;
		reads.set("chat_a/mat_1", { promise: Promise.resolve(), controller: new AbortController() });
		assert.deepEqual(serverBusy().reasons, ["a material is being read"]);
		reads.clear();

		bgLlmSlots().active = 1;
		assert.deepEqual(serverBusy().reasons, ["a background model call is running"]);
		bgLlmSlots().active = 0;
		bgLlmSlots().queue.push({ resolve: () => {}, dead: false });
		assert.equal(serverBusy().busy, true, "a queued call is work too");
	});

	it("counts a job result being delivered, but not a steer parked until a learner run", () => {
		const wake = (g.__lhWakePipeline ??= { queues: new Map(), liveAgents: new Map(), userSteers: new Map(), pumping: new Set(), lastSweepAt: 0, automaticDeferred: new WeakSet() }) as {
			queues: Map<string, { deferred?: boolean }[]>;
			pumping: Set<string>;
		};
		wake.queues.set("chat_a", [{ deferred: true }]);
		assert.equal(serverBusy().busy, false, "a deferred steer waits for a learner run, not a timer");
		wake.queues.set("chat_a", [{ deferred: true }, {}]);
		assert.deepEqual(serverBusy().reasons, ["a job result is being delivered"]);
		wake.queues.clear();
		wake.pumping.add("chat_a");
		assert.equal(serverBusy().busy, true);
	});

	it("lists every kind of work at once", () => {
		beginTurn("chat_a");
		registerJobAbort("job_1", new AbortController());
		bgLlmSlots().active = 2;
		assert.deepEqual(serverBusy().reasons, ["a chat turn is running", "a background job is running", "a background model call is running"]);
		endTurn("chat_a");
	});
});

describe("GET /api/busy", () => {
	it("answers with the report as JSON, the shape the Android app reads", async () => {
		const res = await GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { busy: false, reasons: [] });
		beginTurn("chat_a");
		const busy = (await (await GET()).json()) as { busy: boolean };
		assert.equal(busy.busy, true);
		endTurn("chat_a");
	});
});
