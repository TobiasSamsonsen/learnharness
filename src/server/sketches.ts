/**
 * Sketch answers — the server half (fork addition, 2026-10-26; the pure
 * half is core/sketch.ts). The input path renders a validated payload's
 * planned pages once (resvg: SVG → PNG) and stores them; the turn's
 * model projection reads the PNGs back (toLlmMessages' resolver), so
 * agent state and the SSE stream never carry image bytes.
 */

import { parseSketchPayload, planSketch, SKETCH_PHOTO_MAX_DATA, type SketchImageResolver, type TurnInput } from "../core/index.ts";
import { normalizePhoto } from "../agent/image-processing/normalize.ts";
import { providerSafePng } from "../agent/subagents/headless.ts";
import { stores } from "./stores.ts";

/** The result of normalising a request's photo sketch before it is parsed: the input to parse, or the refusal. */
export type NormalizePhotoSketchResult = { ok: true; input: unknown } | { ok: false; error: string };

/** A photo sketch (M17) arrives as the camera's bytes, which may be sideways or huge. Decode it, apply its EXIF orientation,
 *  cap its long edge (normalizePhoto), and return a COPY of the input with the normalised photo. Any other input passes
 *  through unchanged. The argument is never mutated. */
export async function normalizePhotoSketch(input: unknown): Promise<NormalizePhotoSketchResult> {
	if (typeof input !== "object" || input === null) return { ok: true, input };
	const sketch = (input as { sketch?: unknown }).sketch;
	if (typeof sketch !== "object" || sketch === null || (sketch as { producer?: unknown }).producer !== "photo") return { ok: true, input };
	const photo = (sketch as { photo?: unknown }).photo;
	if (typeof photo !== "object" || photo === null || typeof (photo as { data?: unknown }).data !== "string") return { ok: true, input };
	const data = (photo as { data: string }).data;
	if (data.length > SKETCH_PHOTO_MAX_DATA) return { ok: false, error: "The photo is too large" };
	const normalized = await normalizePhoto(new Uint8Array(Buffer.from(data, "base64")));
	if (!normalized) return { ok: false, error: "The photo could not be read" };
	return {
		ok: true,
		input: {
			...(input as Record<string, unknown>),
			sketch: {
				...(sketch as Record<string, unknown>),
				strokes: [],
				photo: {
					mimeType: normalized.mimeType,
					width: normalized.width,
					height: normalized.height,
					data: normalized.bytes.toString("base64"),
				},
			},
		},
	};
}

/** The image type of stored page bytes, by their magic number: JPEG (FF D8 FF), otherwise PNG. */
export function sniffImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" {
	return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg" : "image/png";
}

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
	if (sketch.producer === "photo" && sketch.photo) {
		// A photo is stored as the bytes the camera gave (normalised upright already): no render, the SVG only places it.
		const [page] = planSketch(sketch);
		if (!page) return;
		stores.sketchStore.save(chatId, {
			id: sketch.id,
			strokesJson: JSON.stringify({ producer: "photo" }),
			pages: [{ svg: page.svg, png: new Uint8Array(Buffer.from(sketch.photo.data, "base64")) }],
		});
		return;
	}
	const { Resvg } = await import("@resvg/resvg-js");
	const pages = planSketch(sketch).map((page) => ({
		svg: page.svg,
		// Canonical IDAT, like every PNG the app sends a provider (headless.ts:
		// some vision decoders reject split image-data chunks).
		png: new Uint8Array(
			providerSafePng(new Resvg(page.svg, { fitTo: { mode: "width", value: page.width }, background: "#ffffff" }).render().asPng()),
		),
	}));
	// Stored ink is kept ink: the new-or-edited flag was for this render only.
	const kept = sketch.strokes.map(({ fresh: _fresh, ...stroke }) => stroke);
	stores.sketchStore.save(chatId, { id: sketch.id, strokesJson: JSON.stringify(kept), pages });
}

/** The model-facing page loader for one chat's turn (memoized: a turn
 *  projects the record once per model request). */
export function sketchImagesFor(chatId: string): SketchImageResolver {
	const cache = new Map<string, { data: string; mimeType: string } | null>();
	return (sketchId, page) => {
		const key = `${sketchId}/${page}`;
		if (!cache.has(key)) {
			const png = stores.sketchStore.pagePng(chatId, sketchId, page);
			cache.set(key, png ? { data: Buffer.from(png).toString("base64"), mimeType: sniffImageMime(png) } : null);
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
