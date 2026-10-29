/**
 * The Claude plan's usage as Claude Code last reported it (fork addition, kept on top of upstream's provider):
 * every API response carries a `rate_limit_event`; the plan pill (components/plan-usage.tsx) shows the last one
 * through /api/claude-code/usage. Not part of upstream's provider, so the stream loop only calls
 * `observePlanUsage(line)` and everything else lives here.
 */

/** Utilization 0..1 per window, as Claude Code reported it. */
export interface ClaudePlanUsage {
	fiveHour?: { utilization: number; resetsAt: number };
	sevenDay?: { utilization: number; resetsAt: number };
	/** When this was reported (ms). */
	at: number;
}

const PLAN_KEY = Symbol.for("lh.claudePlanUsage");

type Window = { utilization?: number; resetsAt?: number };

function recordPlanUsage(info: unknown): void {
	const windows = (info as { unifiedWindows?: Record<string, Window> } | undefined)?.unifiedWindows;
	if (!windows) return;
	const pick = (w?: Window) => (w && typeof w.utilization === "number" ? { utilization: w.utilization, resetsAt: (w.resetsAt ?? 0) * 1000 } : undefined);
	(globalThis as Record<symbol, ClaudePlanUsage | undefined>)[PLAN_KEY] = {
		fiveHour: pick(windows.five_hour),
		sevenDay: pick(windows.seven_day),
		at: Date.now(),
	};
}

/** Look at one stdout line of the CLI and record a plan-usage report if it is one. Never throws. */
export function observePlanUsage(line: string): void {
	if (!line.includes('"rate_limit_event"')) return;
	try {
		const parsed = JSON.parse(line) as { type?: string; rate_limit_info?: unknown };
		if (parsed.type === "rate_limit_event") recordPlanUsage(parsed.rate_limit_info);
	} catch {
		// non-JSON noise is not part of the protocol
	}
}

/** The last reported plan usage; null before any Claude Code call. */
export function claudePlanUsage(): ClaudePlanUsage | null {
	return (globalThis as Record<symbol, ClaudePlanUsage | undefined>)[PLAN_KEY] ?? null;
}
