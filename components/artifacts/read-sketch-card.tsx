"use client";

import { ChevronRightIcon } from "lucide-react";
import { useContext, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { ChatActionsContext } from "@/components/chat";
import { SketchThumbnail } from "@/components/sketch/sketch-thumbnail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { healReadSketchArguments, repairMathForDisplay, type ArtifactPartProps } from "@/src/core";

/**
 * The read-back (Android plan M2, owner wording "I read:"): the tutor's
 * transcription of the learner's handwriting (or photo) — the reading in math,
 * the doubts — with "That's not what I wrote" (a dispute: a recorded input that
 * makes the tutor read again; shown only while idle with no question waiting,
 * and only on the newest reading of the sketch).
 *
 * It lives INSIDE the box of the answer it reads (owner, 2026-10-29: the sketch
 * showed twice, once in the answer box and once in a box of its own): the answer
 * card shows the image once and this reading beneath it. Only the newest reading
 * of a sketch is shown there. The standalone card below renders only for a
 * sketch no answer or thinking card shows (and without the chat's context).
 *
 * It renders from the call's own arguments (sketchId, reading, uncertain,
 * settled): the record fact, nothing derived.
 */

interface ReadSketchInput {
	sketchId?: unknown;
	reading?: unknown;
	uncertain?: unknown;
	settled?: unknown;
}

/** What the chat knows about readings, for the cards that show them (built in chat.tsx from the messages). */
export interface SketchReadings {
	/** Is this sketch shown by an answer or thinking card? Its readings render inside that card, not as cards of their own. */
	shown: (sketchId: string) => boolean;
}

type ChatActions = NonNullable<React.ContextType<typeof ChatActionsContext>> | null;

const lines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && u.trim() !== "") : []);

/** The reading's fields and state, from the call's own arguments (healed the way the agent healed them). */
function readingOf(part: ArtifactPartProps["part"], actions: ChatActions) {
	// The record keeps the model's RAW arguments: heal them the way the agent did.
	const input = (healReadSketchArguments(part.input) ?? {}) as ReadSketchInput;
	const sketchId = typeof input.sketchId === "string" ? input.sketchId : "";
	const reading = typeof input.reading === "string" ? input.reading : "";
	const doubts = lines(input.uncertain);
	// Marks the tutor settled against the committed answer (owner, 2026-10-26):
	// shown, so a wrong guess can be spotted and disputed.
	const settled = lines(input.settled);
	// The dispute button needs a finished call (its result is the record's
	// fact) — and the chat's say on whether a dispute can go out right now.
	const dispute: "available" | "disputed" | "none" =
		part.state === "output-available" ? (actions?.sketchDispute?.state(sketchId, part.toolCallId) ?? "none") : "none";
	// OPEN doubts on the newest reading: it asks for the clarification
	// (red) and the tutor writes nothing until it can read again clean
	// (owner, 2026-10-26). An older reading's doubts are history, shown muted.
	const open = doubts.length > 0 && part.state === "output-available" && (actions?.sketchDispute?.isNewest(sketchId, part.toolCallId) ?? false);
	return { sketchId, reading, doubts, settled, dispute, open };
}

/**
 * The reading itself: "I read:", the settled marks, the doubts, the clarification prompt and the dispute button.
 * `framed`: it sits inside an answer card, so open doubts get their own red frame (the standalone card tints its own border).
 */
export function SketchReadingBody({ part, framed = false }: { part: ArtifactPartProps["part"]; framed?: boolean }) {
	const actions = useContext(ChatActionsContext);
	const { sketchId, reading, doubts, settled, dispute, open } = readingOf(part, actions);
	const [asking, setAsking] = useState(false);
	const [showReading, setShowReading] = useState(false);
	// Uncontrolled: the words are read on submit, nothing renders from them.
	const wroteRef = useRef<HTMLInputElement>(null);
	if (!sketchId || !reading) return null;

	return (
		<div
			data-testid={framed ? "answer-sketch-reading" : undefined}
			data-needs-clarification={framed && open ? "true" : undefined}
			className={framed ? cn("mt-3", open && "rounded-lg border border-destructive/60 bg-destructive/5 p-2.5") : undefined}
		>
			{/* The transcription itself stays folded (owner, 2026-10-29): only what the tutor is unsure about is always shown. */}
			<button
				type="button"
				data-testid="read-sketch-toggle"
				aria-expanded={showReading}
				onClick={() => setShowReading((v) => !v)}
				className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon className={cn("size-3.5 transition-transform", showReading && "rotate-90")} />
				I read
			</button>
			{showReading && (
				<div data-testid="read-sketch-reading" className="lh-prose mt-1 text-[15px]">
					<MessageResponse>{repairMathForDisplay(reading)}</MessageResponse>
				</div>
			)}
			{settled.length > 0 && (
				<div data-testid="read-sketch-settled" className="mt-2 text-sm text-muted-foreground">
					<div className="text-xs font-medium">Took these as:</div>
					<ul className="mt-0.5 list-disc pl-5">
						{settled.map((d, i) => (
							<li key={i}>{d}</li>
						))}
					</ul>
				</div>
			)}
			{doubts.length > 0 && (
				<div data-testid="read-sketch-doubts" className={cn("mt-2 text-sm", open ? "text-destructive" : "text-muted-foreground")}>
					<div className="text-xs font-medium">{open ? "Needs your clarification:" : "Not sure about:"}</div>
					<ul className="mt-0.5 list-disc pl-5">
						{doubts.map((d, i) => (
							<li key={i}>{d}</li>
						))}
					</ul>
				</div>
			)}
			{open && (
				<div data-testid="read-sketch-clarify" className="mt-1.5 text-xs text-destructive/80">
					Answer below to continue.
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

/** The standalone card: for a reading whose sketch no answer or thinking card shows. */
export function ReadSketchCard({ part }: ArtifactPartProps) {
	const actions = useContext(ChatActionsContext);
	const { sketchId, reading, open } = readingOf(part, actions);
	if (!sketchId || !reading) return null;
	// The answer or thinking card that shows this sketch carries its newest reading (owner, 2026-10-29): no second box.
	if (actions?.sketchReadings?.shown(sketchId)) return null;

	return (
		<div
			data-testid="read-sketch-card"
			data-needs-clarification={open ? "true" : undefined}
			className={cn("lh-card-enter my-1 rounded-xl border p-3", open ? "border-destructive/60 bg-destructive/5" : "bg-card")}
		>
			{actions && <SketchThumbnail chatId={actions.chatId} sketch={{ id: sketchId, pages: [] }} />}
			<SketchReadingBody part={part} />
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
