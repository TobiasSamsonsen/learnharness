import * as fs from "node:fs";
import * as path from "node:path";
import type { SyncStatus, SyncSummary } from "../../core/sync-status.ts";
import { runSync, type AppliedChange, type SyncReport } from "./engine.ts";
import { GitHubError, GitHubRepo, type RemoteRepo } from "./github.ts";
import { quickFingerprint } from "./local.ts";

/**
 * GitHub sync, the service (fork addition, 2026-11-02): one object per server
 * process that runs the engine (engine.ts) when the learner asks, when the
 * server starts, every few minutes, and shortly after local data stops
 * changing. It owns nothing durable: the manifest and the conflict copies
 * live in the sync dir, the token and repo name come from `readConfig`.
 *
 * Rules it keeps:
 *   - ONE round at a time; a second request joins the one in flight.
 *   - Never throws: a failed round becomes `status().error`.
 *   - A bad token, a missing repo or a public repo stops the AUTOMATIC rounds
 *     until the configuration changes (retrying every few minutes would only
 *     hammer GitHub); the manual button always tries.
 *   - A rate limit pauses automatic rounds until GitHub says it lifts.
 *   - It refuses a PUBLIC repo: chats are personal (owner decision,
 *     2026-11-02: a private repo, no encryption).
 */

export interface SyncConfig {
	/** "owner/repo" as typed, or null when sync is off. */
	repo: string | null;
	token: string | null;
}

export type { SyncStatus, SyncSummary };

export interface SyncServiceDeps {
	dataDir: string;
	syncDir: string;
	readConfig: () => SyncConfig;
	makeRemote?: (owner: string, repo: string, token: string) => RemoteRepo;
	isBusy?: (rel: string) => boolean;
	onApplied?: (changes: AppliedChange[]) => void;
	now?: () => Date;
	/** Pull cadence (default 5 minutes). */
	pullEveryMs?: number;
	/** Push after the data has been still this long (default 30 seconds). */
	quietMs?: number;
	/** How often the loop looks (default 10 seconds). */
	tickMs?: number;
}

export interface SyncService {
	status(): SyncStatus;
	/** Run a round now (or join the running one). Never rejects. */
	syncNow(): Promise<SyncStatus>;
	/** Resolves when no round is running (at once when none is). */
	whenIdle(): Promise<void>;
	/** One look at whether an automatic round is due. Exposed for tests. */
	tick(): void;
	start(): void;
	stop(): void;
}

class Refused extends Error {
	readonly code = "public-repo";
}

