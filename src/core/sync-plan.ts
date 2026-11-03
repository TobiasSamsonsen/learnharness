/**
 * GitHub sync, the pure half (fork addition, 2026-11-02). PURE, browser-safe.
 *
 * Two jobs, both free of IO so they are testable without a disk or a network:
 *
 *   1. SCOPE: which files under the data dir travel to the sync repo.
 *   2. PLAN: the three-way compare. Given what the last sync left behind
 *      (base), what is on this device now (local) and what the repo holds
 *      now (remote) — each a map of repo path → git blob SHA — decide, per
 *      file, what must happen. No clocks are involved: a side "changed"
 *      when its SHA differs from the base.
 *
 * Repo paths mirror the data dir: `data/chats/x.json` is `chats/x.json`,
 * always forward-slashed.
 */

/** repo path → git blob SHA (hex). An absent key means the file is absent. */
export type FileShas = Readonly<Record<string, string>>;

/** What must happen to one file. Files identical on both sides and
 *  unchanged since the base need nothing and are not listed. */
export type SyncAction =
	/** Local changed (or is new), remote still matches the base: upload. */
	| { path: string; kind: "push" }
	/** Remote changed (or is new), local still matches the base: download. */
	| { path: string; kind: "pull" }
	/** Deleted here, untouched on the remote: delete it from the repo. */
	| { path: string; kind: "delete-remote" }
	/** Deleted on the remote, untouched here: delete it locally. */
	| { path: string; kind: "delete-local" }
	/** Both sides hold the file and both differ from the base (or there is
	 *  no base: a first sync). The merge rules decide the result. */
	| { path: string; kind: "merge" }
	/** One side deleted the file while the other changed it. */
	| { path: string; kind: "conflict-delete"; deleted: "local" | "remote" }
	/** Both sides already agree (same SHA, or both deleted) but the base
	 *  does not know it yet: nothing to move, only the base to update. */
	| { path: string; kind: "settled" };

/**
 * The three-way compare. `base` is the manifest's file map from the last
 * completed sync (empty on a first sync, so every file present on both
 * sides with different content becomes a merge and nothing is discarded).
 * The result is sorted by path, so runs are deterministic.
 */
export function computeSyncPlan(base: FileShas, local: FileShas, remote: FileShas): SyncAction[] {
	const paths = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
	const actions: SyncAction[] = [];
	for (const path of [...paths].sort()) {
		const b = base[path];
		const l = local[path];
		const r = remote[path];
		if (l === r) {
			if (l !== b) actions.push({ path, kind: "settled" });
			continue;
		}
		if (r === b) {
			// Only local changed.
			actions.push(l === undefined ? { path, kind: "delete-remote" } : { path, kind: "push" });
			continue;
		}
		if (l === b) {
			// Only remote changed.
			actions.push(r === undefined ? { path, kind: "delete-local" } : { path, kind: "pull" });
			continue;
		}
		// Both changed, and they disagree.
		if (l === undefined) actions.push({ path, kind: "conflict-delete", deleted: "local" });
		else if (r === undefined) actions.push({ path, kind: "conflict-delete", deleted: "remote" });
		else actions.push({ path, kind: "merge" });
	}
	return actions;
}

// ─── Scope ─────────────────────────────────────────────────────────────────

/** Ids the app generates (chat, sketch, material): never anything that could
 *  walk out of a folder. Same rule the stores enforce. */
const ID = "[A-Za-z0-9_-]+";

/**
 * How a data-dir-relative path is treated:
 *
 *   include     travels as it is.
 *   sketch-png  a sketch page's PNG. For a drawn sketch it is a render of the
 *               SVG and is rebuilt on the receiving device (owner decision,
 *               2026-11-02), so it does NOT travel; for a photo sketch it is
 *               the camera's original bytes and DOES. Only the sketch's
 *               strokes.json says which (`{"producer":"photo"}`), so the
 *               caller decides.
 *   exclude     stays on the device: model caches, secrets, jobs, material
 *               source files, debug output, the sync bookkeeping itself.
 */
export type SyncScope = "include" | "sketch-png" | "exclude";

const INCLUDE: readonly RegExp[] = [
	new RegExp(`^chats/${ID}\\.json$`),
	new RegExp(`^courses/${ID}\\.json$`),
	// The graph ledgers and their small sidecars. NOT sources.json,
	// source-organization.json or sessions.jsonl: those are keyed by a hash of a
	// file's absolute path on one device (notes imports), so their ids mean
	// nothing on another (owner decision, 2026-11-02).
	/^graph\/(?:nodes|chains|skills|coverage)\.jsonl$/,
	/^graph\/(?:positions|render-settings|format)\.json$/,
	new RegExp(`^sketches/${ID}/${ID}/(?:strokes\\.json|\\d{1,2}\\.svg)$`),
	/^settings\.json$/,
	/^prompts\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md$/,
	new RegExp(`^materials/${ID}/index\\.json$`),
	new RegExp(`^materials/${ID}/${ID}/content\\.md$`),
];
const SKETCH_PNG = new RegExp(`^sketches/${ID}/${ID}/\\d{1,2}\\.png$`);

/** Classify one path, relative to the data dir, forward-slashed. */
export function syncScope(relPath: string): SyncScope {
	if (relPath.includes("..") || relPath.startsWith("/")) return "exclude";
	if (SKETCH_PNG.test(relPath)) return "sketch-png";
	return INCLUDE.some((re) => re.test(relPath)) ? "include" : "exclude";
}

/** The part of a repo listing the app owns: the README, the bootstrap marker
 *  and anything else a person put there is never pulled, deleted or compared.
 *  A remote sketch PNG is kept: only photo sketches ever put one there. */
export function ownedByApp<V>(files: Readonly<Record<string, V>>): Record<string, V> {
	const out: Record<string, V> = {};
	for (const [path, v] of Object.entries(files)) if (syncScope(path) !== "exclude") out[path] = v;
	return out;
}
