/**
 * The automatic layer of the learner profile (fork addition, 2026-11-11). PURE, browser-safe.
 *
 * Nothing here is stored: like the mastery fold, it is derived from the chat
 * transcripts on read. Two kinds of evidence:
 *
 *   - a concluded practice/review problem: the tutor's `missClass` (cue /
 *     discrimination / execution / careless / structural, or none), `rung`,
 *     `outcome` and `verdict`;
 *   - a teach/learn quiz or probe answer: correct, "I don't know", and the
 *     learner's stated confidence. Placement sessions are left out: a
 *     placement test probes the edge of what the learner knows, so its
 *     "I don't know" answers are the design, not a signal.
 *
 * The owner's Moderate floor (2026-11-11), all on RAW counts; the 45-day
 * half-life only ranks:
 *   - the miss fold reaches the tutor after >= 6 classified misses;
 *   - a class is named only if >= 3 of them, from >= 2 sessions;
 *   - the calibration line reaches the tutor after >= 20 answers from >= 2
 *     sessions.
 * Below the floors the stats still exist (the Settings page shows them); the
 * `*Shown` flags and `namedMisses` say what may reach a prompt.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatCourseLink } from "./contracts/course.ts";
import type { ChatKind } from "./contracts/chat.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";

export const MISS_CLASSES = ["cue", "discrimination", "execution", "careless", "structural"] as const;
export type MissClass = (typeof MISS_CLASSES)[number];
export const RUNGS = ["R0", "R1", "R2", "R3", "R4", "R5"] as const;
export type Rung = (typeof RUNGS)[number];

/** Classified misses before the fold reaches the tutor. */
export const MISS_FOLD_MIN_MISSES = 6;
/** A class is named only with at least this many misses… */
export const MISS_CLASS_MIN_COUNT = 3;
/** …from at least this many sessions. */
export const MISS_CLASS_MIN_SESSIONS = 2;
/** Answers before the calibration line reaches the tutor… */
export const CALIBRATION_MIN_ANSWERS = 20;
/** …from at least this many sessions. */
export const CALIBRATION_MIN_SESSIONS = 2;
/** A wrong answer at or above this stated confidence counts as overconfident. */
export const OVERCONFIDENT_AT = 90;
/** Recency half-life of a miss, in days (ranking only). */
export const MISS_HALF_LIFE_DAYS = 45;
const DAY_MS = 86_400_000;

/** The slice of a chat the fold reads. */
export interface LearnerChatInput {
	id: string;
	/** Absent = teach (pre-practice records). */
	kind?: ChatKind;
	course?: Pick<ChatCourseLink, "mode">;
	messages: readonly LhMessage[];
}

/** One concluded problem (a practice or review session). */
export interface ConcludedEvent {
	chatId: string;
	/** ms */
	at: number;
	/** The skills the problem carried (empty for non-course practice). */
	skills: string[];
	outcome: string;
	rung: Rung | null;
	/** null = the tutor saw no miss. */
	missClass: MissClass | null;
	verdict: string;
}

/** One quiz or probe answer (a teach or learn session). */
export interface AnswerEvent {
	chatId: string;
	/** ms */
	at: number;
	dontKnow: boolean;
	/** Undefined when the answer was not scored. */
	correct: boolean | undefined;
	/** The stated probability, 0-100; undefined on "I don't know" and old records. */
	confidence: number | undefined;
	questionText: string;
}

export interface LearnerEvents {
	concluded: ConcludedEvent[];
	answers: AnswerEvent[];
}

const isMissClass = (v: unknown): v is MissClass => MISS_CLASSES.some((c) => c === v);
const isRung = (v: unknown): v is Rung => RUNGS.some((r) => r === v);

/** The evidence one chat holds. A placement test gives none (a context check is a practice session and counts); a practice chat gives concluded
 *  problems, a teach chat gives answers. Errored tool calls and the synthesized `dismissed` conclude are skipped. */
export function learnerEventsOf(chat: LearnerChatInput): LearnerEvents {
	const out: LearnerEvents = { concluded: [], answers: [] };
	const mode = chat.course?.mode;
	if (mode === "placement") return out;
	const practice = chat.kind === "practice";

	const clean = new Set<string>();
	for (const m of chat.messages) {
		if ((m as { role?: string }).role === "toolResult" && !(m as ToolResultMessage).isError) clean.add((m as ToolResultMessage).toolCallId);
	}

	if (!practice) {
		for (const m of chat.messages) {
			if ((m as { role?: string }).role !== "toolResult") continue;
			const result = m as ToolResultMessage;
			const a = result.details as Partial<QuestionAnswerData> | null | undefined;
			if (result.isError || !a || typeof a !== "object" || a.kind !== "quiz" || a.dismissed) continue;
			const dontKnow = a.dontKnow === true;
			out.answers.push({
				chatId: chat.id,
				at: result.timestamp,
				dontKnow,
				correct: dontKnow ? undefined : typeof a.correct === "boolean" ? a.correct : undefined,
				confidence: !dontKnow && typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : undefined,
				questionText: typeof a.questionText === "string" ? a.questionText : "",
			});
		}
		return out;
	}

	let active: string[] = [];
	for (const m of chat.messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || !clean.has(block.id)) continue;
			if (block.name === PRACTICE_PROBLEM_TOOL) {
				const skills = (block.arguments as { skills?: unknown } | undefined)?.skills;
				active = Array.isArray(skills) ? skills.filter((s): s is string => typeof s === "string") : [];
			} else if (block.name === PRACTICE_CONCLUDE_TOOL) {
				const args = (block.arguments ?? {}) as { outcome?: unknown; verdict?: unknown; rung?: unknown; missClass?: unknown };
				if (typeof args.outcome === "string" && args.outcome !== "dismissed") {
					out.concluded.push({
						chatId: chat.id,
						at: assistant.timestamp,
						skills: [...new Set(active)],
						outcome: args.outcome,
						rung: isRung(args.rung) ? args.rung : null,
						missClass: isMissClass(args.missClass) ? args.missClass : null,
						verdict: typeof args.verdict === "string" ? args.verdict : "",
					});
				}
				active = [];
			}
		}
	}
	return out;
}

