import type { DemoRunResult, HeadlessApi } from "./headless.ts";

/**
 * The layout gate (owner report, 2026-11-27, RC-lading demo on the Tab).
 *
 * A demo can pass every console/probe check and still be broken on the learner's screen: the RC-krets demo read its
 * canvas height back from the canvas's own `height` attribute after multiplying it by devicePixelRatio, so at DPR 1
 * (the builder's headless browser) it was stable and at DPR 2 (the Tab) every redraw doubled the plot until the
 * iframe hit its 2400 px cap. The gate makes the builder's own test notice that class of fault on any backend:
 *
 *   - the runners load the page at a high-DPR viewport (Chromium: DPR 2; the Android WebView is the device's own);
 *   - this module wraps the builder's probe in an in-page script that measures the document height and every canvas's
 *     backing-store size, runs the probe, then re-renders (window resize + input/change events on every control, four
 *     rounds, then 0.8 s of animation) and measures again;
 *   - a layout that keeps growing under re-rendering FAILS the run, with the cause named. The baseline is the page after
 *     the FIRST round (owner ruling 2026-11-27): a demo that only sizes itself inside a resize/input handler moves once,
 *     legitimately, on that first round; the runaway doubling still shows as a multiple over the remaining rounds.
 *
 * The wrapper is plain JavaScript evaluated by whichever runner has the page, so no backend needs to know about it.
 */

export interface LayoutSnapshot {
	/** documentElement.scrollHeight, rounded up (CSS px). */
	h: number;
	/** Every <canvas>'s backing-store size, in document order. */
	c: { id: string; w: number; h: number }[];
}

/** The lesson card clamps an iframe at this height (components/artifacts/demo-card.tsx MAX_HEIGHT). */
export const DEMO_MAX_HEIGHT = 2400;

/** A re-render may change a measurement by this ratio (and by the absolute floor) before it counts as growth. */
const GROWTH_RATIO = 1.25;
const HEIGHT_FLOOR_PX = 64;
const CANVAS_FLOOR_PX = 32;

/** Number of resize/input rounds the gate fires (the first sets the baseline), and the animation window afterwards. */
const STRESS_ROUNDS = 4;
const ANIMATION_MS = 800;

/** The wire shape the wrapper script returns as the probe's value. */
export interface GateProbeResult {
	lhGate: 1;
	before: LayoutSnapshot;
	afterProbe: LayoutSnapshot;
	/** After the first resize/input round: the baseline the growth rule compares against. */
	afterRound1: LayoutSnapshot;
	afterStress: LayoutSnapshot;
	/** The builder's own probe value (JSON-normalised), when it passed one. */
	probe?: unknown;
	probeError?: string;
}

/**
 * The probe expression to hand a runner: the builder's own probe (if any) run between two layout measurements, then
 * the re-render stress. An async IIFE, which both runners await.
 */
export function buildGateProbe(userProbe?: string): string {
	const user = userProbe && userProbe.trim() ? JSON.stringify(userProbe) : "null";
	return `(async () => {
const snap = () => ({
	h: Math.ceil(document.documentElement.scrollHeight),
	c: Array.from(document.querySelectorAll("canvas")).map((c, i) => ({ id: c.id || "#" + i, w: c.width, h: c.height })),
});
// a frame, or 100 ms: a page that is not being drawn (a background WebView) never ticks requestAnimationFrame, and the gate must not hang on it
const frame = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; setTimeout(r, 30); } }; requestAnimationFrame(go); setTimeout(go, 100); });
const out = { lhGate: 1 };
out.before = snap();
const user = ${user};
if (user !== null) {
	try {
		const v = await (0, eval)(user);
		try { out.probe = v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (_) { out.probe = String(v); }
	} catch (e) {
		out.probeError = String((e && e.message) || e);
	}
}
out.afterProbe = snap();
for (let k = 0; k < ${STRESS_ROUNDS}; k++) {
	window.dispatchEvent(new Event("resize"));
	for (const el of document.querySelectorAll("input, select, textarea")) {
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	}
	await frame();
	if (k === 0) out.afterRound1 = snap();
}
await new Promise((r) => setTimeout(r, ${ANIMATION_MS}));
out.afterStress = snap();
return out;
})()`;
}

