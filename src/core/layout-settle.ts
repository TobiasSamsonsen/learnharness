import type { GraphChain, GraphNode, Position } from "./contracts.ts";
import { incrementalLayout } from "./layout.ts";
import { attachImpToCommunities, birthSessionPartition } from "./session-clusters.ts";
import { deriveView, getGraph } from "./graph.ts";

/**
 * The merge-time settle: recompute the resting layout from the CURRENT
 * graph + the positions ledger, and replace the ledger. Called by the
 * extraction pipeline after every merge (the sole writer) and by the
 * positions-commit endpoint when the graph grew under a live-physics
 * commit (client positions become the anchor set). Synchronous — it must
 * finish before the next /api/graph fetch reflects the change.
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): the settle lays out the DERIVED
 * view — propositions AND the derived implication nodes (one per chain,
 * arg_ ids) over the derived untyped arrows — so positions exist for
 * every node the canvas renders. Implication nodes participate in the
 * physics as regular nodes (rendering specialization comes later).
 *
 * SPLIT FROM layout.ts deliberately (2026-09-13): layout.ts is in the
 * browser barrel, and the settle needs the cluster partition for the
 * cluster centroid pull — this module must not ship in the client bundle.
 * Server code imports it DIRECTLY; it is never re-exported through
 * src/core/index.ts.
 */
/** A birth session's course id, from the chat record (null for a notes source,
 *  a deleted chat, or a session with no course). */
export function courseOfSession(chatStore: {
	getChat(id: string): { course?: { courseId: string } } | null | undefined;
}): (sessionId: string) => string | null {
	return (sessionId) => chatStore.getChat(sessionId)?.course?.courseId ?? null;
}

export function settleGraphLayout(graphStore: {
	readNodes(): GraphNode[];
	readChains(): GraphChain[];
	readPositions(): Record<string, Position>;
	writePositions(positions: Record<string, Position>): void;
}, courseOf?: (sessionId: string) => string | null): void {
	const graph = getGraph(graphStore);
	if (graph.nodes.length === 0) return;
	const view = deriveView(graph);
	const previous = new Map(Object.entries(graphStore.readPositions()));
	// The cluster partition for the centroid pull: the SAME birth-session
	// partition the snapshot renders (derived from provenance on read —
	// core/session-clusters.ts, wave 7) — one cluster concept everywhere.
	// PROPOSITIONS ONLY (owner, 2026-09-30): implication nodes never
	// partition; the stored world clusters, its image follows.
	const communities = birthSessionPartition(graph.nodes);
	// The SAME imp-node assignment the snapshot renders (majority among
	// premises' births — core/session-clusters.ts): the resting ledger and
	// the live sim must agree on where bundles belong, or the first live
	// tick would fight the settle. Unfiltered here (settle pulls every
	// community, hulls are a canvas-only concern).
	attachImpToCommunities(communities, graph.nodes, graph.chains);
	// One centring pull per COURSE (owner, 2026-11-14): the sessions of a course
	// merge into one group, so the saved layout agrees with the live sim.
	let courseClusters: Array<{ members: string[] }> | undefined;
	if (courseOf) {
		const byCourse = new Map<string, string[]>();
		for (const community of communities) {
			const courseId = courseOf(community.id);
			if (courseId === null) continue;
			byCourse.set(courseId, [...(byCourse.get(courseId) ?? []), ...community.members]);
		}
		if (byCourse.size > 0) courseClusters = [...byCourse.values()].map((members) => ({ members }));
	}
	const next = incrementalLayout(view.nodes, view.edges, previous, {
		clusters: communities,
		...(courseClusters ? { courseClusters } : {}),
		logicalEdges: view.logicalEdges,
		impLinks: view.impLinks,
	});
	graphStore.writePositions(Object.fromEntries(next));
}
