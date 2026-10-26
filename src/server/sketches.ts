/**
 * Sketch answers — the server half (fork addition, 2026-10-26; the pure
 * half is core/sketch.ts). The input path renders a validated payload's
 * planned pages once (resvg: SVG → PNG) and stores them; the turn's
 * model projection reads the PNGs back (toLlmMessages' resolver), so
 * agent state and the SSE stream never carry image bytes.
 */

import { planSketch, type SketchImageResolver, type TurnInput } from "../core/index.ts";
import { stores } from "./stores.ts";

/** Render and store an input's sketch, if it carries one. Called before
 *  the input's appends are persisted — a record never names a sketch
 *  whose pages are missing. */
export async function persistInputSketch(chatId: string, input: TurnInput): Promise<void> {
	if (input.type !== "answer" && input.type !== "thinking") return;
	const sketch = input.sketch;
	if (!sketch) return;
	const { Resvg } = await import("@resvg/resvg-js");
	const pages = planSketch(sketch).map((page) => ({
		svg: page.svg,
		png: new Uint8Array(new Resvg(page.svg, { fitTo: { mode: "width", value: page.width }, background: "#ffffff" }).render().asPng()),
	}));
	stores.sketchStore.save(chatId, { id: sketch.id, strokesJson: JSON.stringify(sketch.strokes), pages });
}

/** The model-facing page loader for one chat's turn (memoized: a turn
 *  projects the record once per model request). */
export function sketchImagesFor(chatId: string): SketchImageResolver {
	const cache = new Map<string, { data: string; mimeType: string } | null>();
	return (sketchId, page) => {
		const key = `${sketchId}/${page}`;
		if (!cache.has(key)) {
			const png = stores.sketchStore.pagePng(chatId, sketchId, page);
			cache.set(key, png ? { data: Buffer.from(png).toString("base64"), mimeType: "image/png" } : null);
		}
		return cache.get(key) ?? null;
	};
}

/** A stored page for the UI route; null when unknown or the ids are bad. */
export function readSketchPage(
	chatId: string,
	sketchId: string,
	page: number,
	format: "svg" | "png",
): string | Uint8Array | null {
	try {
		return format === "svg"
			? stores.sketchStore.pageSvg(chatId, sketchId, page)
			: stores.sketchStore.pagePng(chatId, sketchId, page);
	} catch {
		return null;
	}
}
