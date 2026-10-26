/**
 * Sketch answers (fork addition, 2026-10-26 — the Android plan's M1): the
 * learner's handwriting, sent as VECTOR STROKES (owner: strokes on the
 * wire, the server renders). Any producer — the web canvas now, the
 * Android ink overlay later — emits the same SketchPayload; core/sketch.ts
 * plans the PNG pages the model sees and the SVG the UI shows, so the
 * picture is one deterministic function of the strokes.
 */

/** Who drew it (the producer seam — every producer emits the same shape). */
export type SketchProducer = "web-canvas" | "android-ink";

/** One pen stroke. `points` is flat [x, y, pressure, x, y, pressure, …]:
 *  x/y in canvas CSS pixels (any origin), pressure 0..1 (0.5 when the
 *  device reports none). `size` is the base diameter in the same pixels. */
export interface SketchStroke {
	size: number;
	/** "#rrggbb"; absent = the default ink. */
	color?: string;
	points: number[];
}

/** The wire shape: the `sketch` field of an answer or thinking input. */
export interface SketchPayload {
	/** Producer-minted ("sk_…"), so a retried POST is idempotent. */
	id: string;
	producer: SketchProducer;
	strokes: SketchStroke[];
}

/** One rendered page (a band of the sketch, top to bottom). */
export interface SketchPageInfo {
	width: number;
	height: number;
}

/** What the record keeps (in an answer's or a thinking marker's details):
 *  the sketch's identity and shape, never its bytes. Derived from the
 *  payload by sketchRefOf on BOTH sides, so the optimistic client card and
 *  the persisted record agree exactly. */
export interface SketchRef {
	id: string;
	producer: SketchProducer;
	pages: SketchPageInfo[];
	strokeCount: number;
	pointCount: number;
}
