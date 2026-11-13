/**
 * grade-failure — why a practice grading failed, in words the learner can read
 * (owner, 2026-11-13). A provider error arrives as a JSON blob; the concluded
 * problem's card shows this short reason instead. Pure.
 */

import { AUTH_PROVIDER_KEYS } from "./auth-keys.ts";

/** What a concluded problem's result carries about its grading, beside `grades` (agent/practice-grade.ts). */
export interface GradeNote {
	/** Present only when the session's own model graded because the grader's failed. */
	gradedBy?: "session";
	/** Why the grader failed (gradeFailureReason). Kept when the fallback graded and when nothing did. */
	gradeError?: string;
}

/** The reason when no model is set for the grader role. */
export const NO_GRADER_MODEL = "no grader model is set";

const OTHER_MAX = 120;

const providerLabel = (provider: string): string => AUTH_PROVIDER_KEYS.find((p) => p.id === provider)?.label ?? provider;

/** A short reason for a failed grading: a known cause as a phrase, anything else as the start of the
 *  message. The provider's name follows in brackets when there is one. */
export function gradeFailureReason(message: string, opts: { provider?: string; timedOut?: boolean } = {}): string {
	const text = message.replace(/\s+/g, " ").trim();
	const has = (pattern: RegExp): boolean => pattern.test(text);
	const code = (n: string): boolean => new RegExp(`(^|\\D)${n}(\\D|$)`).test(text);
	let reason: string;
	if (text === NO_GRADER_MODEL) return NO_GRADER_MODEL;
	if (opts.timedOut) reason = "timed out";
	else if (code("402") || has(/credits?\b/i)) reason = "out of credit";
	else if (code("429") || has(/quota|rate.?limit/i)) reason = "quota or rate limit reached";
	else if (code("401") || code("403") || has(/unauthori[sz]ed|invalid.{0,10}api.?key|permission.?denied/i)) reason = "API key rejected";
	else if (has(/(^|\D)5\d\d(\D|$)/) || has(/overloaded|unavailable|high demand/i)) reason = "provider unavailable";
	else if (has(/timed? ?out/i)) reason = "timed out";
	else reason = text.length > OTHER_MAX ? `${text.slice(0, OTHER_MAX).trimEnd()}…` : text || "unknown error";
	return opts.provider ? `${reason} (${providerLabel(opts.provider)})` : reason;
}

/** The turn's failure for the chat banner (owner, 2026-11-13): a known cause as a phrase, with the provider's own
 *  words kept as `detail` so nothing is hidden. A provider error arrives as a JSON blob ("code": 402, ...); the banner
 *  used to show it raw. Anything not recognised is shown as it is (`phrase` null). */
export function turnErrorDisplay(message: string): { phrase: string | null; detail: string } {
	const text = message.replace(/\s+/g, " ").trim();
	const known = gradeFailureReason(text);
	// gradeFailureReason echoes an unknown message; a recognised cause is one of its fixed phrases
	const phrases = ["out of credit", "quota or rate limit reached", "API key rejected", "provider unavailable", "timed out"];
	const phrase = phrases.find((p) => known === p) ?? null;
	return { phrase, detail: text };
}

/** The grading note on a conclude result's details; malformed fields are dropped. */
export function gradeNoteOf(details: unknown): GradeNote {
	if (typeof details !== "object" || details === null) return {};
	const d = details as { gradedBy?: unknown; gradeError?: unknown };
	return {
		...(d.gradedBy === "session" ? { gradedBy: "session" as const } : {}),
		...(typeof d.gradeError === "string" && d.gradeError.trim() !== "" ? { gradeError: d.gradeError } : {}),
	};
}

/** True when a grading ran on this conclude result and left no grade: the card says "Not graded" and
 *  offers "Grade again". A result from outside a course session, or from before the grader, has no list. */
export function isUngraded(details: unknown): boolean {
	if (typeof details !== "object" || details === null) return false;
	const grades = (details as { grades?: unknown }).grades;
	return Array.isArray(grades) && grades.length === 0;
}
