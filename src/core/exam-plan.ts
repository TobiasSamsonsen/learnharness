/**
 * exam-plan — exam date, skill weights and what to do today (owner, 2026-11-13).
 *
 * A course may carry an exam date and a weight per skill: how much the course's exams use it (0 never examined,
 * 1 sometimes or unknown, 2 several exams, 3 nearly every exam). The weights come from a model pass over the
 * course's sources ("Weigh by exams", agent/subagents/exam-weigher.ts) and can be changed by hand. From them:
 *
 *   - a skill's PRIORITY is the highest weight among itself and everything it unlocks, so the prerequisites of
 *     heavily examined skills come first;
 *   - Next up is ordered by priority (ties keep the course's topological order), and a skill that is not examined
 *     itself and unlocks nothing examined goes to "Not examined";
 *   - with an exam date the course says how many lessons a day it needs and whether the recent pace gets there;
 *   - Today is the reviews that are due, then enough lessons to hold the pace.
 *
 * A course with no weights behaves exactly as before: every weight defaults to 1, so priorities tie and the
 * order stays topological. Pure.
 */

export type SkillWeightValue = 0 | 1 | 2 | 3;

export const SKILL_WEIGHTS: readonly SkillWeightValue[] = [0, 1, 2, 3];

/** A skill's weight in one course. `by`: the weighing pass or the learner's own edit (a re-weigh keeps the learner's). */
export interface SkillWeight {
	w: SkillWeightValue;
	/** One line naming the evidence ("Exam 2025 task 3"); absent on a hand edit. */
	reason?: string;
	by: "model" | "learner";
}

export type SkillWeights = Record<string, SkillWeight>;

/** The weight a skill without one counts as. */
export const DEFAULT_WEIGHT: SkillWeightValue = 1;

export const WEIGHT_LABELS: Record<SkillWeightValue, string> = {
	0: "not examined",
	1: "sometimes examined",
	2: "often examined",
	3: "nearly every exam",
};

const REASON_MAX = 240;

/** A weight from stored or foreign input: an integer 0-3, else null. */
export function parseWeightValue(raw: unknown): SkillWeightValue | null {
	return raw === 0 || raw === 1 || raw === 2 || raw === 3 ? raw : null;
}

/** Stored weights with malformed entries dropped (a record from another build, a hand-edited file). */
export function sanitizeWeights(raw: unknown): SkillWeights | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const out: SkillWeights = {};
	for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof entry !== "object" || entry === null) continue;
		const { w, reason, by } = entry as { w?: unknown; reason?: unknown; by?: unknown };
		const value = parseWeightValue(w);
		if (value === null) continue;
		out[id] = {
			w: value,
			...(typeof reason === "string" && reason.trim() !== "" ? { reason: reason.trim().slice(0, REASON_MAX) } : {}),
			by: by === "learner" ? "learner" : "model",
		};
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export const weightOf = (weights: SkillWeights | undefined, id: string): SkillWeightValue => weights?.[id]?.w ?? DEFAULT_WEIGHT;

/** The weights after a re-weigh: the model's fresh answer for every skill, except the ones the learner set by hand. */
export function mergeModelWeights(
	existing: SkillWeights | undefined,
	fresh: ReadonlyArray<{ skill: string; weight: SkillWeightValue; reason?: string }>,
	skillIds: readonly string[],
): SkillWeights {
	const allowed = new Set(skillIds);
	const out: SkillWeights = {};
	for (const [id, entry] of Object.entries(existing ?? {})) if (allowed.has(id) && entry.by === "learner") out[id] = entry;
	for (const f of fresh) {
		if (!allowed.has(f.skill) || out[f.skill]) continue;
		const reason = f.reason?.trim().slice(0, REASON_MAX);
		out[f.skill] = { w: f.weight, ...(reason ? { reason } : {}), by: "model" };
	}
	return out;
}

