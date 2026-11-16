"use client";

import { createContext, useContext, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { examDateLabel, forecastLine, readinessBasis, readinessStep, understandingColor, type Readiness, SKILL_WEIGHTS, WEIGHT_LABELS, type CoursePlan, type CourseMode, type CourseSkillView, type SkillWeightValue } from "@/src/core";
import { cn } from "@/lib/utils";
import { PAGE_HEAD, SECTION_HEAD } from "@/components/section-heads";

/**
 * The exam plan on the course page (owner, 2026-11-13 — core/exam-plan.ts): today's list and the exam card (the
 * countdown, the forecast, "Weigh by exams"), the exam's settings, plus the weight chip and the hand-edit control a
 * skill row shows.
 */

const BTN = "rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

/** A skill's weight chip text ("w3"), shown when someone set it or it is not the default. Pure. */
export function weightChip(skill: Pick<CourseSkillView, "weight" | "weightBy">): string | null {
	return skill.weightBy !== undefined || skill.weight !== 1 ? `w${skill.weight}` : null;
}

// ─── the hand edit, reached by the skill rows through a context ─────────────

/** Set (0-3) or clear (null) one skill's exam weight; absent outside a course page. */
export const WeightEditContext = createContext<((skillId: string, weight: SkillWeightValue | null) => void) | null>(null);

export function WeightChip({ skill }: { skill: Pick<CourseSkillView, "id" | "weight" | "weightBy"> }) {
	const text = weightChip(skill);
	if (!text) return null;
	return (
		<span data-testid={`weight-chip-${skill.id}`} title={`Exam weight ${skill.weight}: ${WEIGHT_LABELS[skill.weight as SkillWeightValue] ?? ""}`} className="rounded-full border border-border/70 px-1.5 text-[10px] font-medium tracking-wide text-muted-foreground">
			{text}
		</span>
	);
}

/** In a skill's detail: "Exam weight", the 0-3 buttons to change it, and a few words on what the weight means (Reset
 *  returns a hand edit to the default). The evidence behind it is the WeightNote. */
export function WeightEditor({ skill }: { skill: Pick<CourseSkillView, "id" | "weight" | "weightBy" | "priority"> }) {
	const edit = useContext(WeightEditContext);
	const meaning = WEIGHT_LABELS[skill.weight as SkillWeightValue] ?? "";
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-testid={`weight-editor-${skill.id}`}>
			<span className="text-muted-foreground">Exam weight</span>
			{edit ? (
				<span className="flex items-center gap-1" role="group" aria-label="Exam weight">
					{SKILL_WEIGHTS.map((w) => (
						<button key={w} type="button" aria-pressed={skill.weight === w} className={cn(BTN, "min-w-7 px-2", skill.weight === w && "border-foreground bg-foreground text-background")} data-testid={`weight-${skill.id}-${w}`} onClick={() => edit(skill.id, w as SkillWeightValue)}>
							{w}
						</button>
					))}
				</span>
			) : (
				<span className="font-medium text-foreground">{skill.weight}</span>
			)}
			<span className="text-muted-foreground">
				{meaning}
				{skill.priority > skill.weight ? ` · counts as ${skill.priority}` : ""}
			</span>
			{edit && skill.weightBy === "learner" && (
				<button type="button" className={BTN} data-testid={`weight-${skill.id}-reset`} onClick={() => edit(skill.id, null)}>
					Reset
				</button>
			)}
		</div>
	);
}

/** The evidence behind a skill's weight in words (what set it, why it counts higher, the model's reason): the full
 *  sentence behind the compact control, shown under "More". */
export function WeightNote({ skill }: { skill: Pick<CourseSkillView, "id" | "weight" | "weightBy" | "weightReason" | "priority"> }) {
	return (
		<p className="text-muted-foreground" data-testid={`weight-note-${skill.id}`}>
			Exam weight {skill.weight} · {WEIGHT_LABELS[skill.weight as SkillWeightValue] ?? ""}
			{skill.weightBy === "learner" ? " · set by you" : skill.weightBy === "model" ? " · from the sources" : " · not weighed"}
			{skill.priority > skill.weight ? ` · counts as ${skill.priority} because later skills build on it` : ""}
			{skill.weightReason ? ` · ${skill.weightReason}` : ""}
		</p>
	);
}

