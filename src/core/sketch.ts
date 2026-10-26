/**
 * Sketch answers — the pure half (fork addition, 2026-10-26; contract in
 * contracts/sketch.ts). Browser-safe: the canvas draws its live strokes
 * with the same outline options, and both sides derive the record's
 * SketchRef from one function, so the optimistic card and the persisted
 * record never disagree.
 *
 * The render plan (owner, M1): crop to the strokes' bounding box plus
 * padding, scale so the long edge stays ≤ SKETCH_MAX_EDGE (the >20-images
 * per-request limit — claude-code replays the transcript as one request)
 * and never upscale past 2×, then cut pages taller than that into bands
 * at blank rows. White background, ink as drawn. The server rasterizes
 * each page's SVG for the model; the UI shows the SVG itself.
 */

import { getStroke } from "perfect-freehand";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SketchPageInfo, SketchPayload, SketchProducer, SketchRef, SketchStroke } from "./contracts/sketch.ts";
import type { LhMarkerMessage } from "./native-messages.ts";

// ─── limits (owner, 2026-10-26) ──────────────────────────────────────────────

export const SKETCH_MAX_STROKES = 3000;
export const SKETCH_MAX_POINTS = 250_000;
/** The strokes' JSON size cap — also bounds the request's memory. */
export const SKETCH_MAX_BYTES = 4_000_000;
/** Long edge of a rendered page, in pixels. */
export const SKETCH_MAX_EDGE = 2000;
/** Pages (bands) one sketch may render to. */
export const SKETCH_MAX_PAGES = 6;
/** Sketch pages one model request carries as images, newest first (owner,
 *  M1 review): older pages ride as text stubs. */
export const SKETCH_MAX_REQUEST_PAGES = 20;
const MAX_UPSCALE = 2;
/** A tiny sketch is enlarged until its long edge reaches this (≤ 2×). */
const MIN_EDGE = 480;
/** A page too tall by a little shrinks to fit (down to this share of its
 *  scale) instead of splitting into bands. */
const MIN_FIT_SCALE = 0.75;
/** Padding around the strokes' bounding box, in canvas pixels. */
const PAD = 24;
const SKETCH_ID_RE = /^sk_[A-Za-z0-9_-]{8,40}$/;
/** The new-ink bracket (kept page): drawn in the left padding. */
const BRACKET_COLOR = "#2563eb";
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PRODUCERS: readonly SketchProducer[] = ["web-canvas", "android-ink"];
/** The default ink. */
export const SKETCH_INK = "#111111";

/** The outline options — ONE set for the live canvas and the server
 *  render, so what the learner saw is what the model sees. */
export function sketchStrokeOptions(size: number) {
	return { size, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true };
}

