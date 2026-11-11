import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyPortableMaterials, applyPortableSettings, portableMaterials, portableSettings } from "../../core/sync-merge.ts";
import { syncScope, type FileShas } from "../../core/sync-plan.ts";

/**
 * GitHub sync, the local half (fork addition, 2026-11-02): what this device
 * holds, as git blob SHAs, and the manifest that remembers the last sync.
 * Both take their directories as arguments (callers pass PATHS.data and
 * PATHS.sync) so tests never touch the real profile.
 */

/** The SHA git gives a file's content: sha1("blob <bytes>\0" + content).
 *  Comparing it with the repo's tree entries needs no download. */
export function gitBlobSha(bytes: Uint8Array): string {
	return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** The data dir's synced entries. Anything else (models/, jobs/, debug/,
 *  sync/, secrets) is never even listed: models/ alone is 1.7 GB. */
const ROOTS = ["chats", "courses", "graph", "sketches", "prompts", "materials"] as const;

function* walk(dir: string, rel: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // an absent folder is an empty one
	}
	for (const e of entries) {
		const childRel = `${rel}/${e.name}`;
		if (e.isDirectory()) yield* walk(path.join(dir, e.name), childRel);
		else if (e.isFile()) yield childRel;
	}
}

/** A drawn sketch's page PNG is a render of its SVG (rebuilt on the other
 *  device); a photo sketch's is the camera's original and must travel. */
function isPhotoSketch(dataDir: string, pngRel: string): boolean {
	const strokes = path.join(/* turbopackIgnore: true */ dataDir, path.posix.dirname(pngRel), "strokes.json");
	try {
		return (JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ strokes, "utf8")) as { producer?: unknown }).producer === "photo";
	} catch {
		return false;
	}
}

/**
 * What a file is, for sync, as bytes: the file itself, except the files that
 * travel only in part: settings.json (src/core/sync-merge.ts portableSettings:
 * device-specific sections never leave the device) and a materials index
 * (portableMaterials: items still being profiled stay). null when the file is
 * absent or such a file is not the JSON it should be.
 */
export function readSyncedFile(dataDir: string, rel: string): Buffer | null {
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(path.join(dataDir, rel));
	} catch {
		return null;
	}
	const project = projectionOf(rel);
	if (!project) return bytes;
	const portable = project(bytes.toString("utf8"));
	return portable === null ? null : Buffer.from(portable, "utf8");
}

/** The files that travel only in part, and the function that cuts out the part. */
export function projectionOf(rel: string): ((json: string) => string | null) | null {
	if (rel === "settings.json") return portableSettings;
	if (/^materials\/[^/]+\/index\.json$/.test(rel)) return portableMaterials;
	return null;
}

/** This device's file after taking in the incoming part (the inverse of projectionOf); null for files that travel whole. */
export function applyProjection(rel: string, localFull: string | null, incoming: string): string | null {
	if (rel === "settings.json") return applyPortableSettings(localFull, incoming);
	if (/^materials\/[^/]+\/index\.json$/.test(rel)) return applyPortableMaterials(localFull, incoming);
	return null;
}

/** Every synced file under `dataDir`, as repo path → blob SHA (of what would be pushed). */
export function scanLocal(dataDir: string): FileShas {
	const out: Record<string, string> = {};
	const candidates = [...ROOTS.flatMap((root) => [...walk(path.join(dataDir, root), root)]), "settings.json"];
	for (const rel of candidates) {
		const scope = syncScope(rel);
		if (scope === "exclude") continue;
		if (scope === "sketch-png" && !isPhotoSketch(dataDir, rel)) continue;
		const bytes = readSyncedFile(dataDir, rel); // null: gone between the listing and the read
		if (bytes) out[rel] = gitBlobSha(bytes);
	}
	return out;
}

/**
 * A cheap change detector for the synced files: path, size and modification
 * time of each (no reads, no hashing), folded into one string. Equal strings
 * mean nothing a sync cares about was written; the service polls it to push
 * shortly after the learner stops working. Sketch PNGs are left out (they
 * are renders, and a photo's arrives with its SVG).
 */
export function quickFingerprint(dataDir: string): string {
	const h = createHash("sha1");
	const candidates = [...ROOTS.flatMap((root) => [...walk(path.join(dataDir, root), root)]), "settings.json"];
	for (const rel of candidates) {
		if (syncScope(rel) !== "include") continue;
		try {
			const st = fs.statSync(path.join(dataDir, rel));
			h.update(`${rel}\0${st.size}\0${Math.trunc(st.mtimeMs)}\n`);
		} catch {
			/* gone */
		}
	}
	return h.digest("hex");
}

// ─── Manifest ──────────────────────────────────────────────────────────────

/**
 * What the last COMPLETED sync left behind: the repo commit it ended on and
 * every file's blob SHA at that moment. The "base" of the three-way compare.
 * It names the repo and branch it belongs to; a manifest for a different
 * target is not a base for this one.
 */
export interface SyncManifest {
	version: 1;
	repo: string;
	branch: string;
	commit: string | null;
	files: Record<string, string>;
}

const MANIFEST_FILE = "manifest.json";

/** The saved manifest for this target. Absent, corrupt or for another
 *  repo/branch reads as empty: a first sync, which merges and loses nothing. */
export function readManifest(syncDir: string, repo: string, branch: string): SyncManifest {
	const empty: SyncManifest = { version: 1, repo, branch, commit: null, files: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(syncDir, MANIFEST_FILE), "utf8")) as Partial<SyncManifest>;
		if (parsed.version !== 1 || parsed.repo !== repo || parsed.branch !== branch) return empty;
		if (!parsed.files || typeof parsed.files !== "object") return empty;
		const files: Record<string, string> = {};
		for (const [k, v] of Object.entries(parsed.files)) if (typeof v === "string") files[k] = v;
		return { version: 1, repo, branch, commit: typeof parsed.commit === "string" ? parsed.commit : null, files };
	} catch {
		return empty;
	}
}

/** Atomic (tmp + rename): a crash never leaves half a manifest. */
export function writeManifest(syncDir: string, manifest: SyncManifest): void {
	fs.mkdirSync(syncDir, { recursive: true });
	const file = path.join(syncDir, MANIFEST_FILE);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	fs.renameSync(tmp, file);
}
