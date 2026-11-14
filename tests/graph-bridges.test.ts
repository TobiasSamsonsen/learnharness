/**
 * Auditor BRIDGES (owner, 2026-11-14) and COURSE REGIONS (owner, 2026-11-14).
 * Pure: the merger runs over an in-memory ledger fake, the rest are pure functions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode, SessionFindings } from "../src/core/contracts.ts";
import { leadsTo, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import { courseRegions } from "../src/core/session-clusters.ts";
import { MAX_BRIDGES, validateBridges } from "../src/agent/subagents/extraction.ts";

const node = (id: string, chatId: string): GraphNode => ({
	id,
	name: id,
	statement: `${id} holds`,
	aliases: [],
	createdAt: "2026-11-01T00:00:00.000Z",
	provenance: [{ chatId, messageId: "" }],
});
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id,
	premises,
	conclusion,
	createdAt: "2026-11-01T00:00:00.000Z",
	provenance: [{ chatId: "chat_old", messageId: "" }],
});

function fakeDeps(nodes: GraphNode[], chains: GraphChain[]): { deps: GraphDeps; chains: GraphChain[]; nodes: GraphNode[] } {
	const store = {
		readNodes: () => nodes,
		appendNode: (n: GraphNode) => void nodes.push(n),
		readChains: () => chains,
		appendChain: (c: GraphChain) => void chains.push(c),
		rewriteLedgers: () => {},
		appendCheckpoint: () => {},
		appendCoverage: () => {},
	};
	return { deps: { graphStore: store, chatStore: {} } as unknown as GraphDeps, chains, nodes };
}

const finding = (id: string): SessionFindings["propositions"][number] => ({ id, name: id, statement: `${id} new`, aliases: [] });

describe("bridges in the merger", () => {
	it("an existing → finding bridge becomes a single-premise chain from this session", () => {
		const fake = fakeDeps([node("n_old", "chat_old")], []);
		const findings: SessionFindings = { propositions: [finding("p1")], chains: [] };
		mergeFindings("chat_new", findings, { links: [], bridges: [{ premise: "n_old", conclusion: "p1" }] }, fake.deps, { foldedAt: "t" });
		assert.equal(fake.chains.length, 1);
		const created = fake.nodes.find((n) => n.statement === "p1 new")!;
		assert.deepEqual(fake.chains[0]!.premises, ["n_old"]);
		assert.equal(fake.chains[0]!.conclusion, created.id);
		assert.equal(fake.chains[0]!.provenance[0]!.chatId, "chat_new");
	});

	it("a finding → existing bridge points the other way", () => {
		const fake = fakeDeps([node("n_old", "chat_old")], []);
		mergeFindings("chat_new", { propositions: [finding("p1")], chains: [] }, { links: [], bridges: [{ premise: "p1", conclusion: "n_old" }] }, fake.deps, { foldedAt: "t" });
		assert.equal(fake.chains[0]!.conclusion, "n_old");
	});

	it("skips a bridge that would close a cycle", () => {
		const fake = fakeDeps([node("n_a", "c"), node("n_b", "c")], [chain("arg_1", ["n_a"], "n_b")]);
		mergeFindings("chat_new", { propositions: [], chains: [] }, { links: [], bridges: [{ premise: "n_b", conclusion: "n_a" }] }, fake.deps, { foldedAt: "t" });
		assert.equal(fake.chains.length, 1);
	});

	it("skips a bridge with an unknown endpoint, and works without a bridges field", () => {
		const fake = fakeDeps([node("n_old", "c")], []);
		mergeFindings("chat_new", { propositions: [finding("p1")], chains: [] }, { links: [], bridges: [{ premise: "n_gone", conclusion: "p1" }] }, fake.deps, { foldedAt: "t" });
		mergeFindings("chat_new2", { propositions: [], chains: [] }, { links: [] }, fake.deps, { foldedAt: "t" });
		assert.equal(fake.chains.length, 0);
	});

	it("skips a bridge whose premise already leads to the conclusion (it would strand a two-premise chain)", () => {
		const fake = fakeDeps([node("n_p", "c"), node("n_q", "c"), node("n_c", "c")], [chain("arg_1", ["n_p", "n_q"], "n_c")]);
		mergeFindings("chat_new", { propositions: [], chains: [] }, { links: [], bridges: [{ premise: "n_p", conclusion: "n_c" }] }, fake.deps, { foldedAt: "t" });
		assert.equal(fake.chains.length, 1);
	});

	it("leadsTo follows chains transitively", () => {
		const chains = [chain("1", ["a"], "b"), chain("2", ["b", "x"], "c")];
		assert.equal(leadsTo(chains, "a", "c"), true);
		assert.equal(leadsTo(chains, "c", "a"), false);
	});
});

describe("validateBridges", () => {
	const findings = new Set(["p1", "p2"]);
	const existing = new Set(["n_1", "n_2"]);
	const ok = (bridges: Array<{ premise: string; conclusion: string }>, links: Array<{ id: string; linkTo: string }> = []) =>
		validateBridges({ links, bridges }, findings, existing);

	it("accepts either direction with exactly one finding endpoint", () => {
		assert.equal(ok([{ premise: "n_1", conclusion: "p1" }, { premise: "p2", conclusion: "n_2" }]), null);
	});
	it("refuses two findings, two existing nodes, unknown ids, duplicates and too many", () => {
		assert.match(ok([{ premise: "p1", conclusion: "p2" }])!, /exactly ONE/);
		assert.match(ok([{ premise: "n_1", conclusion: "n_2" }])!, /exactly ONE/);
		assert.match(ok([{ premise: "n_9", conclusion: "p1" }])!, /not an existing/);
		assert.match(ok([{ premise: "n_1", conclusion: "p1" }, { premise: "n_1", conclusion: "p1" }])!, /twice/);
		const many = Array.from({ length: MAX_BRIDGES + 1 }, (_, i) => ({ premise: "n_1", conclusion: `p${i}` }));
		assert.match(ok(many)!, /at most/);
	});
	it("refuses a bridge on an identity-linked finding", () => {
		assert.match(ok([{ premise: "n_1", conclusion: "p1" }], [{ id: "p1", linkTo: "n_2" }])!, /identity-linked/);
	});
});

describe("courseRegions", () => {
	const n = (id: string, chat: string) => node(id, chat);
	const nodes = [n("a1", "s1"), n("a2", "s1"), n("b1", "s2"), n("c1", "s3"), n("c2", "s3"), n("c3", "s3")];
	const session = (id: string, members: string[]) => ({ id, label: id, members });
	const sessionClusters = [session("s3", ["c1", "c2", "c3"])];
	const courseOf = (id: string): string | null => (id === "s1" || id === "s2" ? "course_x" : null);

	it("merges the course's sessions into one titled region and keeps course-less sessions", () => {
		const out = courseRegions({ nodes, chains: [] }, sessionClusters, courseOf, () => "Matte", 3);
		assert.deepEqual(out.map((c) => [c.id, c.label, c.members]), [
			["course_x", "Matte", ["a1", "a2", "b1"]],
			["s3", "s3", ["c1", "c2", "c3"]],
		]);
	});
	it("needs MIN size propositions in total, and a multi-premise junction follows its session", () => {
		assert.equal(courseRegions({ nodes: nodes.slice(0, 2), chains: [] }, [], courseOf, () => "Matte", 3).length, 0);
		const imp: GraphChain = chain("arg_imp", ["a1", "a2"], "b1");
		const out = courseRegions({ nodes, chains: [imp] }, sessionClusters, courseOf, () => "Matte", 3);
		assert.ok(out[0]!.members.includes("arg_imp"));
	});
});
