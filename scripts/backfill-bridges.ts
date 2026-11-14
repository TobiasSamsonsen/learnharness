/**
 * One-off BRIDGE backfill (owner, 2026-11-14): the graph stayed in islands
 * because only the identity links crossed sessions. For each birth session
 * this asks the auditor model for bridging edges between that session's
 * propositions and every OTHER proposition in the graph (the graph is small
 * enough to show whole, so no candidate retrieval). Same law as the live
 * auditor: single premise, one endpoint in the session, entailment only, at
 * most MAX_BRIDGES per session, no cycles.
 *
 * --orphans (owner decision via advisor, 2026-11-14): instead of one call per
 * session, one call per node that still has NO edge, against EVERY other node
 * (same-session partners allowed), at most 2 edges, "none" allowed.
 *
 * DRY RUN by default: prints the proposed bridges and writes nothing. Run it
 * against a scratch copy of the data (it needs a settings.json there with a
 * model for the auditor role), never the live data dir:
 *
 *   LH_DATA_DIR=<scratch> npx tsx scripts/backfill-bridges.ts          # dry run
 *   LH_DATA_DIR=<scratch> npx tsx scripts/backfill-bridges.ts --write  # append the chains
 */
import { Type } from "typebox";
import { graphStore } from "../src/store/graph.ts";
import { stores } from "../src/server/stores.ts";
import { piEngineForSpec } from "../src/agent/models.ts";
import { resolveRoleSpec } from "../src/core/settings-resolution.ts";
import { ROLE_SLOT } from "../src/core/settings.ts";
import { getGraph, leadsTo } from "../src/core/graph.ts";
import { birthSessionPartition } from "../src/core/session-clusters.ts";
import { runSubmitAgent, healStringifiedArrays } from "../src/agent/subagents/submit-agent.ts";
import { MAX_BRIDGES, validateBridges } from "../src/agent/subagents/extraction.ts";
import { newGraphChainId } from "../src/core/graph.ts";

const schema = Type.Object({
	bridges: Type.Array(
		Type.Object({
			premise: Type.String({ description: "Id of the idea needed to derive the conclusion." }),
			conclusion: Type.String({ description: "Id of the derived idea." }),
		}),
		{ description: `At most ${MAX_BRIDGES} bridges; exactly one endpoint is one of THIS SESSION'S ideas, the other an idea from the rest of the graph. [] when none is clear.` },
	),
});

const INSTRUCTIONS_ORPHAN = `

The ideas shown as "this session's" may be a single idea that has no arrow at all yet. It may connect to ANY other idea, including one from its own session. Return bridges: [] rather than force a link that is not a real derivation step.`;
const INSTRUCTIONS = `You connect a learner's knowledge graph. The graph holds true ideas; an arrow premise → conclusion means the premise is a real
step needed to derive the conclusion. You are shown ONE SESSION'S ideas and ALL OTHER ideas of the graph.

Add up to ${MAX_BRIDGES} bridges: a single idea from the rest of the graph that is genuinely needed to derive one of this session's ideas
(other → session), or a session idea that is genuinely needed to derive an idea from the rest (session → other). Only
entailment counts: the premise must be a real step in the derivation, not just the same subject. Exactly one endpoint of each
bridge is a session idea. Submit with the submit_bridges tool; bridges: [] when none is clear.`;

async function main(): Promise<void> {
	const write = process.argv.includes("--write");
	const orphansMode = process.argv.includes("--orphans");
	const maxBridges = orphansMode ? 2 : MAX_BRIDGES;
	let tokens = 0;
	const spec = resolveRoleSpec("auditor", stores.settingsStore.readSettings());
	if (!spec) throw new Error("No auditor model configured in this data dir's settings.json.");
	const engine = piEngineForSpec(spec, true, undefined, undefined);
	const graph = getGraph(graphStore);
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const chains = [...graph.chains];
	const touched = new Set(chains.flatMap((c) => [...c.premises, c.conclusion]));
	const sessions = orphansMode
		? graph.nodes.filter((n) => !touched.has(n.id)).map((n) => ({ id: n.provenance[0]?.chatId ?? "", members: [n.id] }))
		: birthSessionPartition(graph.nodes);
	console.log(`[bridges] ${graph.nodes.length} nodes, ${chains.length} chains, ${sessions.length} ${orphansMode ? "orphans" : "sessions"}, ${write ? "WRITE" : "dry run"}`);
	let added = 0;
	for (const session of sessions) {
		const own = new Set(session.members);
		const rest = graph.nodes.filter((n) => !own.has(n.id));
		const show = (ids: Iterable<string>) => [...ids].map((id) => ({ id, name: byId.get(id)!.name, statement: byId.get(id)!.statement }));
		const prompt = `THIS SESSION'S IDEAS:\n${JSON.stringify(show(own), null, 1)}\n\nTHE REST OF THE GRAPH:\n${JSON.stringify(show(rest.map((n) => n.id)), null, 1)}`;
		const restIds = new Set(rest.map((n) => n.id));
		try {
			const out = await runSubmitAgent<{ bridges: Array<{ premise: string; conclusion: string }> }>({
				role: "auditor",
				chatId: session.id,
				toolName: "submit_bridges",
				toolDescription: "Submit the bridges (possibly none).",
				parameters: schema,
				fill: (raw) => raw as { bridges: Array<{ premise: string; conclusion: string }> },
				validate: (v) => (v.bridges.length > maxBridges ? `at most ${maxBridges} bridges` : validateBridges({ links: [], bridges: v.bridges }, own, restIds)),
				systemPrompt: orphansMode ? INSTRUCTIONS + INSTRUCTIONS_ORPHAN : INSTRUCTIONS,
				prompt,
				engine,
				signal: undefined,
				onStep: (usage) => {
					tokens += ((usage as { input?: number; output?: number }).input ?? 0) + ((usage as { input?: number; output?: number }).output ?? 0);
				},
				neverSubmitted: "the model never submitted bridges",
				prepareArguments: healStringifiedArrays,
			});
			for (const b of out.bridges) {
				const exists = chains.some((c) => c.premises.length === 1 && c.premises[0] === b.premise && c.conclusion === b.conclusion);
				if (exists || leadsTo(chains, b.conclusion, b.premise) || leadsTo(chains, b.premise, b.conclusion)) continue;
				console.log(`  ${byId.get(b.premise)!.name}  →  ${byId.get(b.conclusion)!.name}`);
				const chain = { id: newGraphChainId(), premises: [b.premise], conclusion: b.conclusion, createdAt: new Date().toISOString(), provenance: [{ chatId: session.id, messageId: "" }] };
				chains.push(chain);
				added++;
				if (write) graphStore.appendChain(chain);
			}
		} catch (err) {
			console.error(`[bridges] session ${session.id} failed:`, err instanceof Error ? err.message : err);
		}
	}
	console.log(`[bridges] ${write ? "wrote" : "proposed"} ${added} bridges, ~${tokens} input+output tokens`);
}

void main();
