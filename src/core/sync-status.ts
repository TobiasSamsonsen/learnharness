/**
 * GitHub sync, what the Settings screen shows (fork addition, 2026-11-02).
 * PURE, browser-safe: the status shape GET /api/sync returns, and the one
 * line that summarises it. The service that produces it is
 * src/server/sync/service.ts.
 */

/** The outcome of the last finished round, in counts. */
export interface SyncSummary {
	at: string;
	/** Nothing had changed on either side. */
	idle: boolean;
	pulled: number;
	pushed: number;
	merged: number;
	deleted: number;
	/** Merges where one version lost and was kept as a conflict copy. */
	conflicts: number;
	/** Files held back this round (still drafting, in use, changed meanwhile). */
	skipped: number;
	notes: string[];
	/** Set when this round was "replace this device with the repo". */
	replaced?: { written: number; removed: number; backup: string | null };
}

/** What "replace this device with the repo" would do, for the confirmation: counts by top-level folder. */
export interface ReplacePreview {
	/** Files that would be added or overwritten. */
	write: Record<string, number>;
	/** Files that exist only on this device and would be removed. */
	remove: Record<string, number>;
}

export interface SyncStatus {
	/** A valid repo and a token are both set. */
	configured: boolean;
	repo: string | null;
	/** A token is stored (the token itself never leaves the server). */
	hasToken: boolean;
	running: boolean;
	lastRunAt: string | null;
	lastOkAt: string | null;
	error: { code: string; message: string } | null;
	last: SyncSummary | null;
	skipped: { path: string; reason: string }[];
	/** Conflict copies saved (the version that lost a merge). */
	conflictCopies: number;
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The one status line under the Sync controls. */
export function syncStatusLine(s: SyncStatus | null): string {
	if (!s) return "Checking…";
	if (s.running) return "Syncing…";
	if (!s.repo && !s.hasToken) return "Not set up. Add a private repo and a token.";
	if (!s.repo) return "Add the repo to sync with.";
	if (!s.hasToken) return "Add a token to sync with.";
	if (!s.configured) return "The repo must look like owner/repo.";
	if (s.error) return s.error.message;
	if (!s.last || !s.lastOkAt) return "Ready. Not synced yet.";
	const when = clock(s.lastOkAt);
	if (s.last.replaced) {
		const r = s.last.replaced;
		return `Replaced from the repo ${when} · ${r.written} received · ${r.removed} removed`;
	}
	if (s.last.idle) return `Up to date · checked ${when}`;
	const parts = [
		s.last.pulled > 0 && `${s.last.pulled} received`,
		s.last.pushed > 0 && `${s.last.pushed} sent`,
		s.last.merged > 0 && `${s.last.merged} merged`,
		s.last.deleted > 0 && `${plural(s.last.deleted, "deletion")}`,
	].filter(Boolean);
	return `Synced ${when}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
}

const FOLDER_NOUN: Record<string, [string, string]> = {
	chats: ["chat", "chats"],
	courses: ["course", "courses"],
	sketches: ["sketch file", "sketch files"],
	graph: ["graph file", "graph files"],
	materials: ["material file", "material files"],
	prompts: ["prompt file", "prompt files"],
};

const countList = (by: Record<string, number>): string =>
	Object.entries(by)
		.map(([folder, n]) => {
			const [one, many] = FOLDER_NOUN[folder] ?? ["file", "files"];
			return `${n} ${n === 1 ? one : many}`;
		})
		.join(", ");

/** The two sentences of the "replace this device" confirmation: what would be removed, and what would be added or replaced. */
export function replacePreviewLines(p: ReplacePreview): { remove: string; write: string } {
	const removeAny = Object.keys(p.remove).length > 0;
	const writeAny = Object.keys(p.write).length > 0;
	return {
		remove: removeAny ? `Removed from this device (it is not in the repo): ${countList(p.remove)}.` : "Nothing on this device is missing from the repo, so nothing is removed.",
		write: writeAny ? `Added or replaced from the repo: ${countList(p.write)}.` : "This device already matches the repo.",
	};
}

/** Extra lines worth showing under the status: held-back files and kept conflict copies. Empty when there is nothing to say. */
export function syncNotes(s: SyncStatus | null): string[] {
	if (!s) return [];
	const out: string[] = [];
	if (s.last && s.last.skipped > 0) {
		out.push(`${plural(s.last.skipped, "item")} held back this time (still being drafted, in use, or changed meanwhile). They sync on a later round.`);
	}
	if (s.last?.replaced?.backup) {
		out.push(`What was replaced or removed is kept in the app's data folder under sync/${s.last.replaced.backup}. Delete it when you no longer need it.`);
	}
	if (s.conflictCopies > 0) {
		out.push(
			`${plural(s.conflictCopies, "older version")} kept after a clash between devices, in the app's data folder under sync/conflicts.`,
		);
	}
	return out;
}
