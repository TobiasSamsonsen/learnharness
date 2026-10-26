/**
 * read_sketch (Android plan M2, 2026-10-26): the tutor's transcription of
 * the learner's handwriting, made BEFORE any grading. The call and its
 * result ARE the record fact (persistTurn stores them like any tool pair):
 * the card shows the reading to the learner, the conclude gate folds it
 * (core/sketch-gate.ts), replay elision leans on it. No new store.
 *
 * Mechanics-only description (the doctrine ruling): the method — exact
 * transcription, doubts, never correcting — lives in the system prompt
 * (prompts/shared/18-sketches.md).
 *
 * Registered ALWAYS, for all four agents: toggling it would change the
 * tool list, and claude-code respawns (and the cache misses) on that.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../tool-execute.ts";

export const readSketchInputObject = Type.Object({
	sketchId: Type.String({
		description: "REQUIRED — the id from the [sketch sk_…] label of the page(s) you are reading.",
	}),
	reading: Type.String({
		description:
			"REQUIRED — exactly what is written, errors included, never corrected. Equations as LaTeX in $…$; a diagram as its structure " +
			"(blocks, arrows, labels, values).",
	}),
	uncertain: Type.Array(Type.String(), {
		description: "REQUIRED — every doubtful mark you could NOT settle, one plain-language line each; [] when there are none.",
	}),
	settled: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Unclear marks you settled against the committed answer, one plain line each (what it could be, what you took). " +
				"Omit when there are none.",
		}),
	),
});

export type ReadSketchInput = Static<typeof readSketchInputObject>;

export const READ_SKETCH_ACK = "Reading recorded. Now respond to the work.";
export const READ_SKETCH_DOUBT_ACK =
	"Reading recorded, with doubts. STOP: write nothing now — the learner sees the doubts on the card and will clarify. " +
	"Read the sketch again once they answer.";

export interface ReadSketchContext {
	/** The sketches the transcript carries (read fresh per call). */
	known: () => ReadonlySet<string>;
	/** A read went through — the practice gate's mid-turn flip. */
	onRead?: (sketchId: string, uncertain: readonly string[]) => void;
}

export function readSketchTool(ctx: ReadSketchContext): AgentTool<typeof readSketchInputObject> {
	return {
		name: "read_sketch",
		label: "read_sketch",
		description:
			"Record your transcription of the learner's handwritten sketch: its id, exactly what is written (errors included, never corrected), " +
			"every doubtful mark you could not settle, and any you settled against the committed answer. Call it first on any turn that carries a sketch, before feedback or grading. The learner sees your reading " +
			"and may dispute it.",
		parameters: readSketchInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if (!ctx.known().has(input.sketchId)) {
				return invalidInputResult("read_sketch", [
					`no sketch ${input.sketchId} in this conversation — use the id from a [sketch sk_… · page i/n] label`,
				]);
			}
			if (input.reading.trim().length === 0) {
				return invalidInputResult("read_sketch", ["reading is empty — transcribe what is written"]);
			}
			ctx.onRead?.(input.sketchId, input.uncertain);
			const doubtful = input.uncertain.length > 0;
			return {
				content: [{ type: "text", text: doubtful ? READ_SKETCH_DOUBT_ACK : READ_SKETCH_ACK }],
				details: { sketchId: input.sketchId, doubts: input.uncertain.length, settled: input.settled?.length ?? 0 },
				// Open doubts end the turn: the card asks for the clarification, and
				// the paragraph waits until everything is verified (owner, 2026-10-26).
				...(doubtful ? { terminate: true } : {}),
			};
		},
	};
}