/** Every skill's priority: the highest weight among itself and all it unlocks (transitively, inside `ids`). */
export function priorities(ids: readonly string[], requiresOf: (id: string) => readonly string[], weights: SkillWeights | undefined): Map<string, SkillWeightValue> {
	const inCourse = new Set(ids);
	const dependents = new Map<string, string[]>();
	for (const id of ids) {
		for (const req of requiresOf(id)) {
			if (!inCourse.has(req)) continue;
			dependents.set(req, [...(dependents.get(req) ?? []), id]);
		}
	}
	const memo = new Map<string, SkillWeightValue>();
	const visiting = new Set<string>();
	const priorityOf = (id: string): SkillWeightValue => {
		const known = memo.get(id);
		if (known !== undefined) return known;
		// a cycle cannot reach here (approval validates a DAG); guard anyway so a corrupt record cannot hang a page
		if (visiting.has(id)) return weightOf(weights, id);
		visiting.add(id);
		let best = weightOf(weights, id);
		for (const d of dependents.get(id) ?? []) best = Math.max(best, priorityOf(d)) as SkillWeightValue;
		visiting.delete(id);
		memo.set(id, best);
		return best;
	};
	return new Map(ids.map((id) => [id, priorityOf(id)]));
}

/** Next up, ordered: highest priority first, the course's topological order within a priority; a skill with priority 0
 *  (not examined, unlocking nothing examined) is split off. `ids` are in topological order. */
export function orderNextUp(ids: readonly string[], priority: ReadonlyMap<string, SkillWeightValue>): { nextUp: string[]; notExamined: string[] } {
	const indexed = ids.map((id, i) => ({ id, i, p: priority.get(id) ?? DEFAULT_WEIGHT }));
	const examined = indexed.filter((x) => x.p > 0).sort((a, b) => b.p - a.p || a.i - b.i);
	return { nextUp: examined.map((x) => x.id), notExamined: indexed.filter((x) => x.p === 0).map((x) => x.id) };
}

// ─── exam readiness (owner, 2026-11-14) ─────────────────────────────────────

/**
 * How much of the exam a skill of each PRIORITY is assumed to appear in: every exam (3), half of them (2), a fifth (1),
 * none (0). A priority already counts what a skill unlocks, so a prerequisite weighs like the skills built on it.
 * These are assumptions, not measurements: tune them here.
 */
export const READINESS_FREQUENCY: Record<SkillWeightValue, number> = { 3: 1, 2: 0.5, 1: 0.2, 0: 0 };

/** The number of past exams a readiness score assumes when the weighing did not record one (a weighing from before the
 *  count was stored). */
export const DEFAULT_PAST_EXAMS = 3;

/** The most past exams a count may hold. */
export const PAST_EXAMS_MAX = 50;

/** A stored or foreign past-exam count: an integer 0-PAST_EXAMS_MAX, else undefined. */
export function sanitizePastExams(raw: unknown): number | undefined {
	return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= PAST_EXAMS_MAX ? raw : undefined;
}

/** A skill's weight in the readiness score: (frequency x exams + 1) / (exams + 2). The "+1 / +2" keeps a skill no exam has
 *  shown from weighing nothing while the evidence is thin: with few exams the rarely tested skills keep real weight, with
 *  many they fade. With no exams every skill weighs the same. */
export function readinessWeight(priority: number, pastExams: number): number {
	const p = parseWeightValue(priority) ?? DEFAULT_WEIGHT;
	return (READINESS_FREQUENCY[p] * pastExams + 1) / (pastExams + 2);
}

export interface Readiness {
	/** 0-1: the weighted average credit of every skill. */
	score: number;
	/** 0-1: the score if every priority 2-3 skill were known (credit 1) and nothing else: where "the foundation and the
	 *  most tested skills" end on the bar. */
	key: number;
	/** The past-exam count the weights used. */
	pastExams: number;
	/** The course's weighing recorded no count, so DEFAULT_PAST_EXAMS stood in. */
	assumed: boolean;
}

/**
 * The exam readiness score: each skill's credit (0-1, its known share) weighted by how likely it is to matter on the next
 * exam, shrunk by how many past exams the weighing found. Priority 0 skills count too, so 100% needs every skill. Null for a
 * course with no skills. Pure.
 */
export function examReadiness(skills: ReadonlyArray<{ priority: number; credit: number }>, pastExams?: number): Readiness | null {
	if (skills.length === 0) return null;
	const count = sanitizePastExams(pastExams);
	const exams = count ?? DEFAULT_PAST_EXAMS;
	let total = 0;
	let earned = 0;
	let key = 0;
	for (const s of skills) {
		const w = readinessWeight(s.priority, exams);
		total += w;
		earned += w * Math.min(1, Math.max(0, s.credit));
		if (s.priority >= 2) key += w;
	}
	return { score: earned / total, key: key / total, pastExams: exams, assumed: count === undefined };
}

