"use client";

import { LightbulbIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { hintLabel, type HintControl } from "@/components/use-hints";

/**
 * The hints, in the sketch view (owner, 2026-11-17): the card that opens under the toolbar's Hint button, the same list the
 * dock shows. It is rendered inside the toolbar's touch-hole layer (data-ink-hole on the card in sketch-toolbar.tsx), so native
 * ink never draws under it. A hint asked for here reads the page as it stands now (use-hints.ts), so the card says so while it waits.
 */
export function SketchHintCard({ hint }: { hint: HintControl }) {
	return (
		<div data-testid="sketch-hint-list" className="flex flex-col gap-2 text-sm">
			{hint.lines.length === 0 && !hint.busy && !hint.error && (
				<p className="text-muted-foreground">Ask for a hint. It reads what you have written so far.</p>
			)}
			{hint.lines.map((line, i) => (
				<div key={i} className="flex gap-2 text-foreground/90">
					<span className="shrink-0 pt-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Hint {i + 1}</span>
					<div className="min-w-0 flex-1">
						<ToolContentResponse>{line.text}</ToolContentResponse>
					</div>
				</div>
			))}
			{hint.busy && <p className="text-muted-foreground">Reading your sketch…</p>}
			{hint.error && (
				<div role="alert" className="text-xs text-destructive">
					{hint.error}
				</div>
			)}
			{hint.lines.length < hint.max && (
				<button
					type="button"
					data-testid="sketch-hint-ask"
					disabled={hint.disabled}
					onClick={hint.ask}
					className="lh-touch inline-flex h-9 items-center justify-center gap-1.5 self-start rounded-full border bg-secondary px-4 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:pointer-events-none disabled:opacity-50"
				>
					<LightbulbIcon className="size-4" />
					{hint.lines.length === 0 ? "Get a hint" : "Another hint"} {hint.lines.length > 0 && !hint.busy ? `(${hint.lines.length} of ${hint.max} used)` : ""}
				</button>
			)}
			{hint.lines.length >= hint.max && <p className="text-xs text-muted-foreground">{hintLabel(hint)}</p>}
		</div>
	);
}