/** A fresh producer-minted sketch id. */
export function newSketchId(): string {
	return `sk_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** The label the model reads ahead of each page image. */
export function sketchLabel(id: string, page: number, pages: number): string {
	return `[sketch ${id} · page ${page + 1}/${pages}]`;
}

/** The start of a model-facing sketch label — what identifies a page
 *  whatever form it takes (image or text stub), so claude-code's
 *  fingerprints can hash both alike. */
export const SKETCH_LABEL_RE = /^\[sketch (sk_[A-Za-z0-9_-]{8,40}) · page (\d+)\/(\d+)\]/;

/** A page the model no longer gets as an image: the label, then why.
 *  Every form keeps the label first (SKETCH_LABEL_RE). */
export function sketchStubText(id: string, page: number, pages: number, why: "elided" | "window" | "missing"): string {
	const label = sketchLabel(id, page, pages);
	if (why === "elided") return `${label} — omitted; its confirmed reading is your read_sketch call`;
	if (why === "window") return `${label} (omitted — older than the newest ${SKETCH_MAX_REQUEST_PAGES} sketch pages)`;
	return `${label} (image unavailable)`;
}

/** The sketch a record message carries (a thinking marker's details, or
 *  an answer's graded record), if any. */
export function sketchOfMessage(m: AgentMessage): SketchRef | null {
	const role = (m as { role?: string }).role;
	if (role === "custom") {
		const marker = m as LhMarkerMessage;
		if (marker.customType !== "practice-thinking") return null;
		const sketch = (marker.details as { sketch?: unknown } | null)?.sketch;
		return isSketchRef(sketch) ? sketch : null;
	}
	if (role === "toolResult") {
		const sketch = ((m as ToolResultMessage).details as { sketch?: unknown } | null)?.sketch;
		return isSketchRef(sketch) ? sketch : null;
	}
	return null;
}

// ─── validation ──────────────────────────────────────────────────────────────

/** A payload that breaks the contract (callers map it to their 400). */
export class SketchPayloadError extends Error {}

/** Validate a wire payload (hand-written: the limits are counts and bytes
 *  no schema expresses). Returns a clean copy; throws SketchPayloadError. */
export function parseSketchPayload(value: unknown): SketchPayload {
	if (typeof value !== "object" || value === null) throw new SketchPayloadError("sketch must be an object");
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || !SKETCH_ID_RE.test(v.id)) throw new SketchPayloadError("sketch id is invalid");
	if (!PRODUCERS.includes(v.producer as SketchProducer)) throw new SketchPayloadError("sketch producer is unknown");
	if (!Array.isArray(v.strokes) || v.strokes.length === 0) throw new SketchPayloadError("sketch has no strokes");
	if (v.strokes.length > SKETCH_MAX_STROKES) {
		throw new SketchPayloadError(`sketch has more than ${SKETCH_MAX_STROKES} strokes`);
	}
	let points = 0;
	const strokes: SketchStroke[] = v.strokes.map((raw, i) => {
		const s = raw as Record<string, unknown>;
		if (typeof s !== "object" || s === null) throw new SketchPayloadError(`stroke ${i} must be an object`);
		if (typeof s.size !== "number" || !(s.size >= 0.5 && s.size <= 64)) {
			throw new SketchPayloadError(`stroke ${i} size is out of range`);
		}
		if (s.color !== undefined && (typeof s.color !== "string" || !COLOR_RE.test(s.color))) {
			throw new SketchPayloadError(`stroke ${i} color is invalid`);
		}
		const p = s.points;
		if (!Array.isArray(p) || p.length < 3 || p.length % 3 !== 0) {
			throw new SketchPayloadError(`stroke ${i} points must be [x, y, pressure] triples`);
		}
		for (let k = 0; k < p.length; k++) {
			const n = p[k];
			const ok =
				typeof n === "number" &&
				Number.isFinite(n) &&
				(k % 3 === 2 ? n >= 0 && n <= 1 : Math.abs(n) <= 1_000_000);
			if (!ok) throw new SketchPayloadError(`stroke ${i} has an invalid point value`);
		}
		points += p.length / 3;
		return s.color === undefined
			? { size: s.size, points: p as number[] }
			: { size: s.size, color: s.color, points: p as number[] };
	});
	if (points > SKETCH_MAX_POINTS) throw new SketchPayloadError(`sketch has more than ${SKETCH_MAX_POINTS} points`);
	if (JSON.stringify(strokes).length > SKETCH_MAX_BYTES) {
		throw new SketchPayloadError("sketch is larger than 4 MB");
	}
	const payload: SketchPayload = { id: v.id, producer: v.producer as SketchProducer, strokes };
	if (v.newFrom !== undefined) {
		if (!Number.isInteger(v.newFrom) || (v.newFrom as number) < 0 || (v.newFrom as number) >= strokes.length) {
			throw new SketchPayloadError("sketch newFrom is out of range");
		}
		if ((v.newFrom as number) > 0) payload.newFrom = v.newFrom as number;
	}
	planSketch(payload); // a sketch too tall to render is refused here, not at render time
	return payload;
}

// ─── the render plan ─────────────────────────────────────────────────────────

/** One planned page: its pixel size and the SVG that draws it. */
export interface SketchPagePlan extends SketchPageInfo {
	svg: string;
}

interface Outlined {
	/** Index in the payload's strokes (empty outlines are skipped). */
	index: number;
	path: string;
	color: string;
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The SVG path of a perfect-freehand outline (its quadratic midpoint form). */
function outlinePath(outline: number[][]): string {
	if (outline.length === 0) return "";
	const parts: (string | number)[] = ["M", r2(outline[0]![0]!), r2(outline[0]![1]!), "Q"];
	for (let i = 0; i < outline.length; i++) {
		const [x0, y0] = outline[i]!;
		const [x1, y1] = outline[(i + 1) % outline.length]!;
		parts.push(r2(x0!), r2(y0!), r2((x0! + x1!) / 2), r2((y0! + y1!) / 2));
	}
	parts.push("Z");
	return parts.join(" ");
}

/** A stroke's perfect-freehand outline polygon (canvas pixels). */
function strokeOutline(s: SketchStroke): number[][] {
	const triples: number[][] = [];
	for (let k = 0; k < s.points.length; k += 3) triples.push([s.points[k]!, s.points[k + 1]!, s.points[k + 2]!]);
	return getStroke(triples, sketchStrokeOptions(s.size));
}

/** A stroke as an SVG path — the live canvas draws this (Path2D), the
 *  server render embeds the same, so the two never drift. */
export function sketchStrokePath(s: SketchStroke): string {
	return outlinePath(strokeOutline(s));
}

function outlineStrokes(strokes: readonly SketchStroke[]): Outlined[] {
	const out: Outlined[] = [];
	for (const [index, s] of strokes.entries()) {
		const outline = strokeOutline(s);
		if (outline.length === 0) continue;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const [x, y] of outline) {
			if (x! < minX) minX = x!;
			if (x! > maxX) maxX = x!;
			if (y! < minY) minY = y!;
			if (y! > maxY) maxY = y!;
		}
		out.push({ index, path: outlinePath(outline), color: s.color ?? SKETCH_INK, minX, minY, maxX, maxY });
	}
	return out;
}

/** Where to cut a band that would end at `limit`: the middle of the blank
 *  row nearest the limit within the band's lower half, else the limit. */
function bandCut(strokes: readonly Outlined[], top: number, limit: number): number {
	const floor = top + (limit - top) / 2;
	const spans = strokes
		.filter((s) => s.maxY > floor && s.minY < limit)
		.map((s) => [s.minY, s.maxY] as const)
		.sort((a, b) => a[0] - b[0]);
	let best: number | null = null;
	let reach = floor;
	for (const [a, b] of spans) {
		if (a > reach) best = (reach + a) / 2; // a blank row between reach and a
		if (b > reach) reach = b;
	}
	if (reach < limit) best = (reach + limit) / 2;
	return best !== null && best > floor ? best : limit;
}

/** A "[" in the left margin spanning the new ink's rows within one band
 *  (kept page): tells the model which part of the page was just added. */
function newInkBracket(strokes: readonly Outlined[], newFrom: number | undefined, minX: number, top: number, bottom: number): string {
	if (!newFrom) return "";
	const fresh = strokes.filter((s) => s.index >= newFrom);
	if (fresh.length === 0) return "";
	const y0 = Math.max(top, Math.min(...fresh.map((s) => s.minY)) - 4);
	const y1 = Math.min(bottom, Math.max(...fresh.map((s) => s.maxY)) + 4);
	if (y1 <= y0) return "";
	const x = minX + 8;
	const d = `M ${r2(x + 8)} ${r2(y0)} L ${r2(x)} ${r2(y0)} L ${r2(x)} ${r2(y1)} L ${r2(x + 8)} ${r2(y1)}`;
	return `<path d="${d}" fill="none" stroke="${BRACKET_COLOR}" stroke-width="3" stroke-linecap="square"/>`;
}

const planCache = new WeakMap<SketchPayload, SketchPagePlan[]>();

/** The deterministic page plan of a payload (memoized per payload object).
 *  Throws SketchPayloadError when it would need more than SKETCH_MAX_PAGES. */
export function planSketch(payload: SketchPayload): SketchPagePlan[] {
	const cached = planCache.get(payload);
	if (cached) return cached;
	const strokes = outlineStrokes(payload.strokes);
	if (strokes.length === 0) throw new SketchPayloadError("sketch has no visible ink");
	const minX = Math.min(...strokes.map((s) => s.minX)) - PAD;
	const maxX = Math.max(...strokes.map((s) => s.maxX)) + PAD;
	const minY = Math.min(...strokes.map((s) => s.minY)) - PAD;
	const maxY = Math.max(...strokes.map((s) => s.maxY)) + PAD;
	const width = maxX - minX;
	const height = maxY - minY;
	// 1:1 canvas pixels read well; a tiny sketch is enlarged (≤ 2×) so its
	// long edge reaches ~MIN_EDGE; never wider than the cap.
	const long = Math.max(width, height);
	const base = long < MIN_EDGE ? Math.min(MAX_UPSCALE, MIN_EDGE / long) : 1;
	let s = Math.min(base, SKETCH_MAX_EDGE / width);
	const bands: [number, number][] = [];
	if (height * s <= SKETCH_MAX_EDGE) {
		bands.push([minY, maxY]);
	} else if (SKETCH_MAX_EDGE / height >= MIN_FIT_SCALE * s) {
		// Slightly too tall: shrink to one page (one image costs far less
		// than two bands at full scale).
		s = SKETCH_MAX_EDGE / height;
		bands.push([minY, maxY]);
	} else {
		const bandMax = SKETCH_MAX_EDGE / s;
		let top = minY;
		while (maxY - top > bandMax && bands.length <= SKETCH_MAX_PAGES) {
			const cut = bandCut(strokes, top, top + bandMax);
			bands.push([top, cut]);
			top = cut;
		}
		bands.push([top, maxY]);
	}
	if (bands.length > SKETCH_MAX_PAGES) {
		throw new SketchPayloadError(`sketch is too tall: more than ${SKETCH_MAX_PAGES} pages`);
	}
	const plan = bands.map(([top, bottom]) => {
		const h = bottom - top;
		const pw = Math.max(1, Math.round(width * s));
		const ph = Math.max(1, Math.round(h * s));
		const inBand = strokes.filter((st) => st.maxY >= top && st.minY <= bottom);
		const paths = inBand.map((st) => `<path d="${st.path}" fill="${st.color}"/>`).join("");
		const bracket = newInkBracket(strokes, payload.newFrom, minX, top, bottom);
		const svg =
			`<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" ` +
			`viewBox="${r2(minX)} ${r2(top)} ${r2(width)} ${r2(h)}">` +
			`<rect x="${r2(minX)}" y="${r2(top)}" width="${r2(width)}" height="${r2(h)}" fill="#ffffff"/>` +
			paths +
			bracket +
			`</svg>`;
		return { width: pw, height: ph, svg };
	});
	planCache.set(payload, plan);
	return plan;
}