// ─── the section ────────────────────────────────────────────────────────────

const CARD = "min-w-0 space-y-2.5 rounded-xl border border-border/60 bg-card/50 p-4";
/** A part inside the Next up box ("Learn today", "More to learn"): below the box heading, above its rows. */
const BOX_HEAD = "mb-0.5 text-[11px] uppercase tracking-widest text-muted-foreground/70";
/** How many more next-up skills the box lists after today's lessons. */
export const MORE_NEXT_UP = 4;

/** The exam card's big figure: "30 d", "today", "passed". Pure. */
export function examCountdown(daysLeft: number): string {
	if (daysLeft > 0) return `${daysLeft} d`;
	return daysLeft === 0 ? "today" : "passed";
}

/** "27 skills left", "1 skill left". Pure. */
export function skillsLeftLabel(skillsLeft: number): string {
	return skillsLeft === 1 ? "1 skill left" : `${skillsLeft} skills left`;
}

/**
 * The exam readiness score (owner, 2026-11-14, core/exam-plan.ts examReadiness): the percent, one bar with a tick where the
 * foundation and the most tested skills end, and what the score rests on.
 */
function ReadinessStrip({ readiness }: { readiness: Readiness }) {
	const percent = Math.round(readiness.score * 100);
	const key = Math.round(readiness.key * 100);
	return (
		<div className="space-y-1.5" data-testid="course-exam-readiness">
			<div className="flex items-baseline justify-between gap-2">
				<span className="text-sm text-muted-foreground">Readiness</span>
				<span className="font-mono text-xl leading-none">{percent}%</span>
			</div>
			<span role="meter" aria-label="Exam readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="relative block h-2 w-full rounded-full bg-border/50">
				<span className="block h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: understandingColor(readinessStep(readiness.score, readiness.key)) ?? "var(--lh-understanding-1)" }} />
				<span aria-hidden className="absolute -top-1 block h-4 w-px bg-foreground/70" style={{ left: `${key}%` }} data-testid="course-exam-readiness-key" />
			</span>
			<div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
				<span>{readinessBasis(readiness)}</span>
				<span>key skills {key}%</span>
			</div>
		</div>
	);
}

/** The exam date's PATCH and the Weigh by exams POST, shared by the card and the settings. */
function useExamActions(courseId: string, onChanged: () => void) {
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	const patch = async (body: unknown): Promise<boolean> => {
		setError(null);
		try {
			const res = await fetch(`/api/courses/${courseId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `rejected (${res.status})`);
				return false;
			}
			onChanged();
			return true;
		} catch {
			setError("Could not reach the server — try again.");
			return false;
		}
	};
	const weigh = async () => {
		setError(null);
		setStarting(true);
		try {
			const res = await fetch(`/api/courses/${courseId}/weigh`, { method: "POST" });
			if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not start (${res.status})`);
		} catch {
			setError("Could not reach the server — try again.");
		} finally {
			setStarting(false);
			onChanged();
		}
	};
	return { error, starting, patch, weigh };
}

export interface ExamPlanSectionProps {
	courseId: string;
	plan: CoursePlan;
	/** Skill names by id, for the lessons. */
	names: ReadonlyMap<string, string>;
	weightOf: (skillId: string) => number;
	/** Next up, by exam priority (the course view's nextUp): the box lists the first few not already in today's lessons. */
	nextUp: readonly string[];
	/** Learned skills not yet known: the box offers to practice them together when there are several. */
	learningCount: number;
	examDate?: string;
	/** The exam readiness score, null while the course has not been weighed (core/exam-plan.ts examReadiness). */
	readiness: Readiness | null;
	/** The course has been weighed (a weighing pass ran), not just edited by hand. */
	hasWeights: boolean;
	weightsError?: string;
	weighing: boolean;
	/** Drafting, no curriculum, or a request in flight: the pass cannot start. */
	canWeigh: boolean;
	busy: boolean;
	onStart: (mode: CourseMode, skillId?: string) => void;
	onChanged: () => void;
}

