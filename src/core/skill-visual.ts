/**
 * The course page's visual layer, as pure functions (owner, 2026-11-09): which
 * understanding band a skill is in, when it comes due, the flat "by
 * understanding" order and its filters. The components only draw what these
 * return, so the cut-points live in one tested place.
 */
import type { CourseSkillView } from "./contracts/course.ts";
import { KNOWN_UNDERSTANDING, MAX_UNDERSTANDING } from "./mastery.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type SkillFields = Pick<CourseSkillView, "learned" | "known" | "understanding" | "needsReview" | "reviewAt" | "missing">;

/** The header strip's bands (owner, 2026-11-09): not learned, under 3, 3 to 6, 6 and up (= known). */
export type SkillBand = "new" | "low" | "mid" | "known";
export const SKILL_BANDS: readonly SkillBand[] = ["new", "low", "mid", "known"];
export const SKILL_BAND_LABEL: Record<SkillBand, string> = {
	new: "Not learned",
	low: "Under 3",
	mid: "3 to 6",
	known: "6 and up",
};
/** The understanding where the second band starts (the first is "not learned"). */
export const MID_BAND_FROM = 3;

export function skillBand(skill: Pick<CourseSkillView, "learned" | "understanding">): SkillBand {
	if (!skill.learned) return "new";
	if (skill.understanding < MID_BAND_FROM) return "low";
	return skill.understanding < KNOWN_UNDERSTANDING ? "mid" : "known";
}

/** Skills per band, in SKILL_BANDS order. */
export function bandCounts(skills: readonly Pick<CourseSkillView, "learned" | "understanding">[]): Record<SkillBand, number> {
	const counts: Record<SkillBand, number> = { new: 0, low: 0, mid: 0, known: 0 };
	for (const s of skills) counts[skillBand(s)]++;
	return counts;
}

/** The review-due timeline's buckets (owner, 2026-11-09): now, within a day, within a week, later. */
export type DueBucket = "now" | "today" | "week" | "later";
export const DUE_BUCKETS: readonly DueBucket[] = ["now", "today", "week", "later"];
export const DUE_BUCKET_LABEL: Record<DueBucket, string> = {
	now: "Now",
	today: "Today",
	week: "This week",
	later: "Later",
};

/** Has a learned skill's recall reached the review line? The server's flag or the clock, whichever is first. */
export function isDue(skill: Pick<CourseSkillView, "learned" | "needsReview" | "reviewAt">, now: number): boolean {
	if (!skill.learned) return false;
	return skill.needsReview || (skill.reviewAt !== null && Date.parse(skill.reviewAt) <= now);
}

/** When a skill comes due; null = not learned (nothing to review). */
export function dueBucket(skill: Pick<CourseSkillView, "learned" | "needsReview" | "reviewAt">, now: number): DueBucket | null {
	if (!skill.learned || skill.reviewAt === null) return null;
	if (isDue(skill, now)) return "now";
	const ms = Date.parse(skill.reviewAt) - now;
	if (ms <= DAY_MS) return "today";
	return ms <= 7 * DAY_MS ? "week" : "later";
}

/** Skills per due bucket, in DUE_BUCKETS order. Not-learned skills are in none. */
export function bucketCounts(skills: readonly Pick<CourseSkillView, "learned" | "needsReview" | "reviewAt">[], now: number): Record<DueBucket, number> {
	const counts: Record<DueBucket, number> = { now: 0, today: 0, week: 0, later: 0 };
	for (const s of skills) {
		const bucket = dueBucket(s, now);
		if (bucket) counts[bucket]++;
	}
	return counts;
}

/** The flat list's filter chips. */
export type SkillChip = "all" | "due" | "learning" | "locked" | "known";
export const SKILL_CHIPS: readonly SkillChip[] = ["all", "due", "learning", "locked", "known"];
export const SKILL_CHIP_LABEL: Record<SkillChip, string> = {
	all: "All",
	due: "Due",
	learning: "Learning",
	locked: "Locked",
	known: "Known",
};

/** The flat list's selection: a chip, optionally narrowed by one header band or one timeline bucket. */
export interface SkillSelection {
	chip: SkillChip;
	band: SkillBand | null;
	bucket: DueBucket | null;
}
export const NO_SELECTION: SkillSelection = { chip: "all", band: null, bucket: null };

function matchesChip(skill: SkillFields, chip: SkillChip, now: number): boolean {
	switch (chip) {
		case "all":
			return true;
		case "due":
			return isDue(skill, now);
		case "learning":
			return skill.learned && !skill.known;
		case "locked":
			return !skill.learned && skill.missing.length > 0;
		case "known":
			return skill.known;
	}
}

export function matchesSelection(skill: SkillFields, sel: SkillSelection, now: number): boolean {
	if (!matchesChip(skill, sel.chip, now)) return false;
	if (sel.band && skillBand(skill) !== sel.band) return false;
	if (sel.bucket && dueBucket(skill, now) !== sel.bucket) return false;
	return true;
}

/** Weakest first (`weakestFirst`) or strongest first: understanding, then due before not due, then name. Does not mutate. */
export function sortByUnderstanding<T extends SkillFields & Pick<CourseSkillView, "name">>(skills: readonly T[], weakestFirst: boolean, now: number): T[] {
	const dir = weakestFirst ? 1 : -1;
	return [...skills].sort((a, b) => {
		if (a.understanding !== b.understanding) return (a.understanding - b.understanding) * dir;
		const dueA = isDue(a, now) ? 0 : 1;
		const dueB = isDue(b, now) ? 0 : 1;
		if (dueA !== dueB) return dueA - dueB;
		return a.name.localeCompare(b.name);
	});
}

/** The ramp step (1-10) of an understanding; null = not learned (no fill). */
export function understandingStep(understanding: number): number | null {
	if (understanding <= 0) return null;
	return Math.min(MAX_UNDERSTANDING, Math.max(1, Math.round(understanding)));
}

/** The CSS color of an understanding's bar (globals.css --lh-understanding-N); null = not learned. */
export function understandingColor(understanding: number): string | null {
	const step = understandingStep(understanding);
	return step === null ? null : `var(--lh-understanding-${step})`;
}
