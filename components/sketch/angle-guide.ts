import type { LineAngle } from "./line-angle.ts";
import type { Pt } from "./straight-line.ts";

/** The guide's opacity: a guide, not ink. */
const GUIDE_ALPHA = 0.6;
const ARC_WIDTH = 1.5;
/** The label's centre sits this far outside the arc (screen px). */
const LABEL_GAP = 14;
const LABEL_FONT = "14px ui-sans-serif, system-ui, sans-serif";

/**
 * Draw the angle guide (an arc between the two lines and a whole-degree label just outside it) in screen space: the
 * context must be in screen px (device scale only), `at` is the vertex on screen. The native layer draws the same
 * thing in AngleOverlay.kt.
 */
export function paintAngleGuide(ctx: CanvasRenderingContext2D, g: LineAngle, at: Pt, color: string): void {
	ctx.save();
	ctx.globalAlpha = GUIDE_ALPHA;
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = ARC_WIDTH;
	ctx.lineCap = "round";
	ctx.beginPath();
	ctx.arc(at.x, at.y, g.radiusPx, g.from, g.from + g.sweep, g.sweep < 0);
	ctx.stroke();
	const mid = g.from + g.sweep / 2;
	const out = g.radiusPx + LABEL_GAP;
	ctx.font = LABEL_FONT;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(`${g.degrees}°`, at.x + Math.cos(mid) * out, at.y + Math.sin(mid) * out);
	ctx.restore();
}
