import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { PlanToolResult, PlanTree } from "../../core/contracts.ts";
import type { ChatStore } from "../../core/ports.ts";
import { createTree, PlanTreeError } from "../../core/plan-tree.ts";
import { parseMermaidPlan } from "./mermaid-plan.ts";

/** The binding-id reminder riding plan_init's slim content (owner,
 *  2026-10-09): plan_init is the exact moment the node ids become
 *  load-bearing — every later quiz/explain call must reference one. The
 *  field-drop incidents (tools_fails_2) showed the turn's tail is where
 *  discipline slips; the reminder lands right there. */
const PLAN_NODE_IDS_REMINDER =
	"These are the plan's node ids — the only valid nodeId values for every quiz and explain call from here on. Reference them exactly.";

/** The follow-up the plan_init result carries for the `visual` decision (owner,
 *  2026-11-10 — core/visual-gate.ts enforces the first of the two). The tutor
 *  never used `visual`/`demo` unprompted: across 14 chats, one demo, on request. */
const VISUAL_DISPATCH_REMINDER =
	"Your plan calls for a picture: dispatch it now with `visual` (a static figure) or `demo` (something to sweep or animate), before your first quiz or explain — those calls are refused until a job is dispatched. Do not mention it to the learner; it stays hidden until you show it with show_figure at the step it serves.";
const VISUAL_NONE_REMINDER = "You chose no picture for this plan; if a concept turns out to need one, dispatch `visual` or `demo` anyway.";

/** What the plan tools close over (the plan-tree half of the tool context). */
export interface PlanToolContext {
	chatId: string;
	/** The storage port plan tools persist through. */
	chatStore: ChatStore;
}

/**
 * The plan tool — AUTHOR-ONCE protocol (2026-09-03 design pass): the teacher
 * WRITES the map and never tracks progress. One tool, plan_init, takes the
 * whole dependency map as a mermaid `graph TD` block:
 *
 *   - call it ONCE right after the probe concludes, to present the map (the
 *     LEARNER'S ACCEPTANCE of the presented plan, not this call, ends
 *     planning — docs/archive/probe-teach-split.md §4)
 *   - statuses (current / visited / upcoming) are DERIVED from the quiz
 *     nodeId tags the teacher fires (contracts.ts derivePlanStatuses) — the
 *     teacher never declares them, and there is no "done" bookkeeping
 *   - re-call it any time the map is wrong: the new block replaces the tree
 *     wholesale. Node slugs are permanent — the map tracks nothing between
 *     rewrites
 *   - checks name the node they assess (quiz nodeId, validated against the
 *     live tree at the call boundary) — that tag is the only thing statuses
 *     derive from
 *
 * The former mutation tools (add/update/remove node/edge, set_current,
 * mark_done) are gone by design: restructuring is a rewrite, tracking is
 * derived. SERVER-SIDE with execute: parse → validate → persist. The
 * result is CONTEXT-SLIM (owner, context diet 2026-10-09): the model
 * WROTE the mermaid one message ago, so content never echoes the tree —
 * it carries the validated nodeIds + the binding-nodeId reminder (the
 * exact moment the ids become load-bearing); `details` keeps the full
 * tree for the record and the plan popup (latestTree reads it — the
 * agent-invisible channel, serializer-verified).
 */
