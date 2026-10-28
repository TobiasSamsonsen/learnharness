"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type { DockSelection } from "@/src/core";

/**
 * A multiple-choice question's answer controls inside the sketch view's
 * floating box (Android plan M3): the options and "I don't know" (quiz) or
 * "Other…" (ask). The confidence is not asked here: the sketch page's Submit expands into the confidence buttons
 * (owner, 2026-10-28). Purely
 * presentational: every value and handler is the question dock's own
 * (`sel`, `other`), so there is ONE source of truth and the
 * dock's submit gate governs both surfaces.
 */

export interface SketchChoicesProps {
	kind: "quiz" | "ask" | "explain";
	multi: boolean;
	options: readonly { value: string; label: string; description?: string }[];
	sel: DockSelection;
	onToggle: (index: number) => void;
	onDontKnow: () => void;
	onOther: () => void;
	other: string;
	onOtherText: (text: string) => void;
}

export function SketchChoices({
	kind,
	multi,
	options,
	sel,
	onToggle,
	onDontKnow,
	onOther,
	other,
	onOtherText,
}: SketchChoicesProps) {
	return (
		<div data-testid="sketch-choices" className="mt-3 flex flex-col gap-2 border-t pt-3">
			<div role={multi ? "group" : "radiogroup"} className="flex flex-col gap-1.5">
				{options.map((opt, i) => {
					const isSel = sel.selected.has(i);
					return (
						<button
							key={opt.value}
							type="button"
							role={multi ? "checkbox" : "radio"}
							aria-checked={isSel}
							data-testid={`sketch-choice-${i}`}
							onClick={() => onToggle(i)}
							className={cn(
								"flex items-start gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors",
								isSel ? "border-primary bg-accent" : "hover:bg-accent/50",
							)}
						>
							<span
								className={cn(
									"mt-0.5 flex size-4 shrink-0 items-center justify-center border text-[11px] leading-none",
									multi ? "rounded-sm" : "rounded-full",
									isSel ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
								)}
							>
								{isSel && (multi ? "✓" : <span className="size-1.5 rounded-full bg-current" />)}
							</span>
							<span className="min-w-0">
								<MessageResponse>{opt.label}</MessageResponse>
								{/* Quiz options never show a description (it telegraphed correctness). */}
								{kind !== "quiz" && opt.description && (
									<MessageResponse className="lh-prose block text-xs text-muted-foreground">{opt.description}</MessageResponse>
								)}
							</span>
						</button>
					);
				})}
				{kind === "quiz" && (
					<button
						type="button"
						aria-pressed={sel.dontKnow}
						data-testid="sketch-choice-dontknow"
						onClick={onDontKnow}
						className={cn(
							"rounded-lg border border-dashed px-2.5 py-1.5 text-left text-sm transition-colors",
							sel.dontKnow ? "border-primary text-foreground" : "text-muted-foreground hover:bg-accent/50",
						)}
					>
						I don't know
					</button>
				)}
				{kind === "ask" && (
					<div
						className={cn(
							"flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-sm",
							sel.otherSelected ? "border-primary bg-accent" : "text-muted-foreground",
						)}
					>
						<button
							type="button"
							role={multi ? "checkbox" : "radio"}
							aria-checked={sel.otherSelected}
							data-testid="sketch-choice-other"
							onClick={onOther}
							className="shrink-0"
						>
							Other…
						</button>
						{sel.otherSelected && (
							<input
								value={other}
								onChange={(e) => onOtherText(e.target.value)}
								data-testid="sketch-choice-other-input"
								aria-label="Your own answer"
								className="min-w-0 flex-1 bg-transparent text-foreground outline-none"
							/>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