/** "owner/repo", tolerating a pasted GitHub URL and a trailing .git. null when it is neither. */
export function parseRepo(input: string | null | undefined): { owner: string; repo: string } | null {
	const t = (input ?? "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
	const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(t);
	return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

function explain(err: unknown): { code: string; message: string } {
	if (err instanceof Refused) {
		return { code: err.code, message: "That repo is public. Sync would publish your chats; use a private repo." };
	}
	if (err instanceof GitHubError) {
		switch (err.code) {
			case "auth":
				return { code: err.code, message: "GitHub refused the token. It may have expired, or it lacks Contents read and write access to this repo." };
			case "not-found":
				return { code: err.code, message: "GitHub cannot find that repo, or the token cannot see it." };
			case "rate-limit": {
				const at = err.resetAt ? new Date(err.resetAt) : null;
				return { code: err.code, message: `GitHub's rate limit is reached${at ? `; sync resumes around ${at.toTimeString().slice(0, 5)}` : ""}.` };
			}
			case "network":
				return { code: err.code, message: "Cannot reach GitHub right now." };
			case "conflict":
				return { code: err.code, message: "The repo kept changing while syncing; it will try again." };
			case "truncated":
				return { code: err.code, message: "The repo has too many files to list; it is not meant to hold anything but the sync." };
			default:
				return { code: err.code, message: err.message };
		}
	}
	return { code: "error", message: err instanceof Error ? err.message : String(err) };
}

function summarize(report: SyncReport, at: string): SyncSummary {
	return {
		at,
		idle: report.idle,
		pulled: report.pulled.length,
		pushed: report.pushed.length,
		merged: report.merged.length,
		deleted: report.deletedLocal.length + report.deletedRemote.length,
		conflicts: report.conflicts.length,
		skipped: report.skipped.length,
		notes: report.notes.slice(0, 20),
	};
}

function countFiles(dir: string, cap = 1000): number {
	let n = 0;
	const walk = (d: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (n >= cap) return;
			if (e.isDirectory()) walk(path.join(d, e.name));
			else n++;
		}
	};
	walk(dir);
	return n;
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
	const now = deps.now ?? (() => new Date());
	const pullEveryMs = deps.pullEveryMs ?? 5 * 60_000;
	const quietMs = deps.quietMs ?? 30_000;
	const tickMs = deps.tickMs ?? 10_000;
	const makeRemote = deps.makeRemote ?? ((owner, repo, token) => new GitHubRepo({ owner, repo, token, userAgent: "learnharness-sync" }));

	let inFlight: Promise<SyncStatus> | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastRunAt: string | null = null;
	let lastOkAt: string | null = null;
	let error: SyncStatus["error"] = null;
	let last: SyncSummary | null = null;
	let skipped: SyncStatus["skipped"] = [];
	/** The configuration a failure stopped the automatic rounds for. */
	let blockedKey: string | null = null;
	let pausedUntil = 0;
	let lastRoundAt: number | null = null;
	let verified: { key: string; defaultBranch: string } | null = null;
	/** Change detection for the quiet-period push. */
	let syncedFp: string | null = null;
	let seenFp: string | null = null;
	let seenAt = 0;

	const keyOf = (c: SyncConfig): string => `${c.repo ?? ""}\0${c.token ?? ""}`;
	const configured = (c: SyncConfig): boolean => parseRepo(c.repo) !== null && !!c.token;

	function status(): SyncStatus {
		const c = deps.readConfig();
		return {
			configured: configured(c),
			repo: c.repo,
			hasToken: !!c.token,
			running: inFlight !== null,
			lastRunAt,
			lastOkAt,
			error,
			last,
			skipped,
			conflictCopies: countFiles(path.join(deps.syncDir, "conflicts")),
		};
	}

	function syncNow(): Promise<SyncStatus> {
		if (inFlight) return inFlight;
		const cfg = deps.readConfig();
		const target = parseRepo(cfg.repo);
		if (!target || !cfg.token) {
			error = null;
			return Promise.resolve(status());
		}
		const key = keyOf(cfg);
		const token = cfg.token;
		inFlight = (async () => {
			const started = now();
			lastRunAt = started.toISOString();
			const before = quickFingerprint(deps.dataDir);
			try {
				const remote = makeRemote(target.owner, target.repo, token);
				if (verified?.key !== key) {
					const info = await remote.info();
					if (!info.private) throw new Refused("public repo");
					verified = { key, defaultBranch: info.defaultBranch };
				}
				const report = await runSync({
					dataDir: deps.dataDir,
					syncDir: deps.syncDir,
					remote,
					repoName: `${target.owner}/${target.repo}`,
					branch: verified.defaultBranch,
					now,
					isBusy: deps.isBusy,
					onApplied: deps.onApplied,
				});
				last = summarize(report, started.toISOString());
				skipped = report.skipped.slice(0, 20);
				lastOkAt = started.toISOString();
				error = null;
				blockedKey = null;
				pausedUntil = 0;
				const wroteLocal = report.pulled.length + report.merged.length + report.deletedLocal.length > 0;
				syncedFp = seenFp = wroteLocal ? quickFingerprint(deps.dataDir) : before;
				seenAt = now().getTime();
			} catch (err) {
				error = explain(err);
				verified = err instanceof Refused ? null : verified;
				if (err instanceof Refused || (err instanceof GitHubError && (err.code === "auth" || err.code === "not-found"))) {
					blockedKey = key;
				}
				if (err instanceof GitHubError && err.code === "rate-limit") pausedUntil = err.resetAt ?? now().getTime() + 15 * 60_000;
			} finally {
				lastRoundAt = now().getTime();
				inFlight = null;
			}
			return status();
		})();
		return inFlight;
	}

	function tick(): void {
		try {
			if (inFlight) return;
			const cfg = deps.readConfig();
			if (!configured(cfg) || blockedKey === keyOf(cfg)) return;
			const t = now().getTime();
			if (t < pausedUntil) return;
			if (lastRoundAt === null || t - lastRoundAt >= pullEveryMs) {
				void syncNow();
				return;
			}
			const fp = quickFingerprint(deps.dataDir);
			if (fp !== seenFp) {
				seenFp = fp;
				seenAt = t;
			} else if (fp !== syncedFp && t - seenAt >= quietMs) {
				void syncNow();
			}
		} catch {
			/* a failed look must never break the loop */
		}
	}

	return {
		status,
		syncNow,
		async whenIdle() {
			await inFlight;
		},
		tick,
		start() {
			if (timer) return;
			timer = setInterval(tick, tickMs);
			timer.unref?.();
			tick(); // pull on start
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = null;
		},
	};
}
