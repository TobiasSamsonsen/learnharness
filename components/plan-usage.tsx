"use client";

import { useEffect, useState } from "react";
import { Hint } from "@/components/ui/hint";

/**
 * The Claude plan meter (fork addition, 2026-10-24): the stats bar's small
 * "Plan 58%" pill — the 5-hour window, with the weekly one in the tooltip
 * — as Claude Code last reported it (GET /api/claude-code/usage). Hidden
 * until a Claude Code call has reported usage. A usage-capped plan is the
 * whole reason to watch it.
 */

interface Window {
	utilization: number;
	resetsAt: number;
}
interface Usage {
	fiveHour?: Window;
	sevenDay?: Window;
	at: number;
}

const POLL_MS = 60_000;

/** "58%" Pure. */
export const pct = (w: Window | undefined) => (w ? `${Math.round(w.utilization * 100)}%` : "—");

/** The tooltip text. Pure. */
export function planUsageHint(u: Usage, now = Date.now()): string {
	const when = (ms: number) => {
		const mins = Math.max(0, Math.round((ms - now) / 60_000));
		return mins < 90 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
	};
	const parts = [];
	if (u.fiveHour) parts.push(`5-hour window ${pct(u.fiveHour)} (resets in ${when(u.fiveHour.resetsAt)})`);
	if (u.sevenDay) parts.push(`week ${pct(u.sevenDay)} (resets in ${when(u.sevenDay.resetsAt)})`);
	return `Claude plan usage — ${parts.join(" · ")}`;
}

/** `pill`: the floating chrome · `text`: one quiet segment of the stats
 *  summary beneath the composer (owner, 2026-10-25 — the declutter). */
export function PlanUsage({ variant = "pill", separated = false }: { variant?: "pill" | "text"; separated?: boolean }) {
	const [usage, setUsage] = useState<Usage | null>(null);
	useEffect(() => {
		const read = () =>
			fetch("/api/claude-code/usage")
				.then((r) => r.json() as Promise<{ usage: Usage | null }>)
				.then((b) => setUsage(b.usage))
				.catch(() => {});
		read();
		const id = setInterval(read, POLL_MS);
		return () => clearInterval(id);
	}, []);
	if (!usage?.fiveHour) return null;
	const high = Math.max(usage.fiveHour.utilization, usage.sevenDay?.utilization ?? 0) >= 0.8;
	const pill = (
		<Hint label={planUsageHint(usage)} side="bottom">
			<span
				data-testid="plan-usage"
				className={
					variant === "text"
						? `tabular-nums ${high ? "text-red-500" : ""}`
						: `rounded-full border bg-card/85 px-2 py-1 font-mono text-[11px] shadow-lg backdrop-blur ${high ? "text-red-500" : "text-muted-foreground"}`
				}
			>
				{variant === "text" ? "plan" : "Plan"} {pct(usage.fiveHour)}
			</span>
		</Hint>
	);
	// `separated`: the "·" joining it to the session summary before it
	return separated ? (
		<span className="-ml-1.5 flex items-center gap-1.5">
			<span aria-hidden>·</span>
			{pill}
		</span>
	) : (
		pill
	);
}