/** One miss class's stats. */
export interface MissClassStat {
	missClass: MissClass;
	/** Raw classified misses. */
	count: number;
	/** Distinct sessions they come from. */
	sessions: number;
	/** Recency-weighted count (half-life MISS_HALF_LIFE_DAYS): ranks, never gates. */
	weight: number;
	/** ms of the newest one. */
	lastAt: number;
	/** Passes the per-class floor (>= 3 misses from >= 2 sessions). */
	named: boolean;
}

export interface CalibrationStat {
	/** Quiz/probe answers, "I don't know" included. */
	answers: number;
	/** Distinct sessions they come from. */
	sessions: number;
	dontKnow: number;
	/** Committed answers that were scored and carry a stated confidence. */
	scored: number;
	/** Of those, wrong at a stated confidence >= OVERCONFIDENT_AT. */
	wrongHigh: number;
	/** Passes the floor (>= 20 answers from >= 2 sessions). */
	shown: boolean;
}

export interface LearnerFold {
	/** Concluded problems with a miss class, all classes. */
	classified: number;
	/** Passes the fold floor (>= 6 classified misses). */
	missesShown: boolean;
	/** Every class with at least one miss, ranked by weight (then count). */
	classes: MissClassStat[];
	calibration: CalibrationStat;
}

/** What the Settings page shows (GET /api/learner): the fold with the floors' verdicts, and whether Adapt may run. */
export interface LearnerStats {
	fold: LearnerFold;
	/** Chats that carry evidence. */
	sessions: number;
	/** Whether Adapt may run (evidence from at least ADAPT_MIN_SESSIONS sessions). */
	adaptReady: boolean;
	adaptMinSessions: number;
}

/** Fold the events (any order). `now` is ms. */
export function foldLearner(events: LearnerEvents, now: number): LearnerFold {
	const byClass = new Map<MissClass, { count: number; chats: Set<string>; weight: number; lastAt: number }>();
	let classified = 0;
	for (const e of events.concluded) {
		if (e.missClass === null) continue;
		classified++;
		const s = byClass.get(e.missClass) ?? { count: 0, chats: new Set<string>(), weight: 0, lastAt: 0 };
		s.count++;
		s.chats.add(e.chatId);
		s.weight += Math.pow(0.5, Math.max(0, now - e.at) / DAY_MS / MISS_HALF_LIFE_DAYS);
		s.lastAt = Math.max(s.lastAt, e.at);
		byClass.set(e.missClass, s);
	}
	const classes: MissClassStat[] = [...byClass.entries()]
		.map(([missClass, s]) => ({
			missClass,
			count: s.count,
			sessions: s.chats.size,
			weight: s.weight,
			lastAt: s.lastAt,
			named: s.count >= MISS_CLASS_MIN_COUNT && s.chats.size >= MISS_CLASS_MIN_SESSIONS,
		}))
		.sort((a, b) => b.weight - a.weight || b.count - a.count || MISS_CLASSES.indexOf(a.missClass) - MISS_CLASSES.indexOf(b.missClass));

	const chats = new Set<string>();
	let dontKnow = 0;
	let scored = 0;
	let wrongHigh = 0;
	for (const a of events.answers) {
		chats.add(a.chatId);
		if (a.dontKnow) dontKnow++;
		if (!a.dontKnow && a.correct !== undefined && a.confidence !== undefined) {
			scored++;
			if (!a.correct && a.confidence >= OVERCONFIDENT_AT) wrongHigh++;
		}
	}
	return {
		classified,
		missesShown: classified >= MISS_FOLD_MIN_MISSES,
		classes,
		calibration: {
			answers: events.answers.length,
			sessions: chats.size,
			dontKnow,
			scored,
			wrongHigh,
			shown: events.answers.length >= CALIBRATION_MIN_ANSWERS && chats.size >= CALIBRATION_MIN_SESSIONS,
		},
	};
}

/** The classes that may reach a tutor prompt: none below the fold floor, else those that pass the per-class floor. */
export function namedMisses(fold: LearnerFold): MissClassStat[] {
	return fold.missesShown ? fold.classes.filter((c) => c.named) : [];
}

/** Merge the evidence of many chats. */
export function learnerEventsOfAll(chats: Iterable<LearnerChatInput>): LearnerEvents {
	const out: LearnerEvents = { concluded: [], answers: [] };
	for (const chat of chats) {
		const e = learnerEventsOf(chat);
		out.concluded.push(...e.concluded);
		out.answers.push(...e.answers);
	}
	return out;
}