/**
 * Next up and the exam, side by side (owner, 2026-11-14). Next up holds the review due, today's lessons (to hold the
 * pace), the next few skills by exam priority and, with several skills still being learned, one row to practice them
 * together, each with its own button so a bulk session starts without opening a row; it is left out when there is
 * nothing to do. The exam card shows the countdown, the skills left and the forecast. With
 * no exam date it holds the date field; with an exam date the field and Clear sit in the course settings. Before the
 * course is weighed the card holds "Weigh by exams"; afterwards it says so in one line and "Weigh again" is a setting.
 */
export function ExamPlanSection(props: ExamPlanSectionProps) {
	const { courseId, plan, names, weightOf, nextUp, learningCount, examDate, readiness, hasWeights, weightsError, weighing, canWeigh, busy, onStart, onChanged } = props;
	const { error, starting, patch, weigh } = useExamActions(courseId, onChanged);

	const f = plan.forecast;
	const more = nextUp.filter((id) => !plan.lessons.includes(id)).slice(0, MORE_NEXT_UP);
	const practiceAll = learningCount > 1;
	const boxHasItems = plan.reviewDue > 0 || plan.lessons.length > 0 || more.length > 0 || practiceAll;
	const learnRow = (id: string, testid: string) => (
		<div key={id} className="flex items-center justify-between gap-2 py-1.5 text-sm" data-testid={testid}>
			<span className="min-w-0 flex-1 line-clamp-2 break-words sm:line-clamp-none sm:block sm:truncate">
				{names.get(id) ?? id}
				{weightOf(id) !== 1 && <span className="ml-2 text-xs text-muted-foreground">w{weightOf(id)}</span>}
			</span>
			<button type="button" className={BTN} disabled={busy} onClick={() => onStart("learn", id)}>
				Learn
			</button>
		</div>
	);
	return (
		<section data-testid="course-exam-plan" className={cn("grid gap-3", boxHasItems && "md:grid-cols-[1.25fr_1fr]")}>
			{boxHasItems && (
				<div data-testid="course-next-up" className={CARD}>
					<div className={PAGE_HEAD}>Next up</div>
					<div className="space-y-3">
						{plan.reviewDue > 0 && (
							<div className="flex items-center justify-between gap-2 text-sm" data-testid="course-today-review">
								<span className="flex items-center gap-2">
									<span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: "var(--lh-due)" }} />
									{plan.reviewBatch < plan.reviewDue ? `Review · ${plan.reviewBatch} of ${plan.reviewDue} due` : `Review · ${plan.reviewDue} due`}
									{(plan.reviewFading ?? 0) > 0 && <span className="text-muted-foreground" data-testid="course-review-fading">{`· ${plan.reviewFading} fading before the exam`}</span>}
								</span>
								<button type="button" className={cn(BTN, "border-foreground/40 text-foreground")} disabled={busy} onClick={() => onStart("review")}>
									Start
								</button>
							</div>
						)}
						{plan.lessons.length > 0 && (
							<div data-testid="course-today">
								<div className={BOX_HEAD}>Learn today</div>
								<div className="divide-y divide-border/50">{plan.lessons.map((id) => learnRow(id, `course-today-lesson-${id}`))}</div>
							</div>
						)}
						{more.length > 0 && (
							<div data-testid="course-next-more">
								<div className={BOX_HEAD}>More to learn</div>
								<div className="divide-y divide-border/50">{more.map((id) => learnRow(id, `course-next-more-${id}`))}</div>
							</div>
						)}
						{practiceAll && (
							<div className="flex items-center justify-between gap-2 border-t border-border/50 pt-3 text-sm" data-testid="course-next-practice">
								<span>Practice · {learningCount} learning</span>
								<button type="button" className={BTN} disabled={busy} onClick={() => onStart("practice")}>
									Practice
								</button>
							</div>
						)}
					</div>
				</div>
			)}
			<div className={CARD}>
				<div className={PAGE_HEAD}>Exam</div>
				{examDate ? (
					<div className="flex items-baseline gap-2" data-testid="course-exam-countdown">
						<span className="font-mono text-4xl font-semibold leading-none">{examCountdown(plan.daysLeft ?? 0)}</span>
						<span className="text-sm text-muted-foreground">{examDateLabel(examDate)}</span>
					</div>
				) : (
					<input
						type="date"
						aria-label="Exam date"
						data-testid="course-exam-date"
						value=""
						onChange={(e) => void patch({ examDate: e.target.value === "" ? null : e.target.value })}
						className="rounded-md border bg-background px-2 py-1 text-xs outline-none"
					/>
				)}
				{readiness && <ReadinessStrip readiness={readiness} />}
				{(examDate || plan.skillsLeft > 0) && (
					<p className="text-xs text-muted-foreground" data-testid="course-plan-headline">
						{skillsLeftLabel(plan.skillsLeft)}
					</p>
				)}
				{f && (
					<p className={cn("text-xs", f.status === "behind" ? "text-warning" : "text-muted-foreground")} data-testid="course-plan-forecast">
						{forecastLine(f)}
					</p>
				)}
				{(weighing || starting) && (
					<span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="course-weighing">
						<Loader2Icon className="size-3.5 animate-spin" />
						Reading the exams…
					</span>
				)}
				{hasWeights && !weighing && (
					<p className="text-xs text-muted-foreground" data-testid="course-weights-summary">
						Skills weighed by exam importance.
					</p>
				)}
				{!hasWeights && !weighing && !starting && (
					<p className="text-xs text-muted-foreground" data-testid="course-exam-readiness-prompt">
						Weigh by exams to get a readiness score.
					</p>
				)}
				{!hasWeights && (
					<button type="button" className={BTN} disabled={!canWeigh || weighing || starting || busy} data-testid="course-weigh-button" onClick={() => void weigh()}>
						Weigh by exams
					</button>
				)}
				{weightsError && !weighing && (
					<p className="text-xs text-error" data-testid="course-weights-error">
						Weighing failed: {weightsError}
					</p>
				)}
				{error && <p className="text-xs text-error">{error}</p>}
			</div>
		</section>
	);
}