/** Does a pointer (x, y) with radius r touch the stroke? Distance to the
 *  polyline, plus half the stroke's width — the stroke eraser's hit test. */
export function sketchStrokeHit(s: SketchStroke, x: number, y: number, r: number): boolean {
	const reach = r + s.size / 2;
	const p = s.points;
	let px = p[0]!, py = p[1]!;
	if (Math.hypot(x - px, y - py) <= reach) return true;
	for (let k = 3; k < p.length; k += 3) {
		const qx = p[k]!, qy = p[k + 1]!;
		const dx = qx - px, dy = qy - py;
		const len2 = dx * dx + dy * dy;
		const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / len2));
		if (Math.hypot(x - (px + t * dx), y - (py + t * dy)) <= reach) return true;
		px = qx;
		py = qy;
	}
	return false;
}

/** The newest sketch of the active problem: messages after its pose that
 *  carry one (the kept page — null when none yet). */
export function keptSketchOf(messages: readonly AgentMessage[], problemCallId: string): SketchRef | null {
	let kept: SketchRef | null = null;
	let inProblem = false;
	for (const m of messages) {
		if ((m as { role?: string }).role === "assistant") {
			const content = (m as { content?: unknown }).content;
			if (Array.isArray(content) && content.some((b) => (b as { type?: string; id?: string }).type === "toolCall" && (b as { id?: string }).id === problemCallId)) {
				inProblem = true;
				kept = null;
			}
			continue;
		}
		if (!inProblem) continue;
		const ref = sketchOfMessage(m);
		if (ref) kept = ref;
	}
	return kept;
}

/** The record's view of a payload (pure, deterministic — both sides). */
export function sketchRefOf(payload: SketchPayload): SketchRef {
	const pages = planSketch(payload).map(({ width, height }) => ({ width, height }));
	const pointCount = payload.strokes.reduce((n, s) => n + s.points.length / 3, 0);
	return { id: payload.id, producer: payload.producer, pages, strokeCount: payload.strokes.length, pointCount };
}

/** Is this a well-formed sketch id (the wire's and the record's shape)? */
export function isSketchId(value: unknown): value is string {
	return typeof value === "string" && SKETCH_ID_RE.test(value);
}

/** Is this value a SketchRef (the read-side guard for record details)? */
export function isSketchRef(value: unknown): value is SketchRef {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Partial<SketchRef>;
	return typeof v.id === "string" && SKETCH_ID_RE.test(v.id) && Array.isArray(v.pages);
}
