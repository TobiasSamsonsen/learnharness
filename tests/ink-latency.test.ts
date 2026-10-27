import assert from "node:assert/strict";
import test from "node:test";
import { framesToMs, parseSpikeLines, PROBE_SOURCE, summarize } from "../scripts/ink-latency.mjs";

test("summarize: median, p90, max, mean; empty is all zeros", () => {
	const s = summarize([5, 1, 3, 2, 4, 6, 7, 8, 9, 10]);
	assert.equal(s.n, 10);
	assert.equal(s.median, 6);
	assert.equal(s.p90, 10);
	assert.equal(s.max, 10);
	assert.equal(s.mean, 5.5);
	assert.deepEqual(summarize([]), { n: 0, mean: 0, median: 0, p90: 0, max: 0 });
});

test("framesToMs: counts at 240 fps are 4.17 ms apiece; fps must be positive", () => {
	const s = framesToMs([24, 36], 240);
	assert.equal(Math.round(s.mean), 125);
	assert.equal(Math.round(framesToMs([1], 240).median * 100) / 100, 4.17);
	assert.throws(() => framesToMs([1], 0));
});

test("parseSpikeLines: the spike's per-stroke summaries", () => {
	const log = "I InkSpike: moves=108 dispatch ms: median=1.0 p90=1.0 max=13.0\nI InkSpike: moves=95 dispatch ms: median=2.5 p90=4.0 max=9.0\nnoise";
	assert.deepEqual(parseSpikeLines(log), [
		{ moves: 108, median: 1, p90: 1, max: 13 },
		{ moves: 95, median: 2.5, p90: 4, max: 9 },
	]);
	assert.deepEqual(parseSpikeLines("nothing"), []);
});

test("the probe source parses and exposes its samples", () => {
	assert.doesNotThrow(() => new Function(PROBE_SOURCE.replace(/^\(\(\) => \{/, "return (() => {")));
	assert.match(PROBE_SOURCE, /performance\.now\(\) - e\.timeStamp/);
	assert.match(PROBE_SOURCE, /window\.__inkProbe/);
});