/**
 * The exam's settings, inside the closed Course settings: the date with Clear once one is set (before that the exam
 * card holds the field), and "Weigh again" once the course is weighed (before that the exam card holds "Weigh by
 * exams"), with what the weighing found.
 */
export function ExamSettings(props: Pick<ExamPlanSectionProps, "courseId" | "examDate" | "hasWeights" | "weighing" | "canWeigh" | "busy" | "onChanged"> & { weightsSummary?: string; weightsAt?: string }) {
	const { courseId, examDate, hasWeights, weighing, canWeigh, busy, onChanged, weightsSummary, weightsAt } = props;
	const { error, starting, patch, weigh } = useExamActions(courseId, onChanged);
	if (!examDate && !hasWeights) return null;
	return (
		<div className="space-y-1.5" data-testid="course-exam-settings">
			<div className={SECTION_HEAD}>Exam</div>
			<div className="flex flex-wrap items-center gap-2">
				{examDate && (
					<>
						<input
							type="date"
							aria-label="Exam date"
							data-testid="course-exam-date"
							value={examDate}
							onChange={(e) => void patch({ examDate: e.target.value === "" ? null : e.target.value })}
							className="rounded-md border bg-background px-2 py-1 text-xs outline-none"
						/>
						<button type="button" className={BTN} data-testid="course-exam-date-clear" onClick={() => void patch({ examDate: null })}>
							Clear
						</button>
					</>
				)}
				{hasWeights && (
					<button type="button" className={BTN} disabled={!canWeigh || weighing || starting || busy} data-testid="course-weigh-button" onClick={() => void weigh()}>
						Weigh again
					</button>
				)}
			</div>
			{hasWeights && weightsSummary && (
				<p className="truncate text-xs text-muted-foreground" title={weightsSummary} data-testid="course-weights-found">
					Last weighing{weightsAt ? ` (${weightsAt.slice(0, 10)})` : ""}: {weightsSummary}
				</p>
			)}
			{error && <p className="text-xs text-error">{error}</p>}
		</div>
	);
}
