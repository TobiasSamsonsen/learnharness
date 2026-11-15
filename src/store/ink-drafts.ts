import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/**
 * Unsent sketch pages on disk (owner plan, 2026-11-15 — the page lost on the tablet when the browser's 5 MB store was full).
 *
 *   ink-drafts/<key>.json   the strokes JSON of one page's UNSENT ink, keyed like the client's ink (the tool-call id)
 *
 * A second copy of what the client keeps in localStorage, written after a pause in drawing and removed when the page is sent.
 * Never synced (sync-plan.ts only includes known paths) and pruned by age: a draft that outlives its chat is just a file.
 */

const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
/** The same ceiling as a sketch payload (core/sketch.ts SKETCH_MAX_BYTES). */
export const INK_DRAFT_MAX_BYTES = 4_000_000;
export const INK_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function fileOf(key: string): string {
	if (!SAFE_KEY.test(key)) throw new Error(`invalid ink key: ${key}`);
	return path.join(/* turbopackIgnore: true */ PATHS.inkDrafts, `${key}.json`);
}

export function saveInkDraft(key: string, strokesJson: string): void {
	if (strokesJson.length > INK_DRAFT_MAX_BYTES) throw new Error("ink draft too large");
	const file = fileOf(key);
	fs.mkdirSync(/* turbopackIgnore: true */ PATHS.inkDrafts, { recursive: true });
	writeFileAtomicSync(file, strokesJson);
	pruneInkDrafts();
}

export function readInkDraft(key: string): string | null {
	try {
		return fs.readFileSync(/* turbopackIgnore: true */ fileOf(key), "utf8");
	} catch {
		return null;
	}
}

export function deleteInkDraft(key: string): void {
	try {
		fs.rmSync(/* turbopackIgnore: true */ fileOf(key), { force: true });
	} catch {
		// nothing there, or not removable: a stale draft is pruned by age
	}
}

let lastPrune = 0;
/** Remove drafts older than the age limit (at most once an hour). */
export function pruneInkDrafts(now = Date.now(), maxAge = INK_DRAFT_MAX_AGE_MS): void {
	if (now - lastPrune < 3_600_000 && maxAge === INK_DRAFT_MAX_AGE_MS) return;
	lastPrune = now;
	try {
		for (const name of fs.readdirSync(/* turbopackIgnore: true */ PATHS.inkDrafts)) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(/* turbopackIgnore: true */ PATHS.inkDrafts, name);
			if (now - fs.statSync(/* turbopackIgnore: true */ file).mtimeMs > maxAge) fs.rmSync(/* turbopackIgnore: true */ file, { force: true });
		}
	} catch {
		// no folder yet
	}
}
