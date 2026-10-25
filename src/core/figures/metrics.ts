/**
 * Response metrics (figures phase 1). PURE. Read off a sampled response
 * (t ascending, y) the way the Kyb course defines them — the change is
 * measured from the initial value to the steady value, so a falling
 * response works the same as a rising one.
 *
 *   steady     the final value (the response must have settled)
 *   overshoot  % past the steady value, of the total change
 *   peak       the extreme value in the direction of the change; peaktime its time
 *   settling   last time outside a ±2 % band (of the change) around steady
 *   rise       10 % → 90 % of the change
 *   tau        time to 63.2 % of the change
 */

export type Metric = "steady" | "overshoot" | "peak" | "peaktime" | "settling" | "rise" | "tau";
export const METRICS: readonly Metric[] = ["steady", "overshoot", "peak", "peaktime", "settling", "rise", "tau"];

export interface Series {
	t: ArrayLike<number>;
	y: ArrayLike<number>;
}

/** Linear interpolation of y at time `at` (clamped to the range). */
export function valueAt(s: Series, at: number): number {
	const n = s.t.length;
	if (at <= s.t[0]!) return s.y[0]!;
	if (at >= s.t[n - 1]!) return s.y[n - 1]!;
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (s.t[mid]! <= at) lo = mid;
		else hi = mid;
	}
	const f = (at - s.t[lo]!) / (s.t[hi]! - s.t[lo]!);
	return s.y[lo]! + f * (s.y[hi]! - s.y[lo]!);
}

/** Has the response settled over the last tenth of its span? */
export function settled(s: Series): boolean {
	const n = s.t.length;
	const end = s.y[n - 1]!;
	const from = s.t[n - 1]! - (s.t[n - 1]! - s.t[0]!) / 10;
	let span = 0;
	for (let i = 0; i < n; i++) span = Math.max(span, Math.abs(s.y[i]! - s.y[0]!));
	const tol = Math.max(1e-9, 0.002 * Math.max(span, Math.abs(end)));
	for (let i = 0; i < n; i++) if (s.t[i]! >= from && Math.abs(s.y[i]! - end) > tol) return false;
	return true;
}

/** The first time the response crosses `level` (fraction of the change). */
function crossing(s: Series, y0: number, change: number, level: number): number | null {
	const target = y0 + level * change;
	const dir = Math.sign(change);
	for (let i = 1; i < s.t.length; i++) {
		if ((s.y[i]! - target) * dir >= 0) {
			const a = s.y[i - 1]!;
			const b = s.y[i]!;
			const f = b === a ? 0 : (target - a) / (b - a);
			return s.t[i - 1]! + f * (s.t[i]! - s.t[i - 1]!);
		}
	}
	return null;
}

/** A metric's value, or a reason it has none. */
export function metric(s: Series, m: Metric): number | string {
	const n = s.t.length;
	if (!settled(s)) return "the response has not settled by the end of the simulated time — lengthen it (sim 0..N, or the plot's axis range)";
	const y0 = s.y[0]!;
	const end = s.y[n - 1]!;
	if (m === "steady") return end;
	const change = end - y0;
	if (Math.abs(change) < 1e-12) return "the response does not change (initial and steady values are equal)";
	const dir = Math.sign(change);
	if (m === "overshoot" || m === "peak" || m === "peaktime") {
		let best = 0;
		for (let i = 1; i < n; i++) if ((s.y[i]! - s.y[best]!) * dir > 0) best = i;
		if (m === "peak") return s.y[best]!;
		if (m === "peaktime") return s.t[best]!;
		return Math.max(0, ((s.y[best]! - end) * dir) / Math.abs(change)) * 100;
	}
	if (m === "settling") {
		const band = 0.02 * Math.abs(change);
		for (let i = n - 1; i >= 0; i--) if (Math.abs(s.y[i]! - end) > band) return s.t[Math.min(n - 1, i + 1)]!;
		return s.t[0]!;
	}
	if (m === "rise") {
		const a = crossing(s, y0, change, 0.1);
		const b = crossing(s, y0, change, 0.9);
		return a === null || b === null ? "the response never reaches 90 % of its change" : b - a;
	}
	const tau = crossing(s, y0, change, 1 - Math.exp(-1));
	return tau === null ? "the response never reaches 63 % of its change" : tau - s.t[0]!;
}
