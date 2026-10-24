/**
 * SkillStore — the fs JSONL adapter for the graph's skill ledger (fork
 * addition, 2026-10-24; spec: docs/courses.md §1.1).
 *
 *   skills.jsonl   SkillLine — the FIRST line for an id defines it; later
 *                  lines for the same id are link-appends (core/skills.ts
 *                  mergeSkillLines merges them at read)
 *
 * Part of the graph family: it honors the format stamp like the other
 * ledgers (graph-format.ts). Course approval (src/server/courses.ts) is the
 * only writer. Corrupt lines are skipped, never guessed at.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_FILES } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import type { SkillLine } from "../core/contracts.ts";
import type { SkillStore } from "../core/ports.ts";

const isString = (v: unknown): v is string => typeof v === "string";

const isSkillLine = (v: unknown): v is SkillLine => {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return (
		isString(r.id) &&
		isString(r.name) &&
		isString(r.statement) &&
		Array.isArray(r.requires) &&
		r.requires.every(isString) &&
		Array.isArray(r.restsOn) &&
		r.restsOn.every(isString) &&
		isString(r.createdAt)
	);
};

export const skillStore: SkillStore = {
	readSkillLines(): SkillLine[] {
		assertGraphFormat(); // honest refusal on a newer-stamped data dir
		let raw: string;
		try {
			raw = fs.readFileSync(LEDGER_FILES.skills, "utf-8");
		} catch {
			return []; // no ledger yet — no course has been approved
		}
		const out: SkillLine[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (isSkillLine(parsed)) out.push(parsed);
			} catch {
				// a torn append must never take the course pages down
			}
		}
		return out;
	},

	appendSkillLines(lines: readonly SkillLine[]): void {
		if (lines.length === 0) return;
		fs.mkdirSync(path.dirname(LEDGER_FILES.skills), { recursive: true });
		ensureGraphFormat(); // the lazy format stamp
		fs.appendFileSync(LEDGER_FILES.skills, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf-8");
	},
};
