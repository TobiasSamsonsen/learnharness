/**
 * Sketch answers — the server half (fork addition, 2026-10-26; the pure
 * half is core/sketch.ts). The input path renders a validated payload's
 * planned pages once (resvg: SVG → PNG) and stores them; the turn's
 * model projection reads the PNGs back (toLlmMessages' resolver), so
 * agent state and the SSE stream never carry image bytes.
 */

import { parseSketchPayload, planSketch, type SketchImageResolver, type TurnInput } from "../core/index.ts";
import { providerSafePng } from "../agent/subagents/headless.ts";
import { stores } from "./stores.ts";

/** A thinking input that re-sends a kept page by id (M3): load its stored
 *  strokes into a payload with the SAME id. Null when it is unknown. The
 *  pages already exist, so persistInputSketch skips it. */
export function resolveSketchRef(chatId: string, input: TurnInput): TurnInput | null {
	if (input.type !== "thinking" || !input.sketchRef) return input;
	let json: string | null;
	try {
		json = stores.sketchStore.strokes(chatId, input.sketchRef);
	} catch {
		return null;
	}
	if (json === null) return null;
	try {
		const sketch = parseSketchPayload({ id: input.sketchRef, producer: "web-canvas", strokes: JSON.parse(json) });
		const { sketchRef: _id, ...rest } = input;
		return { ...rest, sketch };
	} catch {
		return null;
	}
}

/** Render and store an input's sketch, if it carries one. Called before
 *  the input's appends are persisted — a record never names a sketch
 *  whose pages are missing. */
export async function persistInputSketch(chatId: string, input: TurnInput): Promise<void> {
	if (input.type !== "answer" && input.type !== "thinking") return;
	const sketch = input.sketch;
	if (!sketch) return;
	// Already stored (a retried POST, or a kept page re-sent): strokes.json
	// is written last, so its presence means every page is on disk.
	if (stores.sketchStore.strokes(chatId, sketch.id) !== null) return;
	const { Resvg } = await import("@resvg/resvg-js");
	const pages = planSketch(sketch).map((page) => ({
		svg: page.svg,
		// Canonical IDAT, like every PNG the app sends a provider (headless.ts:
		// some vision decoders reject split image-data chunks).
		png: new Uint8Array(
			providerSafePng(new Resvg(page.svg, { fitTo: { mode: "width", value: page.width }, background: "#ffffff" }).render().asPng()),
		),
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

/** A stored sketch's strokes JSON for the kept page; null when unknown. */
export function readSketchStrokes(chatId: string, sketchId: string): string | null {
	try {
		return stores.sketchStore.strokes(chatId, sketchId);
	} catch {
		return null;
	}
}
