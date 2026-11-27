import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
	applyLayoutGate,
	buildGateProbe,
	DEMO_MAX_HEIGHT,
	layoutProblems,
	runDemoGated,
	type GateProbeResult,
	type LayoutSnapshot,
} from "../src/agent/subagents/demo-layout-gate.ts";
import {
	resolveChromeExecutablePath,
	runDemoOnPage,
	screenshotDemoOnPage,
	type DemoRunResult,
	type HeadlessApi,
} from "../src/agent/subagents/headless.ts";

const snap = (h: number, ...canvases: Array<[string, number, number]>): LayoutSnapshot => ({
	h,
	c: canvases.map(([id, w, ch]) => ({ id, w, h: ch })),
});
const stable = (): Pick<GateProbeResult, "before" | "afterProbe" | "afterRound1" | "afterStress"> => ({
	before: snap(700, ["m", 958, 680]),
	afterProbe: snap(700, ["m", 958, 680]),
	afterRound1: snap(700, ["m", 958, 680]),
	afterStress: snap(700, ["m", 958, 680]),
});
const CLEAN: DemoRunResult = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };

describe("layoutProblems", () => {
	it("is empty for a layout that is a fixed point under re-rendering", () => {
		assert.deepEqual(layoutProblems(stable()), []);
	});

	it("tolerates small drift (a scrollbar, a rounding step)", () => {
		assert.deepEqual(layoutProblems({ ...stable(), afterStress: snap(720, ["m", 962, 690]) }), []);
	});

	it("names a canvas that multiplies on every redraw, with the cause", () => {
		const problems = layoutProblems({ ...stable(), afterStress: snap(700, ["m", 958, 5440]) });
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /canvas "m" kept growing.*958×680 after the first resize\/input round, 958×5440 .* \(×8\.0\)/);
		assert.match(problems[0]!, /devicePixelRatio/);
		assert.match(problems[0]!, /never read the canvas attribute back/);
	});

	it("lets a demo that only sizes itself in a resize/input handler move once, on the first round", () => {
		const unsized = { ...stable(), before: snap(700, ["m", 600, 400]), afterProbe: snap(700, ["m", 600, 400]) };
		assert.deepEqual(layoutProblems(unsized), [], "600×400 → 958×680 on the first round, then still");
	});

	it("catches a page whose height keeps growing while it only re-renders", () => {
		const problems = layoutProblems({ ...stable(), afterStress: snap(1900, ["m", 958, 680]) });
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /page height kept growing.*700 px after the first round, 1900 px at the end/);
	});

	it("does not blame the page for height the builder's own probe added", () => {
		assert.deepEqual(layoutProblems({ ...stable(), afterProbe: snap(1200, ["m", 958, 680]), afterRound1: snap(1200, ["m", 958, 680]), afterStress: snap(1200, ["m", 958, 680]) }), []);
	});

	it("fails a page taller than the card allows, even when it is stable", () => {
		const tall = snap(DEMO_MAX_HEIGHT + 1);
		const problems = layoutProblems({ before: tall, afterProbe: tall, afterRound1: tall, afterStress: tall });
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /cuts a demo off at 2400 px/);
	});
});

describe("buildGateProbe", () => {
	it("is a syntactically valid async expression, with and without a builder probe", () => {
		for (const probe of [undefined, "1 + 1", "(async () => { return document.title; })()", 'say("quote\\" and \'single\'")']) {
			assert.doesNotThrow(() => new vm.Script(buildGateProbe(probe)), `probe ${String(probe)}`);
		}
	});

	it("embeds the builder's probe as data, not as code of its own", () => {
		const script = buildGateProbe("window.stolen = 1");
		assert.ok(script.includes(JSON.stringify("window.stolen = 1")));
	});
});

describe("applyLayoutGate", () => {
	const gated = (extra: Partial<GateProbeResult> = {}): DemoRunResult => ({
		...CLEAN,
		probeResult: { lhGate: 1, ...stable(), ...extra },
	});

	it("passes a result that did not come from the wrapper through, with no layout problems", () => {
		const raw: DemoRunResult = { ...CLEAN, probeResult: 42 };
		assert.deepEqual(applyLayoutGate(raw, "1+1"), { ...raw, layoutProblems: [] });
	});

	it("restores the builder's own probe value and stays ok on a stable layout", () => {
		const out = applyLayoutGate(gated({ probe: { v: 3 } }), "probe");
		assert.deepEqual(out.probeResult, { v: 3 });
		assert.deepEqual(out.layoutProblems, []);
		assert.equal(out.ok, true);
	});

	it("drops the wrapper's own payload when the builder gave no probe", () => {
		const out = applyLayoutGate(gated(), undefined);
		assert.equal(out.probeResult, undefined);
		assert.equal(out.ok, true);
	});

	it("fails the run on layout growth, whatever else was clean", () => {
		const out = applyLayoutGate(gated({ afterStress: snap(700, ["m", 958, 5440]) }), undefined);
		assert.equal(out.ok, false);
		assert.equal(out.layoutProblems?.length, 1);
	});

	it("turns a failed builder probe into a page error", () => {
		const out = applyLayoutGate(gated({ probeError: "x is not defined" }), "x");
		assert.deepEqual(out.pageErrors, ["probe failed: x is not defined"]);
		assert.equal(out.ok, false);
	});
});