/**
 * Where the readiness bar sits on the understanding color ramp (1 orange-red .. 10 green; skill-visual.ts understandingColor
 * turns it into a color). Owner 2026-11-15: green only once the score passes the key-skills tick. Below the tick the score
 * runs the ramp from 1 (0%) up to just short of 8 (at the tick); from the tick to 100% it runs 8 up to 10. A tick at 0 (no
 * key skills) ramps the whole bar to green at 100%. Pure.
 */
export function readinessStep(score: number, key: number): number {
	const s = Math.min(1, Math.max(0, score));
	const k = Math.min(1, Math.max(0, key));
	if (k > 0 && s < k) return 1 + 6 * (s / k);
	const span = 1 - k;
	return span > 0 ? 8 + 2 * ((s - k) / span) : 10;
}

/** The line under the score: what it rests on. Pure. */
export function readinessBasis(r: Pick<Readiness, "pastExams" | "assumed">): string {
	if (r.assumed) return `assuming ${r.pastExams} past exams`;
	if (r.pastExams === 0) return "no past exams found, every skill counts the same";
	return `based on ${r.pastExams} past ${r.pastExams === 1 ? "exam" : "exams"}`;
}

// ─── the exam date ──────────────────────────────────────────────────────────

/** A calendar date "YYYY-MM-DD", or null when it is not a real one. */
export function parseExamDate(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const date = new Date(Date.UTC(y, mo - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const DAY_MS = 86_400_000;

/** The local calendar day of `now` as a UTC midnight, so day differences are whole numbers. */
function localDayStart(now: number): number {
	const d = new Date(now);
	return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole days from today (local) to the exam day: 0 on the day, negative after it. */
export function daysUntil(examDate: string, now: number): number {
	const [y, m, d] = examDate.split("-").map(Number) as [number, number, number];
	return Math.round((Date.UTC(y, m - 1, d) - localDayStart(now)) / DAY_MS);
}

/** "12 Dec 2026" from "2026-12-12", independent of the machine's time zone. Pure. */
export function examDateLabel(examDate: string): string {
	const [y, m, d] = examDate.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * When the exam is, as the course teacher is told (owner, 2026-11-14): "12 Dec 2026, 30 days left", "…, tomorrow",
 * "…, today". Nothing without an exam date or once the exam has passed (it no longer shapes a lesson). It replaces the
 * old free-text time note, which carried the date and what the exam covers. Pure.
 */
export function examWhen(examDate: string | undefined, now: number): string | undefined {
	if (!examDate) return undefined;
	const days = daysUntil(examDate, now);
	if (days < 0) return undefined;
	const left = days === 0 ? "today" : days === 1 ? "tomorrow" : `${days} days left`;
	return `${examDateLabel(examDate)}, ${left}`;
}

/** The moment a review should be projected to (ms): the start of the exam day, or `now` on the day itself. Undefined without
 *  an exam date, or once the exam has passed. Pure. */
export function examInstant(examDate: string | undefined, now: number): number | undefined {
	if (!examDate) return undefined;
	const days = daysUntil(examDate, now);
	return days < 0 ? undefined : now + days * DAY_MS;
}

/** A skill's place in an exam-aware review (owner, 2026-11-16): its exam weight (readinessWeight: priority shrunk by the
 *  past-exam count, so a priority-0 skill sinks to the bottom without vanishing) times what is projected to be lost by exam
 *  day (1 - recall then). The highest scores are the skills that cost the most marks if left alone. Pure. */
export function examReviewScore(priority: number, pastExams: number | undefined, recallOnExamDay: number): number {
	const exams = sanitizePastExams(pastExams) ?? DEFAULT_PAST_EXAMS;
	return readinessWeight(priority, exams) * (1 - Math.min(1, Math.max(0, recallOnExamDay)));
}

/** The course row's days column (owner, 2026-11-14): "12 d", "today", "passed". Pure. */
export function examDaysLabel(examDate: string, now: number): string {
	const days = daysUntil(examDate, now);
	if (days < 0) return "passed";
	if (days === 0) return "today";
	return `${days} d`;
}

// ─── pace and forecast ──────────────────────────────────────────────────────

/** The window the pace is measured over: the last 14 days, or fewer (at least 3) while the course is young. */
export const PACE_WINDOW_DAYS = 14;
const PACE_MIN_DAYS = 3;

/** Lessons per day: Learn finishes in the window over the window's days. `finishes` are the timestamps of this course's
 *  lesson finishes (one per skill); `firstActivity` is the course's first evidence, so a new course is not judged
 *  against days it did not exist. */
export function lessonsPerDay(finishes: readonly number[], now: number, firstActivity?: number): number {
	const windowStart = now - PACE_WINDOW_DAYS * DAY_MS;
	const recent = finishes.filter((t) => t >= windowStart && t <= now).length;
	const since = firstActivity === undefined ? PACE_WINDOW_DAYS : Math.ceil((now - firstActivity) / DAY_MS);
	const days = Math.min(PACE_WINDOW_DAYS, Math.max(PACE_MIN_DAYS, since));
	return recent / days;
}

export type ForecastStatus = "on-track" | "behind" | "no-pace" | "exam-today" | "past" | "done";

export interface Forecast {
	status: ForecastStatus;
	/** Lessons a day the remaining skills need (days left counted with today); 0 when nothing is left. */
	neededPerDay: number;
	/** Lessons a day over the recent window. */
	pacePerDay: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
/** Rounded UP to a tenth, so a far exam never reads as needing 0 lessons a day. */
const ceil1 = (n: number): number => Math.ceil(n * 10 - 1e-9) / 10;

/** Will the recent pace finish the remaining skills by the exam? `daysLeft` is the days until the exam day, which is
 *  not a study day: with the exam tomorrow (daysLeft 1) only today is left to learn in. */
export function forecast(input: { skillsLeft: number; daysLeft: number; pacePerDay: number }): Forecast {
	const pacePerDay = round1(input.pacePerDay);
	if (input.skillsLeft <= 0) return { status: "done", neededPerDay: 0, pacePerDay };
	if (input.daysLeft < 0) return { status: "past", neededPerDay: 0, pacePerDay };
	if (input.daysLeft === 0) return { status: "exam-today", neededPerDay: input.skillsLeft, pacePerDay };
	const neededPerDay = ceil1(input.skillsLeft / input.daysLeft);
	if (input.pacePerDay === 0) return { status: "no-pace", neededPerDay, pacePerDay };
	return { status: input.pacePerDay >= input.skillsLeft / input.daysLeft ? "on-track" : "behind", neededPerDay, pacePerDay };
}

/** The forecast's one line: "needs 1.1 lessons/day · your pace 1.2/day · on track". */
export function forecastLine(f: Forecast): string {
	const lessons = `${f.neededPerDay} ${f.neededPerDay === 1 ? "lesson" : "lessons"}/day`;
	switch (f.status) {
		case "done":
			return "Every examined skill is learned.";
		case "past":
			return "The exam date has passed.";
		case "exam-today":
			return "The exam is today.";
		case "no-pace":
			return `needs ${lessons} · no lessons finished lately`;
		default:
			return `needs ${lessons} · your pace ${f.pacePerDay}/day · ${f.status === "on-track" ? "on track" : "behind"}`;
	}
}

// ─── today ──────────────────────────────────────────────────────────────────

/** Most lessons one Today list suggests for a course. */
export const TODAY_MAX_LESSONS = 3;

/** How many lessons to suggest today: enough to hold the pace the exam needs (1 to 3; 1 without an exam date). */
export function lessonsToday(neededPerDay: number | null, nextUpCount: number): number {
	if (nextUpCount <= 0) return 0;
	const wanted = neededPerDay === null ? 1 : Math.ceil(neededPerDay);
	return Math.min(nextUpCount, TODAY_MAX_LESSONS, Math.max(1, wanted));
}

/** The plan the course page and the Today list read (src/server/courses.ts builds it). */
export interface CoursePlan {
	/** "YYYY-MM-DD", when the learner set one. */
	examDate?: string;
	daysLeft?: number;
	/** Skills still to learn that the exams use (Next up and Locked, not examined ones left out). */
	skillsLeft: number;
	forecast?: Forecast;
	/** Reviews due, and how many the next review session takes. With an exam date a due skill is also one that is fine
	 *  today but projected below the target on exam day. */
	reviewDue: number;
	/** How many of `reviewDue` are only fading before the exam (fine today). */
	reviewFading?: number;
	reviewBatch: number;
	/** The lessons to take today: the first of the ordered Next up. */
	lessons: string[];
}
