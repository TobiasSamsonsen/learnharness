#!/usr/bin/env node
// M9 (docs/android/m9-plan.md): the numbers that do not need a camera, and the arithmetic for the ones that do.
//
//   node scripts/ink-latency.mjs frames --fps 240 6 7 7 8 6      frame counts (pen tip to ink tip) -> milliseconds
//   node scripts/ink-latency.mjs web [--swipes 5]                 delivery stage in the app's WebView, over adb + CDP
//   node scripts/ink-latency.mjs native [--swipes 5]              the same stage in the native Ink spike screen
//
// "Delivery" is how long an input event waited before the app's code saw it: the web probe measures
// performance.now() - event.timeStamp in a pointermove handler, the spike measures uptimeMillis - eventTime. Both
// read the same hardware timestamp, and both are driven by the same injected `adb shell input swipe`, so the two
// stacks are compared on the same input. It is NOT photon latency (that needs the camera): it is the part of it
// that happens before either stack can start drawing.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** @param {number[]} values */
export function summarize(values) {
	if (values.length === 0) return { n: 0, mean: 0, median: 0, p90: 0, max: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
	return { n: sorted.length, mean, median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] ?? 0 };
}

/** Frame counts from a slow-motion video -> milliseconds. */
export function framesToMs(frames, fps) {
	if (!(fps > 0)) throw new Error("fps must be positive");
	return summarize(frames.map((f) => (f * 1000) / fps));
}

/** `uptimeMillis - eventTime` summaries printed by the spike, one line per stroke. */
export function parseSpikeLines(log) {
	const out = [];
	for (const m of log.matchAll(/moves=(\d+) dispatch ms: median=([\d.]+) p90=([\d.]+) max=([\d.]+)/g)) {
		out.push({ moves: Number(m[1]), median: Number(m[2]), p90: Number(m[3]), max: Number(m[4]) });
	}
	return out;
}

/** Install in the page; returns nothing. Samples land in window.__inkProbe. */
export const PROBE_SOURCE = `(() => {
	if (window.__inkProbe) window.__inkProbe.stop();
	const delivery = [], frame = [];
	const was = document.documentElement.style.touchAction;
	document.documentElement.style.touchAction = "none"; // no scroll takeover: every move stays a pointermove
	let waiting = false;
	const onMove = (e) => {
		delivery.push(performance.now() - e.timeStamp);
		if (waiting) return;
		waiting = true;
		const t = e.timeStamp;
		requestAnimationFrame((now) => { frame.push(now - t); waiting = false; });
	};
	document.addEventListener("pointermove", onMove, { capture: true, passive: true });
	window.__inkProbe = { delivery, frame, stop() {
		document.removeEventListener("pointermove", onMove, true);
		document.documentElement.style.touchAction = was;
	} };
})()`;

const adb = (...args) => execFileSync(process.env.ADB ?? "adb", args, { encoding: "utf8" });

function swipe(width, height, ms) {
	// a long diagonal through the middle, then back; far from the edge-back gesture
	const x1 = Math.round(width * 0.2), x2 = Math.round(width * 0.8);
	const y1 = Math.round(height * 0.35), y2 = Math.round(height * 0.65);
	adb("shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(ms));
	adb("shell", "input", "swipe", String(x2), String(y1), String(x1), String(y2), String(ms));
}

function screenSize() {
	const m = /(\d+)x(\d+)/.exec(adb("shell", "wm", "size"));
	if (!m) throw new Error("cannot read the screen size");
	return [Number(m[1]), Number(m[2])];
}

async function cdp(wsUrl, expression) {
	const ws = new WebSocket(wsUrl);
	await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("devtools socket failed")); });
	const answer = new Promise((ok) => {
		ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) ok(d.result?.result?.value); };
	});
	ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
	const value = await answer;
	ws.close();
	return value;
}

function line(label, s) {
	const f = (x) => x.toFixed(1).padStart(6);
	return `${label.padEnd(20)} n=${String(s.n).padStart(5)}  median${f(s.median)}  p90${f(s.p90)}  max${f(s.max)}  mean${f(s.mean)}  (ms)`;
}

async function web(swipes) {
	const pid = adb("shell", "pidof", "dev.learnharness.android").trim();
	if (!pid) throw new Error("the app is not running (open it on the page you want to probe)");
	adb("forward", "tcp:9222", `localabstract:webview_devtools_remote_${pid}`);
	try {
		const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
		const wsUrl = pages[0]?.webSocketDebuggerUrl;
		if (!wsUrl) throw new Error("no debuggable page (a debug build is needed)");
		await cdp(wsUrl, PROBE_SOURCE);
		const [w, h] = screenSize();
		for (let i = 0; i < swipes; i++) swipe(w, h, 900);
		const raw = await cdp(wsUrl, "JSON.stringify({d: window.__inkProbe.delivery, f: window.__inkProbe.frame}); ");
		await cdp(wsUrl, "window.__inkProbe.stop()");
		const { d, f } = JSON.parse(raw);
		console.log(line("web: delivery", summarize(d)));
		console.log(line("web: to next frame", summarize(f)));
	} finally {
		adb("forward", "--remove", "tcp:9222");
	}
}

function native(swipes) {
	adb("logcat", "-c");
	adb("shell", "am", "start", "-n", "dev.learnharness.android/.InkSpikeActivity");
	execFileSync("node", ["-e", "setTimeout(()=>{},2500)"]);
	const [w, h] = screenSize();
	for (let i = 0; i < swipes; i++) swipe(w, h, 900);
	const strokes = parseSpikeLines(adb("logcat", "-d", "-s", "InkSpike:I"));
	if (strokes.length === 0) throw new Error("the spike logged nothing (is the screen on and unlocked?)");
	console.log(line("native: delivery", summarize(strokes.flatMap((s) => Array(s.moves).fill(s.median)))));
	console.log(`(${strokes.length} strokes; per-stroke p90 ${summarize(strokes.map((s) => s.p90)).median.toFixed(1)} ms, worst max ${Math.max(...strokes.map((s) => s.max)).toFixed(1)} ms)`);
}

async function main(argv) {
	const [cmd, ...rest] = argv;
	const opt = (name, fallback) => {
		const i = rest.indexOf(name);
		return i >= 0 ? Number(rest[i + 1]) : fallback;
	};
	if (cmd === "frames") {
		const fps = opt("--fps", 240);
		const counts = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--fps").map(Number).filter((n) => Number.isFinite(n));
		console.log(line(`${fps} fps video`, framesToMs(counts, fps)));
	} else if (cmd === "web") {
		await web(opt("--swipes", 5));
	} else if (cmd === "native") {
		native(opt("--swipes", 5));
	} else {
		console.log("usage: ink-latency.mjs frames --fps 240 <counts…> | web [--swipes N] | native [--swipes N]");
		process.exitCode = 2;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
