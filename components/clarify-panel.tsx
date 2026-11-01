"use client";

import { useEffect, useRef, useState } from "react";
import { SendIcon, XIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { enterSends } from "@/components/enter-submits";
import type { Clarification } from "@/src/core";
import { CLARIFY_QUESTION_MAX } from "@/src/core";

export interface ClarifyPanelProps {
	/** The pending question's earlier pairs, oldest first. */
	thread: readonly Clarification[];
	/** A question is out and the tutor has not answered yet. */
	busy: boolean;
	error: string | null;
	/** The text marked in the learning text (the Ask button's hand-over); null =
	 *  nothing to ask about right now. */
	quote: string | null;
	onClearQuote: () => void;
	/** Resolves to whether the answer arrived (then the field clears). */
	onAsk: (quote: string, question: string) => Promise<boolean>;
}

/**
 * The dock's Ask area (owner design, 2026-11-01): the marked text quoted, a field
 * for the question, and the tutor's answers to the earlier ones. It sits above the
 * answer form and never touches the quiz's own state — the question stays pending
 * until the learner answers it. Renders nothing until there is something to show.
 */
export function ClarifyPanel({ thread, busy, error, quote, onClearQuote, onAsk }: ClarifyPanelProps) {
	const [question, setQuestion] = useState("");
	const fieldRef = useRef<HTMLTextAreaElement>(null);

	// A freshly marked passage puts the cursor in the field.
	useEffect(() => {
		if (quote) fieldRef.current?.focus();
	}, [quote]);

	if (thread.length === 0 && !quote && !busy && !error) return null;

	const send = async () => {
		const text = question.trim();
		if (!quote || !text || busy) return;
		if (await onAsk(quote, text)) {
			setQuestion("");
			onClearQuote();
		}
	};

	return (
		<div data-testid="clarify-panel" className="border-t border-border/60 px-4 py-2.5 text-sm">
			<div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Ask about the text</div>

			{thread.length > 0 && (
				<ul className="mb-2 flex max-h-48 flex-col gap-3 overflow-y-auto" data-testid="clarify-thread">
					{thread.map((c) => (
						<li key={c.id} className="flex flex-col gap-1">
							<blockquote className="line-clamp-2 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">{c.quote}</blockquote>
							<p className="font-medium">{c.question}</p>
							<div className="text-muted-foreground">
								<ToolContentResponse>{c.reply}</ToolContentResponse>
							</div>
						</li>
					))}
				</ul>
			)}

			{busy && (
				<p className="mb-2 text-xs text-muted-foreground" role="status" data-testid="clarify-busy">
					The tutor is answering…
				</p>
			)}
			{error && (
				<p className="mb-2 text-xs text-destructive" role="alert" data-testid="clarify-error">
					{error}
				</p>
			)}

			{quote && (
				<div className="flex flex-col gap-1.5" data-testid="clarify-ask">
					<div className="flex items-start gap-2">
						<blockquote className="line-clamp-3 min-w-0 flex-1 border-l-2 border-primary/60 pl-2 text-xs italic text-muted-foreground" data-testid="clarify-quote">
							{quote}
						</blockquote>
						<button
							type="button"
							onClick={onClearQuote}
							aria-label="Clear the marked text"
							className="lh-touch shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							<XIcon className="size-3.5" aria-hidden />
						</button>
					</div>
					<div className="flex items-end gap-1.5 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
						<textarea
							ref={fieldRef}
							value={question}
							maxLength={CLARIFY_QUESTION_MAX}
							onChange={(e) => setQuestion(e.target.value)}
							onKeyDown={(e) => {
								// the dock's keyboard machine must not see typing in this field
								e.stopPropagation();
								if (e.key === "Escape") {
									e.preventDefault();
									onClearQuote();
									return;
								}
								if (enterSends(e)) {
									e.preventDefault();
									void send();
								}
							}}
							placeholder="Ask about the marked text…"
							rows={1}
							data-testid="clarify-field"
							className="field-sizing-content lh-input max-h-32 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
						/>
						<button
							type="button"
							onClick={() => void send()}
							disabled={busy || !question.trim()}
							aria-label="Send the question"
							data-testid="clarify-send"
							className="lh-touch m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
						>
							<SendIcon className="size-4" aria-hidden />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
