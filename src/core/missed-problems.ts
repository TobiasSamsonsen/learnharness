/**
 * Missed problems (owner, 2026-11-16) — PURE, browser-safe. A course practice or review problem the learner gave up on,
 * moved on from, was taught, or solved only with hints is a MISS. Misses are DERIVED from the chats, nothing is stored:
 * the next practice or review of the same skills tells the tutor to pose a VARIANT of each open miss (same idea, a fresh
 * surface), and the course page lists them with a button to retry. A miss is CLOSED once a later problem that covers
 * all of its skills is solved cleanly.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ProblemOutcome } from "./mastery.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage } from "./native-messages.ts";

/** The outcomes that make a problem a miss. */
const MISS_OUTCOMES = new Set<string>(["surrendered", "movedOn", "taught", "solvedWithHints"]);
/** The longest problem statement kept (the prompt and the page show it; a longer one is cut). */
export const MISSED_STATEMENT_MAX = 600;

/** One concluded course problem. */
export interface ConcludedProblem {
	chatId: string;
	/** ms of the conclude call. */
	at: number;
	statement: string;
	/** The skill ids the problem was tagged with. */
	skills: string[];
	outcome: ProblemOutcome;
}

/** A miss that is still open. */
export interface MissedProblem extends ConcludedProblem {
	/** Stable id: the chat and the conclude time. */
	id: string;
}

/** Every cleanly concluded problem of one practice or review chat, in order. A dismissed problem, and a pose or conclude
 *  that errored, count for nothing (the same rule as skillEventsOf). */
export function concludedProblemsOf(messages: readonly LhMessage[], chatId: string): ConcludedProblem[] {
	const clean = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && !(m as ToolResultMessage).isError) clean.add((m as ToolResultMessage).toolCallId);
	}
	const out: ConcludedProblem[] = [];
	let active: { statement: string; skills: string[] } | null = null;
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || !clean.has(block.id)) continue;
			if (block.name === PRACTICE_PROBLEM_TOOL) {
				const args = (block.arguments ?? {}) as { statement?: unknown; skills?: unknown };
				active = {
					statement: typeof args.statement === "string" ? args.statement.slice(0, MISSED_STATEMENT_MAX) : "",
					skills: Array.isArray(args.skills) ? [...new Set(args.skills.filter((s): s is string => typeof s === "string"))] : [],
				};
			} else if (block.name === PRACTICE_CONCLUDE_TOOL) {
				const outcome = (block.arguments as { outcome?: unknown } | undefined)?.outcome;
				if (active && active.skills.length > 0 && typeof outcome === "string" && outcome !== "dismissed") {
					out.push({ chatId, at: assistant.timestamp, statement: active.statement, skills: active.skills, outcome: outcome as ProblemOutcome });
				}
				active = null;
			}
		}
	}
	return out;
}

/** The open misses among a course's concluded problems (any order), newest first. A miss is closed when a LATER problem
 *  that covers every one of its skills was solved cleanly (`solved`). */
export function openMisses(problems: readonly ConcludedProblem[]): MissedProblem[] {
	const sorted = [...problems].sort((a, b) => a.at - b.at);
	const open: MissedProblem[] = [];
	sorted.forEach((p, i) => {
		if (!MISS_OUTCOMES.has(p.outcome)) return;
		const closed = sorted.slice(i + 1).some((q) => q.at > p.at && q.outcome === "solved" && p.skills.every((s) => q.skills.includes(s)));
		if (!closed) open.push({ ...p, id: `${p.chatId}:${p.at}` });
	});
	return open.reverse();
}

/** The open misses a session on `skillIds` should retest: those sharing a skill with it, newest first, at most `max`. */
export function missesForSession(open: readonly MissedProblem[], skillIds: readonly string[], max = 6): MissedProblem[] {
	return open.filter((p) => p.skills.some((s) => skillIds.includes(s))).slice(0, max);
}
