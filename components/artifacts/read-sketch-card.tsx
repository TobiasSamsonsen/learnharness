"use client";

import { useContext, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { ChatActionsContext } from "@/components/chat";
import { SketchThumbnail } from "@/components/sketch/sketch-thumbnail";
import { Button } from "@/components/ui/button";
import { repairMathForDisplay, type ArtifactPartProps } from "@/src/core";

/**
 * The read-back card (Android plan M2, owner wording "I read:"): the
 * tutor's transcription of the learner's handwriting, shown under the
 * learner's own submission — the sketch, the reading in math, the doubts —
 * with "That's not what I wrote" (a dispute: a recorded input that makes
 * the tutor read again; shown only while idle with no question waiting,
 * and only on the newest reading of the sketch).
 *
 * The card renders from the call's own arguments (sketchId, reading,
 * uncertain): the record fact, nothing derived.
 */

interface ReadSketchInput {
	sketchId?: unknown;
	reading?: unknown;
	uncertain?: unknown;
}

export function ReadSketchCard({ part }: ArtifactPartProps) {
	const actions = useContext(ChatActionsContext);
	const input = (part.input ?? {}) as ReadSketchInput;
	const sketchId = typeof input.sketchId === "string" ? input.sketchId : "";
	const reading = typeof input.reading === "string" ? input.reading : "";
	const doubts = Array.isArray(input.uncertain) ? input.uncertain.filter((u): u is string => typeof u === "string" && u.trim() !== "") : [];
	const [asking, setAsking] = useState(false);
	// Uncontrolled: the words are read on submit, nothing renders from them.
	const wroteRef = useRef<HTMLInputElement>(null);

	if (!sketchId || !reading) return null;
	// The dispute button needs a finished call (its result is the record's
	// fact) — and the chat's say on whether a dispute can go out right now.
	const dispute =
		part.state === "output-available" ? (actions?.sketchDispute?.state(sketchId, part.toolCallId) ?? "none") : "none";

	return (
		<div data-testid="read-sketch-card" className="lh-card-enter my-1 rounded-xl border bg-card p-3">
			{actions && <SketchThumbnail chatId={actions.chatId} sketch={{ id: sketchId, pages: [] }} />}
			<div className="text-xs font-medium text-muted-foreground">I read:</div>
			<div data-testid="read-sketch-reading" className="lh-prose mt-1 text-[15px]">
				<MessageResponse>{repairMathForDisplay(reading)}</MessageResponse>
			</div>
			{doubts.length > 0 && (
				<div data-testid="read-sketch-doubts" className="mt-2 text-sm text-muted-foreground">
					<div className="text-xs font-medium">Not sure about:</div>
					<ul className="mt-0.5 list-disc pl-5">
						{doubts.map((d, i) => (
							<li key={i}>{d}</li>
						))}
					</ul>
				</div>
			)}
			{dispute === "disputed" && (
				<div data-testid="read-sketch-disputed" className="mt-2 text-xs text-muted-foreground/80">
					You said this reading is wrong.
				</div>
			)}
			{dispute === "available" && !asking && (
				<button
					type="button"
					data-testid="read-sketch-dispute"
					onClick={() => setAsking(true)}
					className="mt-2 text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
				>
					That's not what I wrote
				</button>
			)}
			{dispute === "available" && asking && (
				<form
					data-testid="read-sketch-dispute-form"
					className="mt-2 flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						actions?.sketchDispute?.send(sketchId, wroteRef.current?.value.trim() || undefined);
						setAsking(false);
					}}
				>
					<input
						ref={wroteRef}
						autoFocus
						onKeyDown={(e) => {
							// Esc closes this field only, never the page's chain.
							if (e.key === "Escape") {
								e.preventDefault();
								e.stopPropagation();
								setAsking(false);
							}
						}}
						maxLength={2000}
						placeholder="What did you write? (optional)"
						className="lh-input h-8 min-w-0 flex-1 rounded-md border border-border/70 bg-background/60 px-2 text-sm outline-none focus:border-primary/50"
					/>
					<Button type="submit" size="sm" data-testid="read-sketch-dispute-send" className="h-8 px-3 text-xs">
						Send
					</Button>
				</form>
			)}
		</div>
	);
}

/** The learner's dispute, in the transcript (the marker's own line). */
export function SketchDisputeLine({ data }: { data: { sketchId?: unknown; text?: unknown } }) {
	const text = typeof data.text === "string" ? data.text : "";
	return (
		<div data-testid="sketch-dispute-line" className="my-2 px-1 text-sm text-muted-foreground">
			You said the reading was wrong{text ? <>: <span className="italic">{text}</span></> : "."}
		</div>
	);
}
