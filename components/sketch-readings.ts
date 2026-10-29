import { healReadSketchArguments, type ArtifactPartProps, type QuestionAnswerData } from "@/src/core";
import type { PracticeThinkingData } from "@/components/practice-cards";

/**
 * One box per sketch (owner, 2026-10-29): the answer or thinking card that shows a sketch (or a photo) carries its NEWEST
 * reading under the image, and the read_sketch cards of that sketch render nothing. The reading goes to the FIRST card that
 * shows the sketch (a kept sketch sent again with a later text submit was read once, under the first). Pure, over the chat's UI
 * messages.
 */

const QUESTION_TOOL_PARTS = new Set(["tool-quiz", "tool-probe", "tool-ask_user_question", "tool-explain", "tool-recall"]);

interface LoosePart {
	type: string;
	state?: string;
	input?: unknown;
	output?: unknown;
	data?: unknown;
}

export function buildSketchReadings(messages: ReadonlyArray<{ parts: ReadonlyArray<unknown> }>): {
	/** Does an answer or thinking card show this sketch? */
	shown: (sketchId: string) => boolean;
	/** The reading to render inside the card at message `mi`, part `pi`, which shows `sketchId` (undefined: none, or not this card). */
	readingFor: (mi: number, pi: number, sketchId: string | undefined) => ArtifactPartProps["part"] | undefined;
} {
	const newest = new Map<string, ArtifactPartProps["part"]>();
	const cardOf = new Map<string, string>();
	messages.forEach((m, mi) =>
		m.parts.forEach((raw, pi) => {
			const p = raw as LoosePart;
			let shownId: string | undefined;
			if (p.type === "tool-read_sketch") {
				const sid = (healReadSketchArguments(p.input) as { sketchId?: unknown } | undefined)?.sketchId;
				if (typeof sid === "string") newest.set(sid, raw as ArtifactPartProps["part"]);
			} else if (p.type === "data-practice-thinking") {
				shownId = (p.data as PracticeThinkingData | undefined)?.sketch?.id;
			} else if (QUESTION_TOOL_PARTS.has(p.type) && p.state === "output-available") {
				shownId = (p.output as QuestionAnswerData | undefined)?.sketch?.id;
			}
			if (shownId && !cardOf.has(shownId)) cardOf.set(shownId, `${mi}:${pi}`);
		}),
	);
	return {
		shown: (sketchId) => cardOf.has(sketchId),
		readingFor: (mi, pi, sketchId) => (sketchId && cardOf.get(sketchId) === `${mi}:${pi}` ? newest.get(sketchId) : undefined),
	};
}