const grew = (before: number, after: number, floor: number): boolean => after > before * GROWTH_RATIO && after - before > floor;

/** The faults in a gate measurement; empty when the layout settles. Pure, for tests. */
export function layoutProblems(gate: Pick<GateProbeResult, "before" | "afterProbe" | "afterRound1" | "afterStress">): string[] {
	const problems: string[] = [];
	const canvasCount = Math.min(gate.afterRound1.c.length, gate.afterStress.c.length);
	for (let i = 0; i < canvasCount; i++) {
		const first = gate.afterRound1.c[i]!;
		const last = gate.afterStress.c[i]!;
		if (!grew(first.w, last.w, CANVAS_FLOOR_PX) && !grew(first.h, last.h, CANVAS_FLOOR_PX)) continue;
		const factor = Math.max(last.w / Math.max(first.w, 1), last.h / Math.max(first.h, 1));
		problems.push(
			`canvas "${first.id}" kept growing while the demo only re-rendered: ${first.w}×${first.h} after the first resize/input round, ${last.w}×${last.h} backing-store px at the end (×${factor.toFixed(1)}). ` +
				"A canvas that sizes itself from its own width/height attribute (for example h = canvas.height; canvas.height = h * devicePixelRatio) multiplies on every redraw once devicePixelRatio is not 1, so the plot blows up on a tablet or phone. " +
				"Keep the CSS size (a fixed number or style.height) separate from the backing-store size, and never read the canvas attribute back as the layout size.",
		);
	}
	if (grew(gate.afterRound1.h, gate.afterStress.h, HEIGHT_FLOOR_PX)) {
		problems.push(
			`the page height kept growing while the demo only re-rendered (resize and input events): ${gate.afterRound1.h} px after the first round, ${gate.afterStress.h} px at the end. The lesson card follows the document height, so a layout that grows with every redraw fills the screen. Make the height depend on the width and the content only, never on the previous render.`,
		);
	}
	const tallest = Math.max(gate.before.h, gate.afterProbe.h, gate.afterRound1.h, gate.afterStress.h);
	if (tallest > DEMO_MAX_HEIGHT) {
		problems.push(`the page is ${tallest} px tall; the lesson card cuts a demo off at ${DEMO_MAX_HEIGHT} px. Make it shorter.`);
	}
	return problems;
}

function isGateResult(value: unknown): value is GateProbeResult {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	const snapshot = (s: unknown) =>
		typeof s === "object" && s !== null && typeof (s as LayoutSnapshot).h === "number" && Array.isArray((s as LayoutSnapshot).c);
	return v.lhGate === 1 && snapshot(v.before) && snapshot(v.afterProbe) && snapshot(v.afterRound1) && snapshot(v.afterStress);
}

/**
 * Fold a gated run back into the shape the rest of the builder knows: the builder's own probe value is restored, a
 * failed probe becomes a page error, and layout faults go to `layoutProblems` and fail `ok`. A result that did not
 * come from the wrapper (a test fake, a probe that never ran) passes through unchanged.
 */
export function applyLayoutGate(result: DemoRunResult, userProbe?: string): DemoRunResult {
	if (!isGateResult(result.probeResult)) return { ...result, layoutProblems: result.layoutProblems ?? [] };
	const gate = result.probeResult;
	const { probeResult: _wrapped, ...rest } = result;
	const pageErrors = gate.probeError ? [...result.pageErrors, `probe failed: ${gate.probeError}`] : result.pageErrors;
	const problems = layoutProblems(gate);
	return {
		...rest,
		pageErrors,
		layoutProblems: problems,
		...(userProbe && gate.probe !== undefined && gate.probe !== null ? { probeResult: gate.probe } : {}),
		ok: result.consoleErrors.length === 0 && pageErrors.length === 0 && result.failedRequests.length === 0 && problems.length === 0,
	};
}

/** Run a demo through the runner with the gate wrapped around the (optional) builder probe. */
export async function runDemoGated(
	headless: HeadlessApi,
	html: string,
	opts: { probe?: string; screenshot?: boolean } = {},
): Promise<DemoRunResult> {
	const result = await headless.runDemo(html, {
		probe: buildGateProbe(opts.probe),
		...(opts.screenshot ? { screenshot: true } : {}),
	});
	return applyLayoutGate(result, opts.probe);
}
