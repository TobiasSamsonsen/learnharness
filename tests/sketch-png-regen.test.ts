/**
 * A drawn sketch's PNG is a render of its SVG, so GitHub sync does not carry
 * it (owner decision, 2026-11-02). A sketch that arrives without its PNG is
 * rendered the first time a turn or the UI needs it, and kept. The data dir
 * is isolated before any server module loads.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sketch-png-regen-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { ensureSketchPngs, readSketchPage, sniffImageMime } = await import("../src/server/sketches.ts");
const { stores } = await import("../src/server/stores.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const CHAT = "chat_regen";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#ffffff"/><path d="M2 2L38 18" stroke="#000" stroke-width="2"/></svg>';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/** A sketch as sync leaves it: strokes and SVG on disk, no PNG. */
function arrivedBySync(sketchId: string): void {
	const dir = path.join(TMP_DATA, "sketches", CHAT, sketchId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "0.svg"), SVG);
	fs.writeFileSync(path.join(dir, "strokes.json"), "[]");
}

describe("lazy PNG re-render of a synced sketch", () => {
	it("lists pages that have an SVG but no PNG", () => {
		arrivedBySync("sk_a");
		assert.deepEqual(stores.sketchStore.missingPngs(CHAT), [{ sketchId: "sk_a", page: 0 }]);
		assert.deepEqual(stores.sketchStore.missingPngs("chat_none"), []);
	});

	it("renders the PNG from the SVG at its planned width, keeps it, and leaves nothing missing", async () => {
		arrivedBySync("sk_b");
		await ensureSketchPngs(CHAT);
		const png = stores.sketchStore.pagePng(CHAT, "sk_b", 0);
		assert.ok(png, "a PNG was stored");
		assert.deepEqual([...(png as Uint8Array).slice(0, 4)], PNG_SIGNATURE);
		assert.equal(sniffImageMime(png as Uint8Array), "image/png");
		assert.deepEqual(stores.sketchStore.missingPngs(CHAT), []);
		assert.equal(fs.existsSync(path.join(TMP_DATA, "sketches", CHAT, "sk_b", "0.png.tmp")), false);
	});

	it("leaves an existing PNG untouched", async () => {
		const dir = path.join(TMP_DATA, "sketches", CHAT, "sk_c");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "0.svg"), SVG);
		fs.writeFileSync(path.join(dir, "0.png"), new Uint8Array([0xff, 0xd8, 0xff, 1]));
		await ensureSketchPngs(CHAT);
		assert.deepEqual([...(stores.sketchStore.pagePng(CHAT, "sk_c", 0) as Uint8Array)], [0xff, 0xd8, 0xff, 1]);
	});

	it("renders on the spot when the UI asks for a missing PNG", async () => {
		arrivedBySync("sk_d");
		const png = await readSketchPage(CHAT, "sk_d", 0, "png");
		assert.ok(png instanceof Uint8Array);
		assert.deepEqual([...png.slice(0, 4)], PNG_SIGNATURE);
	});

	it("still answers null for an unknown page, and serves the SVG as before", async () => {
		assert.equal(await readSketchPage(CHAT, "sk_nope", 0, "png"), null);
		assert.equal(await readSketchPage(CHAT, "sk_d", 0, "svg"), SVG);
	});

	it("does nothing for a bad chat id", async () => {
		await ensureSketchPngs("../escape");
	});
});
