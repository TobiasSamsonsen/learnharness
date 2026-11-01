"use client";

import type { ReactNode } from "react";
import { MaterialsControl } from "@/components/materials-control";
import { LanguageControl } from "@/components/language-control";
import { PaceControl } from "@/components/pace-control";

/**
 * The composer shell's bottom edge (owner, 2026-10-25 — the bottom-bar
 * declutter, "split by scope"): what shapes the CONTENT — the lesson's
 * sources and language — and the mic sit where the learner types; the
 * row beneath the shell keeps only the session's stats and the model.
 *
 * The composer renders the edge itself (its send button closes the row);
 * the question and practice docks get the standalone row beneath them, so
 * the mic stays where it was while an answer is dictated.
 */

/** The edge's leading tools: Sources + language, as quiet edge buttons. */
export function ComposerEdgeTools({ chatId }: { chatId?: string }) {
	return (
		<>
			<MaterialsControl chatId={chatId} variant="edge" />
			<LanguageControl chatId={chatId} variant="edge" />
			{/* Pace (fork addition, 2026-11-01): a running session only; the new-session screen has its setup panel. */}
			{chatId && <PaceControl chatId={chatId} variant="edge" />}
		</>
	);
}

/** The standalone edge row (beneath a dock): tools left, the mic right.
 *  While recording, the mic's meter fills the free middle. */
export function ComposerEdge({ chatId, mic, trailing }: { chatId?: string; mic?: ReactNode; trailing?: ReactNode }) {
	return (
		<div data-testid="composer-edge" className="flex min-w-0 items-center gap-1">
			<ComposerEdgeTools chatId={chatId} />
			<div className="flex min-w-0 flex-1 items-center justify-end">{mic}</div>
			{trailing}
		</div>
	);
}
