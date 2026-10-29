"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CONFIDENCE_LEVELS } from "@/src/core";
import { CONFIDENCE_COLORS } from "@/components/confidence-rail";

/**
 * The confidence buttons (owner, 2026-10-28; Anki style): the learner picks an answer, then presses how sure they are, and
 * that press submits. Five levels (CONFIDENCE_LEVELS) in the colour ramp the slider used, text only. `leading` is a slot
 * for the "I don't know" button, which sits left of them in the quiz dock. `highlight` is the stop index the arrow keys
 * have moved to (Enter presses it).
 */
export function ConfidenceButtons({
	onPick,
	disabled = false,
	highlight = null,
	leading,
	testidPrefix = "confidence-btn",
	className,
}: {
	/** Called with the pressed level's index into CONFIDENCE_STOPS. */
	onPick: (stopIndex: number) => void;
	/** No answer is picked yet: the levels wait (the leading button may still be live). */
	disabled?: boolean;
	highlight?: number | null;
	leading?: ReactNode;
	testidPrefix?: string;
	className?: string;
}) {
	return (
		<div role="group" aria-label="How sure are you?" data-testid="confidence-buttons" className={cn("flex w-full items-stretch gap-1.5", className)}>
			{leading}
			{CONFIDENCE_LEVELS.map((level) => (
				<button
					key={level.stop}
					type="button"
					disabled={disabled}
					onClick={() => onPick(level.index)}
					data-testid={`${testidPrefix}-${level.stop}`}
					data-highlighted={highlight === level.index ? "" : undefined}
					title={`${level.stop}% sure`}
					style={{ color: CONFIDENCE_COLORS[level.index], borderColor: highlight === level.index ? CONFIDENCE_COLORS[level.index] : undefined }}
					className={cn(
						"lh-touch h-9 min-w-0 flex-1 truncate rounded-[6px] border border-border/70 bg-transparent px-0 text-[11px] font-medium tracking-tighter transition-colors",
						"hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-transparent",
						highlight === level.index && "bg-accent/60",
					)}
				>
					{level.label}
				</button>
			))}
		</div>
	);
}
