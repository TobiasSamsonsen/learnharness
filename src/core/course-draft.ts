/**
 * Course drafts — validation and approval (fork addition, 2026-10-24;
 * spec: docs/courses.md §1.2, §3). PURE, browser-safe.
 *
 * The planner's submit seam and the approval route share ONE validator, so
 * a draft that reached the owner is a draft approval can write. Approval
 * turns the draft into skills.jsonl lines: a new skill gets a minted id, a
 * reused skill gets a link-append carrying any new edges.
 */

import type { CourseDraft, DraftSkill, Skill, SkillLine } from "./contracts/course.ts";
import { prerequisiteClosure, topoOrder } from "./skills.ts";

export interface DraftCheckContext {
	/** Every skill in the graph, by id. */
	skills: ReadonlyMap<string, Skill>;
	/** Every live proposition id. */
	nodeIds: ReadonlySet<string>;
}

/** Problems with a draft (empty = valid). */
export function draftProblems(skills: readonly DraftSkill[], ctx: DraftCheckContext): string[] {
	const problems: string[] = [];
	if (skills.length === 0) return ["the draft has no skills"];
	const keys = new Set<string>();
	const reused = new Map<string, string>();
	for (const s of skills) {
		if (!s.key.trim()) problems.push("a skill has an empty key");
		else if (keys.has(s.key)) problems.push(`duplicate key "${s.key}"`);
		keys.add(s.key);
		if (!s.name.trim()) problems.push(`${s.key}: empty name`);
		if (!s.statement.trim()) problems.push(`${s.key}: empty statement`);
		if (s.reuse !== undefined) {
			if (!ctx.skills.has(s.reuse)) problems.push(`${s.key}: reuse "${s.reuse}" is not an existing skill id`);
			else if (reused.has(s.reuse)) problems.push(`${s.key} and ${reused.get(s.reuse)} both reuse ${s.reuse} — merge them into one skill`);
			else reused.set(s.reuse, s.key);
		}
		for (const n of s.restsOn) {
			if (!ctx.nodeIds.has(n)) problems.push(`${s.key}: restsOn "${n}" is not an existing proposition id`);
		}
	}
	for (const s of skills) {
		for (const r of s.requires) {
			if (r === s.key) problems.push(`${s.key} requires itself`);
			else if (!keys.has(r)) problems.push(`${s.key}: requires "${r}" is not a key in this draft`);
		}
	}
	if (problems.length === 0) {
		const byKey = new Map(skills.map((s) => [s.key, s]));
		if (topoOrder(skills.map((s) => s.key), (k) => byKey.get(k)?.requires ?? []) === null) {
			problems.push("the requires edges form a cycle — prerequisites must point one way");
		}
	}
	return problems;
}

/** Does every curriculum material show up in at least one citation? The
 *  missing ones' names (case-insensitive name or id match). */
export function uncitedMaterials(skills: readonly DraftSkill[], materials: ReadonlyArray<{ id: string; name: string }>): string[] {
	const cites = skills.map((s) => (s.cite ?? "").toLowerCase());
	return materials
		.filter((m) => !cites.some((c) => c.includes(m.name.toLowerCase()) || c.includes(m.id.toLowerCase())))
		.map((m) => m.name);
}

export interface ApprovedDraft {
	/** The lines to append to skills.jsonl. */
	lines: SkillLine[];
	/** The course's new skill set: the draft's skills plus every
	 *  prerequisite a reused skill already had (so no course skill is
	 *  locked behind a skill the course doesn't show). */
	skillIds: string[];
}

/** Turn a VALID draft into ledger lines + the course's skill set. */
export function approveDraft(draft: CourseDraft, ctx: DraftCheckContext, mintId: () => string, now: string): ApprovedDraft {
	const idOf = new Map<string, string>();
	for (const s of draft.skills) idOf.set(s.key, s.reuse ?? mintId());
	const lines: SkillLine[] = [];
	for (const s of draft.skills) {
		const id = idOf.get(s.key)!;
		const requires = s.requires.map((k) => idOf.get(k)!);
		const existing = s.reuse ? ctx.skills.get(s.reuse) : undefined;
		if (existing) {
			// link-append only what is new — a pure re-approval writes nothing
			const newRequires = requires.filter((r) => !existing.requires.includes(r));
			const newRestsOn = s.restsOn.filter((n) => !existing.restsOn.includes(n));
			if (newRequires.length === 0 && newRestsOn.length === 0) continue;
			lines.push({ id, name: existing.name, statement: existing.statement, requires: newRequires, restsOn: newRestsOn, createdAt: now });
			continue;
		}
		lines.push({ id, name: s.name.trim(), statement: s.statement.trim(), requires, restsOn: [...new Set(s.restsOn)], createdAt: now });
	}
	const draftIds = draft.skills.map((s) => idOf.get(s.key)!);
	const requiresOf = (id: string): readonly string[] => {
		const fromDraft = lines.filter((l) => l.id === id).flatMap((l) => l.requires);
		return [...(ctx.skills.get(id)?.requires ?? []), ...fromDraft];
	};
	const all = new Set(draftIds);
	for (const id of draftIds) for (const req of prerequisiteClosure(id, requiresOf)) all.add(req);
	return { lines, skillIds: [...all] };
}
