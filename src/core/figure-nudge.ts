/**
 * A broken figure in a plain-text reply (owner, 2026-11-25 — the Superposisjon lesson on the tablet: a resistor and a current
 * source both drawn down from one node sat on top of each other). PURE, browser-safe.
 *
 * Every question tool refuses a figure that does not parse or lay out (figureInputProblems), but a figure in a text-only reply
 * reaches the learner unchecked. This is the backstop: when a finished text-only turn carries figures with problems, the run gets
 * ONE hidden reminder listing them, so the tutor redraws (teacher-agent.ts finishTurn, beside the check nudge).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { figureProblems } from "./figures/index.ts";

/** The figure problems of a finished assistant message's text; empty unless it is a text-only stop. */
export function textFigureProblems(message: AssistantMessage): string[] {
	if (message.stopReason !== "stop") return [];
	if (message.content.some((b) => b.type === "toolCall")) return [];
	const texts = message.content.flatMap((b) => (b.type === "text" && b.text.includes("```") ? [b.text] : []));
	return texts.length === 0 ? [] : figureProblems(texts);
}

/** The reminder the model reads (a hidden marker, never shown in the transcript). */
export function figureNudgeText(problems: readonly string[]): string {
	return (
		"[REMINDER — NOT FROM THE LEARNER] A figure in your last reply cannot be drawn as written, so the learner sees an error box instead of it:\n" +
		problems.map((p) => `- ${p}`).join("\n") +
		"\nSend the corrected figure now in a short reply (the figure and one line of what it shows), then carry on with the lesson as planned: pose the next check if one is due."
	);
}
