/**
 * Skills — the graph's second node kind (fork addition, 2026-10-24;
 * spec: docs/courses.md §1.1). PURE, browser-safe.
 *
 * The ledger (data/graph/skills.jsonl) is append-only: the FIRST line for
 * an id defines name/statement/createdAt, later lines for the same id are
 * link-appends whose edges union in. Everything here derives from the raw
 * lines — dead references are dropped at read, never rewritten.
 */

import type { Skill, SkillLine } from "./contracts/course.ts";

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/** Merge raw ledger lines by id (first line defines, edges union), then
 *  drop references to unknown skills, self-edges, and — when the live
 *  proposition ids are given — dead proposition links. Append order kept. */
export function mergeSkillLines(lines: readonly SkillLine[], liveNodeIds?: ReadonlySet<string>): Skill[] {
	const byId = new Map<string, Skill>();
	for (const line of lines) {
		const prev = byId.get(line.id);
		if (!prev) {
			byId.set(line.id, { ...line, requires: [...new Set(line.requires)], restsOn: [...new Set(line.restsOn)] });
			continue;
		}
		prev.requires = union(prev.requires, line.requires);
		prev.restsOn = union(prev.restsOn, line.restsOn);
	}
	for (const skill of byId.values()) {
		skill.requires = skill.requires.filter((id) => id !== skill.id && byId.has(id));
		if (liveNodeIds) skill.restsOn = skill.restsOn.filter((id) => liveNodeIds.has(id));
	}
	return [...byId.values()];
}

/** Every skill `id` requires, directly or through other skills (excludes
 *  `id` itself; cycle-safe). */
export function prerequisiteClosure(id: string, requiresOf: (id: string) => readonly string[]): Set<string> {
	const seen = new Set<string>();
	const stack = [...requiresOf(id)];
	while (stack.length > 0) {
		const next = stack.pop()!;
		if (next === id || seen.has(next)) continue;
		seen.add(next);
		stack.push(...requiresOf(next));
	}
	return seen;
}

/** Topological order of `ids` (prerequisites first) over the requires
 *  edges among them; ties keep the input order. Returns null when the
 *  edges among `ids` contain a cycle. */
export function topoOrder(ids: readonly string[], requiresOf: (id: string) => readonly string[]): string[] | null {
	const inSet = new Set(ids);
	const indegree = new Map(ids.map((id) => [id, 0]));
	const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
	for (const id of ids) {
		for (const req of new Set(requiresOf(id))) {
			if (!inSet.has(req) || req === id) continue;
			indegree.set(id, indegree.get(id)! + 1);
			dependents.get(req)!.push(id);
		}
	}
	const order: string[] = [];
	const ready = ids.filter((id) => indegree.get(id) === 0);
	while (ready.length > 0) {
		// keep the input order among the ready ones
		ready.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
		const id = ready.shift()!;
		order.push(id);
		for (const dep of dependents.get(id)!) {
			indegree.set(dep, indegree.get(dep)! - 1);
			if (indegree.get(dep) === 0) ready.push(dep);
		}
	}
	return order.length === ids.length ? order : null;
}
