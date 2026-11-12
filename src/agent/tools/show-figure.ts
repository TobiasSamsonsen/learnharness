import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { SHOW_FIGURE_TOOL, figureLabel, figuresOf } from "../../core/figure-show.ts";

/**
 * show_figure (owner, 2026-11-12 — core/figure-show.ts): a finished `visual`
 * or `demo` stays hidden until the tutor calls this, in the turn whose
 * teaching it serves; the card renders at that point of the transcript
 * (the view joins the figure onto this call by job id). Teacher only, always
 * on. The figure is looked up in the chat's messages, never in data/jobs
 * (job records do not sync between devices). The result is one line: the
 * figure itself never re-enters the tutor's context.
 */

const showFigureInput = Type.Object({
	figure: Type.String({ minLength: 1, description: "The figure's job id, from its arrival message (e.g. job_mx1abc_1234abcd)" }),
	caption: Type.Optional(Type.String({ description: "One short line shown under the figure" })),
});

const SHOW_FIGURE_DESCRIPTION =
	"Show a finished figure or demo to the learner at this point of the lesson. Finished figures stay hidden until you call this. " +
	"Call it in the turn whose explanation the figure serves, next to that teaching, so the card appears right there, before any question you ask. " +
	"figure = the job id from the figure's arrival message. Show a figure again later only when bringing it back genuinely helps.";

export interface ShowFigureDetails {
	jobId: string;
	kind: "visual" | "demo";
	caption?: string;
}

/** `messages` reads the run's live history (the agent's state), so a figure delivered earlier in this run is found. */
export function createShowFigureTool(ctx: { messages: () => readonly unknown[] }): AgentTool<typeof showFigureInput> {
	return {
		name: SHOW_FIGURE_TOOL,
		label: SHOW_FIGURE_TOOL,
		description: SHOW_FIGURE_DESCRIPTION,
		parameters: showFigureInput,
		execute: serverExecute(SHOW_FIGURE_TOOL, showFigureInput, ({ figure, caption }): ImageFileResult => {
			const messages = ctx.messages();
			const all = figuresOf(messages);
			const id = figure.trim();
			const found = all.get(id);
			if (!found || !found.ok) {
				const ready = [...all.values()].filter((f) => f.ok).map((f) => `${f.jobId} (${f.kind}: "${figureLabel(messages, f)}")`);
				const why = !found
					? `No finished figure or demo with id "${id}" in this lesson (a figure still being made cannot be shown yet).`
					: `Figure "${id}" could not be made, so there is nothing to show.`;
				throw new Error(`${why} ${ready.length > 0 ? `Figures you can show: ${ready.join(", ")}.` : "No figure is ready to show."}`);
			}
			const trimmed = caption?.trim();
			const details: ShowFigureDetails = { jobId: found.jobId, kind: found.kind, ...(trimmed ? { caption: trimmed } : {}) };
			return { text: `Shown: figure ${found.jobId} (${found.kind}).`, details };
		}),
	};
}
