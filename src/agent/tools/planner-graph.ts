import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { getGraph } from "../../core/graph.ts";
import { createPropositionCandidateSearch, propositionCandidateBatch, type CandidateBatch, type CandidateProposition, type CandidateRequest } from "../../core/proposition-candidates.ts";
import { prepareAuditorReview, type GraphToolContext } from "./graph.ts";

/**
 * THE COURSE PLANNER'S GRAPH TOOLS (fork addition, upstream v0.4.1 merge).
 *
 * Upstream's auditor tool `find_candidates` looks up the ids of findings the
 * extraction already proposed. The course planner has no such findings while
 * it explores, so it gets its own `find_candidates`: ad-hoc TEXT queries run
 * through the same ranker (core/proposition-candidates.ts: BM25 over names,
 * statements and aliases, five per page, full statements, born-in sessions).
 * Each query becomes a throwaway proposition, so the ranking, paging and
 * output shape are upstream's; nothing here changes the auditor.
 *
 * list_sessions and list_propositions are upstream's auditor tools, reused.
 */

export interface PlannerCandidateBatch {
	matches: Array<{ query: string; candidateIds: string[]; nextCursor: string | null }>;
	candidates: CandidateBatch["candidates"];
}

interface PlannerQuery {
	text: string;
	hints?: readonly string[];
	cursor?: string;
}

interface Continuation {
	text: string;
	hints: readonly string[] | undefined;
	offset: number;
}

const findInput = Type.Object({
	queries: Type.Array(Type.Object({
		text: Type.String({ minLength: 1, description: "What to look for: a skill, fact or ability in plain words. Its words are ranked against every proposition's name, statement and aliases." }),
		hints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
			description: "Optional alternative words or phrases to add to the search. Plain text, not glob patterns.",
		})),
		cursor: Type.Optional(Type.String({ minLength: 1, description: "Continue a previous query with its nextCursor, repeating its text. Do not supply hints with a cursor; its query is already fixed. Omit cursor to start a new search at its first page." })),
	}, { additionalProperties: false }), { minItems: 1, description: "One entry per thing to look up." }),
}, { additionalProperties: false });

export function plannerGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const continuations = new Map<string, Continuation>();
	const tokens = new Map<string, string>();

	function lookup(requests: readonly PlannerQuery[]): PlannerCandidateBatch {
		const resolved = requests.map((request): Continuation => {
			if (request.cursor === undefined) return { text: request.text, hints: request.hints, offset: 0 };
			if (request.hints !== undefined) throw new Error("A continuation already fixes its query. Omit hints, or omit cursor to start a new search.");
			const query = continuations.get(request.cursor);
			if (!query || query.text !== request.text) throw new Error("Unknown cursor for this text. Start a fresh lookup without cursor.");
			return query;
		});
		// Throwaway propositions: the id only keys the batch, the text is what is ranked.
		const propositions: CandidateProposition[] = resolved.map((query, index) => ({ id: `q${index}`, name: "", statement: query.text, aliases: [] }));
		const queries: CandidateRequest[] = resolved.map((query, index) => ({ id: `q${index}`, hints: query.hints, offset: query.offset }));
		const search = createPropositionCandidateSearch(getGraph(ctx.graphStore).nodes);
		const batch = propositionCandidateBatch(search, propositions, queries);
		return {
			matches: batch.matches.map((match, index) => {
				let nextCursor: string | null = null;
				if (match.nextOffset !== null) {
					const query = resolved[index]!;
					const next: Continuation = { ...query, offset: match.nextOffset };
					const key = JSON.stringify([next.text, next.hints ?? [], next.offset]);
					nextCursor = tokens.get(key) ?? randomUUID();
					tokens.set(key, nextCursor);
					continuations.set(nextCursor, next);
				}
				return { query: resolved[index]!.text, candidateIds: match.candidateIds, nextCursor };
			}),
			candidates: batch.candidates,
		};
	}

	const { list_sessions, list_propositions } = prepareAuditorReview(ctx).tools;
	return {
		find_candidates: {
			name: "find_candidates",
			label: "find_candidates",
			description:
				"Find existing graph propositions for a batch of text queries, with optional hints. " +
				"Ranks word overlap across names, statements and aliases, not exact phrases or glob patterns. " +
				"A new query returns five ranked candidates; nextCursor continues that exact query. " +
				"Each candidate's full statement, matched aliases and birth sessions appear once in candidates; matches lists candidate ids per query. " +
				"A query with no match means nothing in the graph fits; a continuation is an option, not a requirement to keep searching. " +
				"There is no cross-call suppression: repeating a request returns its full page again.",
			parameters: findInput,
			execute: serverExecute("find_candidates", findInput, async (input) => lookup(input.queries)),
		},
		list_sessions: list_sessions!,
		list_propositions: list_propositions!,
	};
}