describe("runDemoGated", () => {
	it("hands the runner the wrapped probe and the screenshot request, and folds the answer back", async () => {
		let seen: { probe?: string; screenshot?: boolean } | undefined;
		const headless = {
			runDemo: async (_html: string, opts?: { probe?: string; screenshot?: boolean }) => {
				seen = opts;
				return { ...CLEAN, probeResult: { lhGate: 1, ...stable(), probe: "seen" } } satisfies DemoRunResult;
			},
		} as unknown as HeadlessApi;
		const out = await runDemoGated(headless, "<html></html>", { probe: "document.title", screenshot: true });
		assert.equal(seen?.screenshot, true);
		assert.ok(seen?.probe?.includes(JSON.stringify("document.title")));
		assert.equal(out.probeResult, "seen");
		assert.equal(out.ok, true);
	});
});

// ─── the real browser: the RC-krets fault, reproduced and then fixed ─────────────────────────

const canvasDemo = (readBack: boolean) => `<!doctype html><html><body style="margin:0">
<canvas id="m" height="340" style="width:100%;display:block"></canvas>
<script>
const m = document.getElementById("m");
${readBack ? "" : 'm.dataset.h = m.getAttribute("height");'}
function draw() {
	const d = devicePixelRatio || 1, w = m.clientWidth;
	const h = ${readBack ? 'Number(m.getAttribute("height"))' : "Number(m.dataset.h)"};
	m.width = w * d; m.height = h * d;
	m.style.height = h + "px";
	const g = m.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); g.fillRect(10, 10, 40, 40);
}
addEventListener("resize", draw); draw();
</script></body></html>`;

// System Chrome, launched and closed by the test itself: the app's own browser helper would outlive the test process.
const chromePath = resolveChromeExecutablePath();
async function withChrome<T>(fn: (page: import("puppeteer-core").Page) => Promise<T>): Promise<T> {
	const puppeteer = (await import("puppeteer-core")).default;
	const browser = await puppeteer.launch({ headless: true, executablePath: chromePath!, args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"] });
	try {
		return await fn(await browser.newPage());
	} finally {
		await browser.close();
	}
}
const realHeadless = {
	runDemo: async (html: string, opts: { probe?: string; screenshot?: boolean } = {}) => {
		const { screenshot, ...runOpts } = opts;
		const result = await withChrome((page) => runDemoOnPage(page, html, runOpts));
		if (!screenshot) return result;
		return { ...result, screenshot: await withChrome((page) => screenshotDemoOnPage(page, html, 2000)) };
	},
} as unknown as HeadlessApi;

// Sized only inside a resize handler, never at load: the one legitimate jump the baseline must absorb.
const resizeOnlyDemo = `<!doctype html><html><body style="margin:0"><canvas id="m" width="600" height="400" data-h="400" style="width:100%;display:block"></canvas><script>
const m = document.getElementById("m");
function size() { const d = devicePixelRatio || 1, w = m.clientWidth, h = Number(m.dataset.h); m.width = w * d; m.height = h * d; m.style.height = h + "px"; }
addEventListener("resize", size);
</script></body></html>`;

describe("layout gate in a real browser", { skip: chromePath ? false : "no Chrome available" }, () => {
	it("does not blame a demo that only sizes its canvas in a resize handler", async () => {
		const out = await runDemoGated(realHeadless, resizeOnlyDemo);
		assert.deepEqual(out.layoutProblems, []);
		assert.equal(out.ok, true);
	});

	it("fails a canvas that reads its own size back at devicePixelRatio 2 (the RC-lading demo on the Tab)", async () => {
		const out = await runDemoGated(realHeadless, canvasDemo(true), { screenshot: true });
		assert.equal(out.ok, false, JSON.stringify(out.layoutProblems));
		assert.match((out.layoutProblems ?? []).join("\n"), /canvas "m" kept growing/);
	});

	it("passes the same demo once the intended size is kept apart from the backing store, and returns a screenshot", async () => {
		const out = await runDemoGated(realHeadless, canvasDemo(false), { screenshot: true });
		assert.deepEqual(out.layoutProblems, []);
		assert.equal(out.ok, true, JSON.stringify(out));
		assert.ok(out.screenshot, "a screenshot of the settled page");
		const png = Buffer.from(out.screenshot.data, "base64");
		assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
		assert.equal(png.readUInt32BE(16), 900, "900 px wide, the half-scale of the DPR 2 viewport");
	});
});
