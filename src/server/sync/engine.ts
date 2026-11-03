import * as fs from "node:fs";
import * as path from "node:path";
import { mergeFile, type Side } from "../../core/sync-merge.ts";
import { computeSyncPlan, ownedByApp, type SyncAction } from "../../core/sync-plan.ts";
import { GitHubError, type PushChange, type RemoteRepo, type RepoHead } from "./github.ts";
import { applyProjection, gitBlobSha, projectionOf, readManifest, readSyncedFile, scanLocal, writeManifest } from "./local.ts";

/**
 * GitHub sync, one round (fork addition, 2026-11-02): read both sides, plan
 * (core/sync-plan.ts), resolve (core/sync-merge.ts), apply to this device,
 * push ONE commit, remember the result as the next base.
 *
 * Shape of a round, chosen for safety while the server keeps running:
 *
 *   1. ASYNC  list the repo, scan this device, fetch the blobs the plan needs.
 *   2. SYNC   (no await) re-read each file this round touches and, if it still
 *             matches what step 1 saw, apply it. The stores write with
 *             synchronous fs in the same single thread, so nothing can
 *             interleave with this step; a file that changed since step 1 is
 *             skipped and settles next round.
 *   3. ASYNC  push the collected changes. A branch that moved meanwhile
 *             restarts the round (never forced).
 *
 * Local files are written tmp + rename. Deleted-vs-edited keeps the edit; the
 * loser of any resolved conflict is saved under `<syncDir>/conflicts/`.
 */

export interface SyncDeps {
	dataDir: string;
	syncDir: string;
	remote: RemoteRepo;
	/** "owner/repo": names the target a manifest belongs to. */
	repoName: string;
	branch: string;
	now?: () => Date;
	/** True while a repo path is in use on this device in a way a rewrite could clobber (a running turn on that chat, say). Such a file is left for a later round. */
	isBusy?: (rel: string) => boolean;
	/** Called (synchronously, right after step 2) with every file written or removed here, so caches and open clients can refresh. */
	onApplied?: (changes: AppliedChange[]) => void;
}

export interface AppliedChange {
	path: string;
	kind: "written" | "removed";
}

export interface SyncReport {
	/** Repo → this device. */
	pulled: string[];
	/** This device → repo. */
	pushed: string[];
	merged: string[];
	/** Deleted on this device because the other device deleted them. */
	deletedLocal: string[];
	/** Deleted in the repo because this device deleted them. */
	deletedRemote: string[];
	/** Conflict copies written (repo path → file under syncDir/conflicts). */
	conflicts: { path: string; copy: string }[];
	skipped: { path: string; reason: string }[];
	notes: string[];
	/** The repo's tip after the round. */
	commit: string | null;
	/** True when nothing at all had changed on either side. */
	idle: boolean;
}

const MAX_ATTEMPTS = 3;

function emptyReport(): SyncReport {
	return { pulled: [], pushed: [], merged: [], deletedLocal: [], deletedRemote: [], conflicts: [], skipped: [], notes: [], commit: null, idle: false };
}

