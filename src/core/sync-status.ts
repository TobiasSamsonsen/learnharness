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
	if (s.last.idle) return `Up to date · checked ${when}`;
	const parts = [
		s.last.pulled > 0 && `${s.last.pulled} received`,
		s.last.pushed > 0 && `${s.last.pushed} sent`,
		s.last.merged > 0 && `${s.last.merged} merged`,
		s.last.deleted > 0 && `${plural(s.last.deleted, "deletion")}`,
	].filter(Boolean);
	return `Synced ${when}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
}

/** Extra lines worth showing under the status: held-back files and kept conflict copies. Empty when there is nothing to say. */
export function syncNotes(s: SyncStatus | null): string[] {
	if (!s) return [];
	const out: string[] = [];
	if (s.last && s.last.skipped > 0) {
		out.push(`${plural(s.last.skipped, "item")} held back this time (still being drafted, in use, or changed meanwhile). They sync on a later round.`);
	}
	if (s.conflictCopies > 0) {
		out.push(
			`${plural(s.conflictCopies, "older version")} kept after a clash between devices, in the app's data folder under sync/conflicts.`,
		);
	}
	return out;
}
