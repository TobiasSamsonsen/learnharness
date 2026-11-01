// THE COURSE PLANNER'S GRAPH TOOLS (fork addition, upstream v0.4.1 merge) —
// pinned behaviors:
// 1. SURFACE: find_candidates (ad-hoc text queries) + upstream's
//    list_sessions / list_propositions; the auditor's id-based find_candidates
//    and the removed glob `find` are not exposed.
// 2. RANKING: text queries go through upstream's ranker, with full
//    statements, matched aliases and born-in sessions.
// 3. CURSORS: a continuation keeps its exact query, takes no hints, and
//    belongs to the tool instance (and the text) that issued it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plannerGraphTools, type PlannerCandidateBatch } from "../src/agent/tools/planner-graph.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";

const node = (id: string, name: string, statement: string, aliases: string[] = []): GraphNode => ({
	id,
	name,
	statement,
	aliases,
	createdAt: "2026-10-30T00:00:00.000Z",
	provenance: [{ chatId: "c1", messageId: "m1" }],
});

function ctxFor(nodes: GraphNode[]): { chatStore: ChatStore; graphStore: GraphStore } {
	const graphStore = {
		readNodes: () => nodes,
		readChains: () => [],
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
	} as unknown as GraphStore;
	const chatStore = { listChats: () => [], getChat: () => undefined } as unknown as ChatStore;
	return { chatStore, graphStore };
}

describe("planner graph tools", () => {
	const nodes = [
		node("n1", "Chain rule", "The derivative of a composition f(g(x)) is f'(g(x))g'(x).", ["differentiating composites"]),
		node("n2", "Product rule", "The derivative of a product is the sum of each factor's derivative times the other."),
	];

	it("exposes text-query find_candidates beside upstream's two listing tools", () => {
		const tools = plannerGraphTools(ctxFor(nodes));
		assert.deepEqual(Object.keys(tools).sort(), ["find_candidates", "list_propositions", "list_sessions"]);
	});

	it("ranks a text query with full statements, aliases and born-in sessions", async () => {
		const tools = plannerGraphTools(ctxFor(nodes));
		const result = await tools.find_candidates!.execute!("tc", { queries: [{ text: "differentiate composite function chain" }] });
		const out = result.details as PlannerCandidateBatch;
		assert.equal(out.matches[0]!.query, "differentiate composite function chain");
		assert.equal(out.matches[0]!.candidateIds[0], "n1");
		const chain = out.candidates.find((c) => c.id === "n1")!;
		assert.equal(chain.statement, nodes[0]!.statement);
		assert.deepEqual(chain.sessions, ["c1"]);
		assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(out) }]);
		const repeat = await tools.find_candidates!.execute!("tc2", { queries: [{ text: "differentiate composite function chain" }] });
		assert.deepEqual(repeat.details, out, "no hidden cross-call suppression");
	});

	it("reads the graph at call time", async () => {
		const live = [...nodes];
		const tools = plannerGraphTools(ctxFor(live));
		const before = (await tools.find_candidates!.execute!("a", { queries: [{ text: "quotient rule" }] })).details as PlannerCandidateBatch;
		assert.ok(!before.candidates.some((c) => c.id === "n3"));
		live.push(node("n3", "Quotient rule", "The derivative of a quotient u/v is (u'v - uv')/v^2."));
		const after = (await tools.find_candidates!.execute!("b", { queries: [{ text: "quotient rule" }] })).details as PlannerCandidateBatch;
		assert.equal(after.matches[0]!.candidateIds[0], "n3");
	});

	it("continuations keep their exact query, refuse hints, and are bound to the tool instance and text", async () => {
		const graph = [
			...Array.from({ length: 7 }, (_, i) => node(`a${i}`, "Amber", "Amber canoe")),
			node("violet", "Other", "Violet kayak"),
		];
		const tools = plannerGraphTools(ctxFor(graph));
		const tool = tools.find_candidates!;
		const first = (await tool.execute!("1", { queries: [{ text: "Amber canoe" }] })).details as PlannerCandidateBatch;
		assert.equal(first.matches[0]!.candidateIds.length, 5);
		const cursor = first.matches[0]!.nextCursor!;
		assert.ok(cursor);
		const next = (await tool.execute!("2", { queries: [{ text: "Amber canoe", cursor }] })).details as PlannerCandidateBatch;
		assert.deepEqual(next.matches[0]!.candidateIds, ["a5", "a6"]);
		assert.equal(next.matches[0]!.nextCursor, null);
		await assert.rejects(tool.execute!("3", { queries: [{ text: "Amber canoe", cursor, hints: ["violet kayak"] }] }), /Omit hints/);
		await assert.rejects(tool.execute!("4", { queries: [{ text: "something else", cursor }] }), /Unknown cursor/);
		const other = plannerGraphTools(ctxFor(graph));
		await assert.rejects(other.find_candidates!.execute!("5", { queries: [{ text: "Amber canoe", cursor }] }), /Unknown cursor/);
		const fresh = (await tool.execute!("6", { queries: [{ text: "Amber canoe", hints: ["violet kayak"] }] })).details as PlannerCandidateBatch;
		assert.ok(fresh.matches[0]!.candidateIds.length > 0, "fresh hints start at the first page");
	});
});
