import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { SketchStore } from "../core/ports.ts";

/**
 * Sketch answers on disk (fork addition, 2026-10-26) — the SketchStore
 * adapter (core/ports.ts), sole writer of data/sketches:
 *
 *   sketches/<chatId>/<sketchId>/strokes.json   the strokes as sent
 *   sketches/<chatId>/<sketchId>/<page>.svg     the page for the UI
 *   sketches/<chatId>/<sketchId>/<page>.png     the page for the model
 */

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
function chatDir(chatId: string): string {
	if (!SAFE_ID.test(chatId)) throw new Error(`invalid chat id: ${chatId}`);
	return path.join(/* turbopackIgnore: true */ PATHS.sketches, chatId);
}
function sketchDir(chatId: string, sketchId: string): string {
	if (!SAFE_ID.test(sketchId)) throw new Error(`invalid sketch id: ${sketchId}`);
	return path.join(/* turbopackIgnore: true */ chatDir(chatId), sketchId);
}
function pageFile(chatId: string, sketchId: string, page: number, ext: "svg" | "png"): string | null {
	if (!Number.isInteger(page) || page < 0 || page > 99) return null;
	return path.join(/* turbopackIgnore: true */ sketchDir(chatId, sketchId), `${page}.${ext}`);
}
function readOrNull<T>(read: () => T): T | null {
	try {
		return read();
	} catch {
		return null;
	}
}

export const sketchStore: SketchStore = {
	save(chatId, sketch) {
		const dir = sketchDir(chatId, sketch.id);
		fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
		sketch.pages.forEach((p, i) => {
			fs.writeFileSync(path.join(/* turbopackIgnore: true */ dir, `${i}.svg`), p.svg, "utf8");
			fs.writeFileSync(path.join(/* turbopackIgnore: true */ dir, `${i}.png`), p.png);
		});
		// The strokes land last: their presence marks a complete write.
		fs.writeFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ dir, "strokes.json"), sketch.strokesJson, "utf8");
	},

	pagePng(chatId, sketchId, page) {
		const file = pageFile(chatId, sketchId, page, "png");
		return file ? readOrNull(() => new Uint8Array(fs.readFileSync(/* turbopackIgnore: true */ file))) : null;
	},

	pageSvg(chatId, sketchId, page) {
		const file = pageFile(chatId, sketchId, page, "svg");
		return file ? readOrNull(() => fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) : null;
	},

	strokes(chatId, sketchId) {
		return readOrNull(() => fs.readFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ sketchDir(chatId, sketchId), "strokes.json"), "utf8"));
	},

	missingPngs(chatId) {
		const out: { sketchId: string; page: number }[] = [];
		const root = chatDir(chatId);
		const sketches = readOrNull(() => fs.readdirSync(/* turbopackIgnore: true */ root, { withFileTypes: true })) ?? [];
		for (const s of sketches) {
			if (!s.isDirectory() || !SAFE_ID.test(s.name)) continue;
			const files = new Set(readOrNull(() => fs.readdirSync(path.join(/* turbopackIgnore: true */ root, s.name))) ?? []);
			for (const f of files) {
				const m = /^(\d{1,2})\.svg$/.exec(f);
				if (m && !files.has(`${m[1]}.png`)) out.push({ sketchId: s.name, page: Number(m[1]) });
			}
		}
		return out;
	},

	savePagePng(chatId, sketchId, page, png) {
		const file = pageFile(chatId, sketchId, page, "png");
		if (!file) throw new Error(`invalid page: ${page}`);
		// tmp + rename: a reader never sees half a PNG
		const tmp = `${file}.tmp`;
		fs.writeFileSync(/* turbopackIgnore: true */ tmp, png);
		fs.renameSync(/* turbopackIgnore: true */ tmp, /* turbopackIgnore: true */ file);
	},

	removeAll(chatId) {
		fs.rmSync(/* turbopackIgnore: true */ chatDir(chatId), { recursive: true, force: true });
	},
};
