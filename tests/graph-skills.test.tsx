/**
 * Skills in the knowledge graph (owner, 2026-10-25 — "the skills I know
 * should be visible in the knowledge graph, not as a box in the home
 * view"): the snapshot's skills layer folds into the canvas image, and a
 * clicked skill gets its own detail card.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillDetail, withSkillLayer } from "../components/graph-view.tsx";
import { isSkillNodeId, type GraphSnapshot } from "../src/core/contracts.ts";

const prop = (id: string, name: string) => ({ id, name, statement: `${name}.`, aliases: [], createdAt: "t", provenance: [] });

function snapshot(over: Partial<GraphSnapshot> = {}): GraphSnapshot {
	return {
		nodes: [prop("n_1", "Lists are mutable")],
		propositions: [prop("n_1", "Lists are mutable")],
		edges: [],
		logicalEdges: [],
		impLinks: [],
		chains: [],
		sessions: {},
		fileSources: {},
		nodeSessions: {},
		clusters: [{ id: "chat_x", label: "Learn: X", members: ["n_1"] }],
		...over,
	};
}

const skill = (id: string, over: Partial<NonNullable<GraphSnapshot["skills"]>["nodes"][number]> = {}) => ({
	id,
	name: id.toUpperCase(),
	statement: `Do ${id}`,
	box: 3,
	known: true,
	due: false,
	courses: [{ id: "course_1", title: "ITGK" }],
	propositions: [],
	...over,
});

describe("folding the skills layer into the graph", () => {
	it("no layer → the snapshot unchanged (same object)", () => {
		const s = snapshot();
		assert.equal(withSkillLayer(s), s);
	});

	it("skills join nodes, edges, logical edges and regions; propositions stay the stored truth", () => {
		const s = snapshot({
			skills: {
				nodes: [skill("sk_a"), skill("sk_b", { known: false, box: 1, propositions: ["n_1"] })],
				edges: [
					{ from: "sk_a", to: "sk_b" },
					{ from: "n_1", to: "sk_b" },
					{ from: "n_gone", to: "sk_b" },
				],
				regions: [{ id: "course_1", label: "ITGK", members: ["sk_a", "sk_b"] }],
			},
		});
		const out = withSkillLayer(s);
		assert.deepEqual(out.nodes.map((n) => n.id), ["n_1", "sk_a", "sk_b"]);
		assert.deepEqual(out.propositions.map((n) => n.id), ["n_1"], "the chain table never sees a skill");
		assert.deepEqual(out.edges, [{ from: "sk_a", to: "sk_b" }, { from: "n_1", to: "sk_b" }], "an arrow from a node that is not drawn is dropped");
		assert.deepEqual(out.logicalEdges, out.edges, "the depth pass stacks skills above what they rest on");
		assert.deepEqual(out.clusters.map((c) => [c.id, c.label]), [["chat_x", "Learn: X"], ["course_course_1", "ITGK"]]);
		assert.ok(isSkillNodeId("sk_a") && !isSkillNodeId("n_1"));
	});
});

describe("a skill's detail card", () => {
	it("shows its state, its courses (linked) and what it rests on", () => {
		const html = renderToStaticMarkup(
			<SkillDetail skill={skill("sk_b", { known: false, box: 1, due: true, propositions: ["n_1", "n_missing"] })} propositionName={(id) => (id === "n_1" ? "Lists are mutable" : undefined)} />,
		);
		assert.match(html, /data-testid="skill-detail"[\s\S]*Skill · learning · box 1\/5 · due for review/);
		assert.match(html, /href="\/course\/course_1"[^>]*>ITGK</);
		assert.match(html, /Rests on[\s\S]*Lists are mutable/);
		assert.doesNotMatch(html, /n_missing/);
	});

	it("renders nothing for an unknown skill", () => {
		assert.equal(renderToStaticMarkup(<SkillDetail skill={undefined} propositionName={() => undefined} />), "");
	});
});

describe("extraction on finish (2026-10-25)", async () => {
	const { extractionDue } = await import("../src/server/turn-service.ts");

	it("an open lesson waits for a full batch; a finished one extracts whatever is left", () => {
		assert.equal(extractionDue(963, 12_288, false), false, "the real lessons: far under the budget");
		assert.equal(extractionDue(12_288, 12_288, false), true);
		assert.equal(extractionDue(963, 12_288, true), true, "finished → the remainder goes in");
		assert.equal(extractionDue(0, 12_288, true), false, "nothing left → no run");
	});
});