const planInitInput = Type.Object({
	mermaid: Type.String({
		minLength: 1,
		description:
			"A mermaid graph block (any direction), e.g.:\ngraph TD\n  primitives[Number primitives] --> operators[Arithmetic operators] --> expressions[Evaluating expressions]\n" +
			"The only strict rule: ids are permanent lowercase slugs (a-z, 0-9, hyphens/underscores) — checks reference them via nodeId. " +
			"Titles are free single-line text; `-->` means 'from = prerequisite' (chains fine); no subgraphs, styles, or classes.",
	}),
	sources: Type.Optional(
		Type.String({
			description:
				"In a course lesson with sources: one or two sentences on what you found when you searched them for this skill (what the exams ask, the course's definitions and notation) and what the plan uses from it, cited as (name, p. N). " +
				"If they do not cover the skill, say what you searched for. Required on the first plan of such a lesson; omit it elsewhere.",
		}),
	),
	visual: Type.Object(
		{
			use: Type.Union([Type.Literal("visual"), Type.Literal("demo"), Type.Literal("none")], {
				description:
					'"visual" = a static figure (a function graph with its bands, a tangent line, an area, a geometry layout); "demo" = something the learner should sweep or animate; "none" = no picture helps this lesson.',
			}),
			reason: Type.String({
				minLength: 1,
				description:
					"One line: what the picture must show and at which node (visual/demo), or why no picture helps (none). Judge it by the concept: many ideas (limits, slopes, areas, vectors, distributions) are far easier to grasp seen than described.",
			}),
		},
		{
			description:
				"REQUIRED decision, made every time you write the plan: does this lesson have a visual core? Consider it honestly, since a picture often turns a long explanation into a glance. " +
				'`{"use":"visual","reason":"…"}`, `{"use":"demo","reason":"…"}` or `{"use":"none","reason":"…"}`. With visual/demo you must dispatch it before your first quiz or explain.',
		},
	),
});

export function planTools(ctx: PlanToolContext): Record<string, AgentTool<any>> {
	return {
		plan_init: {
			name: "plan_init",
			label: "plan_init",
			description:
				"Write or REWRITE this session's plan map — the dependency graph the learner follows live in the plan window. " +
				"Call once right after the probe concludes, to present the map; re-call whenever the map is wrong (the new block replaces the old tree). " +
				"A mermaid graph block (any direction): one node per line (`slug[Short Title]` — slugs are permanent lowercase ids: a-z, 0-9, hyphens/underscores), " +
				"`-->` edges meaning 'from must be understood before to' (chains fine). As many nodes as the subject needs: a map, not a syllabus — structural landmarks, not one node per turn of teaching. " +
				"Every check you fire names the node it assesses via `nodeId`; where the lesson stands derives from those tags. " +
				"Every plan also carries a `visual` decision (visual / demo / none, with a reason): consider honestly whether a picture would make the concept easier. " +
				"In a course lesson with sources, search them first and say in `sources` what you found.",
			parameters: planInitInput,
			execute: serverExecute("plan_init", planInitInput, async ({ mermaid, visual }) => {
				const { chatId, chatStore } = ctx;
				const record = chatStore.getChat(chatId);
				if (!record) return { ok: false, error: `Chat not found: ${chatId}` };

				const parsed = parseMermaidPlan(mermaid);
				if (!parsed.ok || !parsed.plan) {
					// The parser collects every problem; the teacher fixes and retries.
					// No tree echo — the model needs the problems, not a restatement of
					// the map it is rewriting (owner, context diet 2026-10-09).
					return { ok: false, error: parsed.problems.join("\n") };
				}
				try {
					// createTree validates the structure (duplicate ids, missing
					// edge endpoints, self-loops, cycles → PlanTreeError).
					const next = createTree(parsed.plan.nodes, parsed.plan.edges);
					chatStore.saveTree(chatId, next);
					// Context diet: content = the validated nodeIds + the reminder (the
				// ids just became binding for every quiz/explain call); details =
					// the full tree for the record/UI — the plan popup's latestTree
					// seam, agent-invisible (the serializer sends content only).
					return {
						text: JSON.stringify({
							ok: true,
							nodeIds: next.nodes.map((n) => n.id),
							reminder: PLAN_NODE_IDS_REMINDER,
							...(visual?.use === "visual" || visual?.use === "demo"
								? { visualReminder: VISUAL_DISPATCH_REMINDER }
								: visual?.use === "none"
									? { visualReminder: VISUAL_NONE_REMINDER }
									: {}),
						}),
						details: { ok: true, tree: next },
					};
				} catch (err) {
					if (err instanceof PlanTreeError) return { ok: false, error: err.message };
					throw err;
				}
			}),
		},
	};
}