/** tmp + rename, creating folders: a crash never leaves half a file. */
export function writeFileAtomic(dataDir: string, rel: string, bytes: Uint8Array): void {
	const file = path.join(dataDir, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.sync-tmp`;
	fs.writeFileSync(tmp, bytes);
	fs.renameSync(tmp, file);
}

/** Remove a file and any folders it leaves empty, never above a top-level folder of the data dir. */
function removeFile(dataDir: string, rel: string): void {
	fs.rmSync(path.join(dataDir, rel), { force: true });
	let dir = path.posix.dirname(rel);
	while (dir !== "." && dir.includes("/")) {
		try {
			fs.rmdirSync(path.join(dataDir, dir)); // throws unless empty
		} catch {
			break;
		}
		dir = path.posix.dirname(dir);
	}
}

const text = (b: Uint8Array): string => Buffer.from(b).toString("utf8");

/** Does applying this action rewrite or remove the file on this device? */
function writesLocal(action: SyncAction): boolean {
	return action.kind === "pull" || action.kind === "merge" || action.kind === "delete-local" || (action.kind === "conflict-delete" && action.deleted === "local");
}

/**
 * A course still "drafting" has a worker on one device. Syncing it would hand
 * the other device a record whose worker it does not have, and that device's
 * recovery sweep would mark it interrupted. It travels once it settles
 * (draft, active or error). Returns the reason to leave the file, or null.
 */
function unfinishedOn(rel: string, action: SyncAction, local: Uint8Array | null, remote: Uint8Array | undefined): string | null {
	if (!/^courses\/[^/]+\.json$/.test(rel) || action.kind === "settled") return null;
	const drafting = (b: Uint8Array | null | undefined): boolean => {
		if (!b) return false;
		try {
			return (JSON.parse(text(b)) as { status?: unknown }).status === "drafting";
		} catch {
			return false;
		}
	};
	return drafting(local) || drafting(remote) ? "still being drafted on a device" : null;
}

/** Fetch blobs that may be gone: a missing one reads as absent, never an error. */
async function fetchOptional(remote: RemoteRepo, shas: readonly string[]): Promise<Record<string, Uint8Array>> {
	const out: Record<string, Uint8Array> = {};
	await Promise.all(
		[...new Set(shas)].map(async (sha) => {
			try {
				out[sha] = await remote.blob(sha);
			} catch (err) {
				if (!(err instanceof GitHubError) || err.code === "network" || err.code === "rate-limit" || err.code === "auth") throw err;
			}
		}),
	);
	return out;
}

/** Which side's copy is newer when a file carries no timestamp: this device's file time against the repo tip's commit time. */
function preferSide(dataDir: string, rel: string, head: RepoHead | null): Side {
	if (!head?.date) return "local";
	try {
		return fs.statSync(path.join(dataDir, rel)).mtimeMs >= Date.parse(head.date) ? "local" : "remote";
	} catch {
		return "remote";
	}
}

/** One round. Throws GitHubError (auth, rate-limit, network, ...) for the caller to show; local files already applied stay applied. */
export async function runSync(deps: SyncDeps): Promise<SyncReport> {
	let last: unknown;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			return await round(deps);
		} catch (err) {
			if (!(err instanceof GitHubError) || err.code !== "conflict") throw err;
			last = err; // the branch moved while pushing: read both sides again
		}
	}
	throw last;
}

async function round(deps: SyncDeps): Promise<SyncReport> {
	const { dataDir, syncDir, remote, repoName, branch } = deps;
	const now = deps.now ?? (() => new Date());
	const report = emptyReport();

	// ── 1. ASYNC: read ──────────────────────────────────────────────────────
	const head = await remote.head(branch);
	const remoteShas: Record<string, string> = {};
	if (head) for (const [p, e] of Object.entries(ownedByApp(await remote.tree(head.tree)))) remoteShas[p] = e.sha;
	const manifest = readManifest(syncDir, repoName, branch);
	const base = manifest.files;
	const localShas = scanLocal(dataDir);
	const plan = computeSyncPlan(base, localShas, remoteShas);
	if (plan.length === 0) {
		report.idle = true;
		report.commit = head?.commit ?? null;
		if (head && manifest.commit !== head.commit) writeManifest(syncDir, { ...manifest, commit: head.commit, files: { ...base } });
		return report;
	}

	const wantRemote = plan.filter((a) => ["pull", "merge"].includes(a.kind) || (a.kind === "conflict-delete" && a.deleted === "local")).map((a) => remoteShas[a.path]);
	const remoteBytes = await remote.blobs(wantRemote.filter((s): s is string => !!s));
	const baseBlobs = await fetchOptional(
		remote,
		plan.filter((a) => a.kind === "merge").map((a) => base[a.path]).filter((s): s is string => !!s),
	);

	// ── 2. SYNC: apply ──────────────────────────────────────────────────────
	const changes: PushChange[] = [];
	const applied: AppliedChange[] = [];
	const next: Record<string, string | undefined> = { ...base };
	const stamp = now().toISOString().replace(/[:.]/g, "-");

	const readFull = (rel: string): string | null => {
		try {
			return fs.readFileSync(path.join(dataDir, rel), "utf8");
		} catch {
			return null;
		}
	};
	/** Take in incoming bytes. A file that travels only in part (settings, a materials index) is merged INTO this device's file, which keeps what never travels. */
	const writeLocal = (rel: string, bytes: Uint8Array) => {
		const merged = applyProjection(rel, readFull(rel), text(bytes));
		writeFileAtomic(dataDir, rel, merged === null ? bytes : Buffer.from(merged, "utf8"));
		applied.push({ path: rel, kind: "written" });
	};
	const keepCopy = (rel: string, loser: string) => {
		const copy = path.posix.join("conflicts", stamp, rel.replace(/\//g, "__"));
		writeFileAtomic(syncDir, copy, Buffer.from(loser, "utf8"));
		report.conflicts.push({ path: rel, copy });
	};
	const skip = (rel: string, reason: string): void => {
		report.skipped.push({ path: rel, reason });
	};

	for (const action of plan) {
		const rel = action.path;
		// Unchanged since step 1? Otherwise this device wrote it meanwhile: settle next round.
		const nowLocal = readSyncedFile(dataDir, rel);
		const nowSha = nowLocal ? gitBlobSha(nowLocal) : undefined;
		if (nowSha !== localShas[rel]) {
			skip(rel, "changed on this device while syncing");
			continue;
		}
		if (writesLocal(action) && deps.isBusy?.(rel)) {
			skip(rel, "in use on this device right now");
			continue;
		}
		const unfinished = unfinishedOn(rel, action, nowLocal, remoteBytes[remoteShas[rel] as string]);
		if (unfinished) {
			skip(rel, unfinished);
			continue;
		}
		applyAction(action, nowLocal);
	}

	function applyAction(action: SyncAction, local: Uint8Array | null): void {
		const rel = action.path;
		switch (action.kind) {
			case "settled":
				if (localShas[rel] === undefined) delete next[rel];
				else next[rel] = localShas[rel];
				return;
			case "push":
				changes.push({ path: rel, content: local });
				report.pushed.push(rel);
				next[rel] = localShas[rel];
				return;
			case "delete-remote":
				changes.push({ path: rel, content: null });
				report.deletedRemote.push(rel);
				delete next[rel];
				return;
			case "pull": {
				const bytes = remoteBytes[remoteShas[rel] as string];
				if (!bytes) return skip(rel, "the repo's copy could not be read");
				writeLocal(rel, bytes);
				report.pulled.push(rel);
				next[rel] = remoteShas[rel];
				return;
			}
			case "delete-local": {
				if (rel === "settings.json") return skip(rel, "settings are never deleted by a sync");
				// a materials index keeps this device's own still-reading items
				const kept = projectionOf(rel) ? applyProjection(rel, readFull(rel), "[]") : null;
				if (kept !== null && kept !== "[]") {
					writeFileAtomic(dataDir, rel, Buffer.from(kept, "utf8"));
					applied.push({ path: rel, kind: "written" });
					report.deletedLocal.push(rel);
					delete next[rel];
					return;
				}
				removeFile(dataDir, rel);
				applied.push({ path: rel, kind: "removed" });
				report.deletedLocal.push(rel);
				delete next[rel];
				return;
			}
			case "conflict-delete":
				// A delete against an edit keeps the edit (owner decision, 2026-11-02).
				if (action.deleted === "remote") {
					changes.push({ path: rel, content: local });
					report.pushed.push(rel);
					next[rel] = localShas[rel];
				} else {
					const bytes = remoteBytes[remoteShas[rel] as string];
					if (!bytes) return skip(rel, "the repo's copy could not be read");
					writeLocal(rel, bytes);
					report.pulled.push(rel);
					next[rel] = remoteShas[rel];
				}
				report.notes.push(`${rel}: kept the edited copy of a file the other device deleted`);
				return;
			case "merge": {
				const remoteBlob = remoteBytes[remoteShas[rel] as string];
				if (!local || !remoteBlob) return skip(rel, "a copy could not be read");
				const baseSha = base[rel];
				const baseText = baseSha && baseBlobs[baseSha] ? text(baseBlobs[baseSha]) : null;
				const merged = mergeFile({
					path: rel,
					base: baseText,
					local: text(local),
					remote: text(remoteBlob),
					prefer: preferSide(dataDir, rel, head),
				});
				if (merged.skipped) return skip(rel, merged.skipped);
				report.notes.push(...merged.notes.map((n) => `${rel}: ${n}`));
				if (merged.loser !== null) keepCopy(rel, merged.loser);
				if (merged.content === null) return;
				// a file that travels in part is pushed in its portable form, so what is pushed is what the next scan hashes
				const body = projectionOf(rel)?.(merged.content) ?? merged.content;
				const bytes = Buffer.from(body, "utf8");
				const sha = gitBlobSha(bytes);
				if (sha !== localShas[rel]) writeLocal(rel, bytes);
				if (sha !== remoteShas[rel]) changes.push({ path: rel, content: bytes });
				report.merged.push(rel);
				next[rel] = sha;
				return;
			}
		}
	}
	if (applied.length > 0) deps.onApplied?.(applied);

	// ── 3. ASYNC: push, then remember ───────────────────────────────────────
	let tip: { commit: string } | null = head;
	if (changes.length > 0) {
		tip = await remote.push(branch, head, changes, `LearnHarness sync (${changes.length} file${changes.length === 1 ? "" : "s"})`);
	}
	const files: Record<string, string> = {};
	for (const [p, sha] of Object.entries(next)) if (sha !== undefined) files[p] = sha;
	writeManifest(syncDir, { version: 1, repo: repoName, branch, commit: tip?.commit ?? null, files });
	report.commit = tip?.commit ?? null;
	return report;
}

// ─── Replace this device with the repo ─────────────────────────────────────

/** The repo has nothing to replace this device with: refusing is the only safe answer. */
export class ReplaceRefused extends Error {
	readonly code = "empty-repo";
}

/** How many files would be written (new or different) and removed (only here), by top-level folder. */
export interface ReplaceCounts {
	write: Record<string, number>;
	remove: Record<string, number>;
}

const folderOf = (rel: string): string => (rel.includes("/") ? (rel.split("/")[0] as string) : rel);
const tally = (paths: readonly string[]): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const p of paths) out[folderOf(p)] = (out[folderOf(p)] ?? 0) + 1;
	return out;
};

/**
 * Make this device's synced data exactly the repo's (owner request,
 * 2026-11-03): files only here are removed, files that differ are replaced,
 * files only in the repo are added, and NOTHING is pushed. Nothing is touched
 * until every needed blob has been fetched, so a network failure leaves the
 * device as it was. Everything replaced or removed is first copied to
 * `<syncDir>/replaced-<time>/` (owner decision: keep a backup). Device-only
 * data (settings that stay on the device, the token, original source files)
 * is never touched; a chat in use, a course still drafting, and an item whose
 * file changed meanwhile are skipped. With `dryRun` it only counts.
 */
export async function runReplace(deps: SyncDeps, opts: { dryRun?: boolean } = {}): Promise<SyncReport & { counts: ReplaceCounts; backup: string | null }> {
	const { dataDir, syncDir, remote, repoName, branch } = deps;
	const now = deps.now ?? (() => new Date());
	const report = { ...emptyReport(), counts: { write: {}, remove: {} } as ReplaceCounts, backup: null as string | null };

	// ── ASYNC: read ─────────────────────────────────────────────────────────
	const head = await remote.head(branch);
	const remoteShas: Record<string, string> = {};
	if (head) for (const [p, e] of Object.entries(ownedByApp(await remote.tree(head.tree)))) remoteShas[p] = e.sha;
	report.commit = head?.commit ?? null;
	if (!head || Object.keys(remoteShas).length === 0) {
		throw new ReplaceRefused("The repo holds no synced data, so there is nothing to replace this device with.");
	}
	const localShas = scanLocal(dataDir);
	const writePaths = Object.keys(remoteShas).filter((p) => localShas[p] !== remoteShas[p]);
	// settings.json is shared in part only: it is replaced, never deleted
	const removePaths = Object.keys(localShas).filter((p) => !(p in remoteShas) && p !== "settings.json");
	report.counts = { write: tally(writePaths), remove: tally(removePaths) };
	if (opts.dryRun) return report;
	const blobs = await remote.blobs(writePaths.map((p) => remoteShas[p] as string));

	// ── SYNC: back up, then apply ───────────────────────────────────────────
	const stamp = now().toISOString().replace(/[:.]/g, "-");
	const backupDir = `replaced-${stamp}`;
	const next: Record<string, string> = {};
	const applied: AppliedChange[] = [];
	let backedUp = 0;
	const skip = (rel: string, reason: string): void => {
		report.skipped.push({ path: rel, reason });
	};
	const backup = (rel: string): void => {
		try {
			const raw = fs.readFileSync(path.join(dataDir, rel));
			writeFileAtomic(syncDir, path.posix.join(backupDir, rel), raw);
			backedUp++;
		} catch {
			/* nothing there to keep */
		}
	};
	/** True when this file must be left alone this time. */
	const held = (rel: string, action: SyncAction): string | null => {
		const nowLocal = readSyncedFile(dataDir, rel);
		if ((nowLocal ? gitBlobSha(nowLocal) : undefined) !== localShas[rel]) return "changed on this device while replacing";
		if (deps.isBusy?.(rel)) return "in use on this device right now";
		return unfinishedOn(rel, action, nowLocal, blobs[remoteShas[rel] as string]);
	};

	for (const p of Object.keys(remoteShas)) if (localShas[p] === remoteShas[p]) next[p] = remoteShas[p] as string;
	for (const rel of writePaths) {
		const why = held(rel, { path: rel, kind: "pull" });
		if (why) {
			skip(rel, why);
			continue;
		}
		const bytes = blobs[remoteShas[rel] as string];
		if (!bytes) {
			skip(rel, "the repo's copy could not be read");
			continue;
		}
		backup(rel);
		let existing: string | null = null;
		try {
			existing = fs.readFileSync(path.join(dataDir, rel), "utf8");
		} catch {
			/* a new file */
		}
		const merged = applyProjection(rel, existing, text(bytes));
		writeFileAtomic(dataDir, rel, merged === null ? bytes : Buffer.from(merged, "utf8"));
		applied.push({ path: rel, kind: "written" });
		report.pulled.push(rel);
		next[rel] = remoteShas[rel] as string;
	}
	for (const rel of removePaths) {
		const why = held(rel, { path: rel, kind: "delete-local" });
		if (why) {
			skip(rel, why);
			continue;
		}
		backup(rel);
		// a materials index keeps this device's own still-reading items
		const kept = projectionOf(rel) ? applyProjection(rel, fs.existsSync(path.join(dataDir, rel)) ? fs.readFileSync(path.join(dataDir, rel), "utf8") : null, "[]") : null;
		if (kept !== null && kept !== "[]") writeFileAtomic(dataDir, rel, Buffer.from(kept, "utf8"));
		else removeFile(dataDir, rel);
		applied.push({ path: rel, kind: kept !== null && kept !== "[]" ? "written" : "removed" });
		report.deletedLocal.push(rel);
	}
	if (applied.length > 0) deps.onApplied?.(applied);
	report.backup = backedUp > 0 ? backupDir : null;
	report.notes.push(...(backedUp > 0 ? [`${backedUp} replaced or removed file(s) were copied to sync/${backupDir} first`] : []));

	// the repo's state is now this device's base: the next normal round starts from it
	writeManifest(syncDir, { version: 1, repo: repoName, branch, commit: head.commit, files: next });
	return report;
}
