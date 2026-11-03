import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { settingsStore } from "../store/settings.ts";
import { compactionInFlight } from "./compaction.ts";
import { keyValue } from "./keys.ts";
import type { AppliedChange } from "./sync/engine.ts";
import { createSyncService, type SyncConfig, type SyncService, type SyncStatus } from "./sync/service.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * GitHub sync wired into the app (fork addition, 2026-11-02): the one
 * SyncService of this server process (src/server/sync/service.ts), reading
 * its repo from settings.json (`sync.repo`, per device) and its token from the
 * key store (LH_GITHUB_SYNC_TOKEN), keeping its hands off a chat that is mid-
 * turn or mid-compaction, and telling open clients what a round changed.
 *
 * Started once per process from instrumentation.ts. LH_SYNC=0 turns the
 * background loop off (the manual button still works); it never starts under
 * test.
 */

export const SYNC_TOKEN_KEY = "LH_GITHUB_SYNC_TOKEN";

const KEY = Symbol.for("lh.syncService");

function readConfig(): SyncConfig {
	return { repo: settingsStore.readSettings()?.sync?.repo ?? null, token: keyValue(SYNC_TOKEN_KEY) ?? null };
}

/** A chat's turn, or its background compaction, rewrites the chat file asynchronously: leave it for a later round. */
export function isRepoPathBusy(rel: string): boolean {
	const m = /^chats\/([^/]+)\.json$/.exec(rel);
	if (!m) return false;
	const chatId = m[1] as string;
	return isTurnRunning(chatId) || compactionInFlight(chatId);
}

/** Tell the open views what a round wrote: the session list, an open chat, the course pages. */
export function announceApplied(changes: readonly AppliedChange[]): void {
	const chats = new Set<string>();
	let courses = false;
	for (const { path: rel } of changes) {
		const chat = /^(?:chats|sketches|materials)\/([^/.]+)(?:\.json|\/)/.exec(rel);
		if (chat) chats.add(chat[1] as string);
		if (rel.startsWith("courses/")) courses = true;
	}
	if (chats.size > 0) emit("chats-changed", {});
	for (const chatId of chats) emit("record-changed", { chatId });
	if (courses) emit("courses-changed", {});
}

/** The process-wide service. Next gives each route its own module instance in dev, so it lives on globalThis. */
export function getSyncService(): SyncService {
	const g = globalThis as Record<symbol, SyncService | undefined>;
	return (g[KEY] ??= createSyncService({
		dataDir: PATHS.data,
		syncDir: PATHS.sync,
		readConfig,
		isBusy: isRepoPathBusy,
		onApplied: announceApplied,
	}));
}

export function syncStatus(): SyncStatus {
	return getSyncService().status();
}

export function runSyncNow(): Promise<SyncStatus> {
	return getSyncService().syncNow();
}

/** Start the background loop (pull now, then every few minutes, push after quiet). Idempotent. */
export function startSyncLoop(): void {
	if (process.env.NODE_ENV === "test" || process.env.LH_SYNC === "0") return;
	getSyncService().start();
}
