import { liveJobCount } from "../agent/subagents/aborts.ts";
import { bgLlmSlots } from "../agent/subagents/bg-llm-semaphore.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { compactionsInFlight } from "./compaction.ts";
import { courseDraftCount } from "./courses.ts";
import { wakeWorkCount } from "./jobs.ts";
import { materialRunCount } from "./materials.ts";
import { syncStatus } from "./sync-service.ts";
import { turnsInFlight } from "./turn-liveness.ts";

/**
 * Is the server doing work nobody is watching? (fork addition, 2026-11-03.) The Android app asks this (GET /api/busy) to decide
 * when an unused server may drop its wake lock (10 minutes) and stop (30): see android/.../ServerService.kt and IdlePolicy.
 *
 * Busy means WORK IN PROGRESS: a chat turn, a compaction, a background job or the delivery of its result, graph extraction, a course
 * being drafted, a material being read, any background model call, a sync round. It is deliberately NOT "someone has the page
 * open" (the app reports that itself) and NOT a process kept warm for reuse (an idle Claude Code process, a loaded dictation model).
 * Short user-driven requests (dictation, a sketch render) happen while the app is on screen, so they need no entry here.
 *
 * The caller needs ten unbroken idle minutes before it acts, so a moment between two steps of a pipeline cannot stop anything.
 */
export interface BusyReport {
	busy: boolean;
	/** One short phrase per kind of work in progress, for the log and for tests. */
	reasons: string[];
}

export function serverBusy(): BusyReport {
	const slots = bgLlmSlots();
	const work: [string, number][] = [
		["a chat turn is running", turnsInFlight()],
		["a compaction is running", compactionsInFlight()],
		["a background job is running", liveJobCount()],
		["a job result is being delivered", wakeWorkCount()],
		["graph extraction is running", extractionStatuses().length],
		["a course is being drafted", courseDraftCount()],
		["a material is being read", materialRunCount()],
		["a background model call is running", slots.active + slots.queue.length],
		["a sync round is running", syncStatus().running ? 1 : 0],
	];
	const reasons = work.filter(([, n]) => n > 0).map(([why]) => why);
	return { busy: reasons.length > 0, reasons };
}
