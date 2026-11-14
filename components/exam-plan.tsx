"use client";

import { createContext, useContext, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { examDateLabel, forecastLine, SKILL_WEIGHTS, WEIGHT_LABELS, type CoursePlan, type CourseMode, type CourseSkillView, type SkillWeightValue } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The exam plan on the course page (owner, 2026-11-13 — core/exam-plan.ts): today's list and the exam card (the
 * countdown, the forecast, "Weigh by exams"), the exam's settings, plus the weight chip and the hand-edit control a
 * skill row shows.
 */

const BTN = "rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
const SECTION_HEAD = "mb-2 text-xs uppercase tracking-widest text-muted-foreground/70";

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

/** In a skill's detail: its weight, the evidence, and 0-3 buttons to change it (Reset returns to the default). */
export function WeightEditor({ skill }: { skill: Pick<CourseSkillView, "id" | "weight" | "weightBy" | "weightReason" | "priority"> }) {
	const edit = useContext(WeightEditContext);
	return (
		<div className="space-y-1" data-testid={`weight-editor-${skill.id}`}>
			<p className="text-muted-foreground">
				Exam weight {skill.weight} · {WEIGHT_LABELS[skill.weight as SkillWeightValue] ?? ""}
				{skill.weightBy === "learner" ? " · set by you" : skill.weightBy === "model" ? " · from the sources" : " · not weighed"}
				{skill.priority > skill.weight ? ` · counts as ${skill.priority} because later skills build on it` : ""}
				{skill.weightReason ? ` · ${skill.weightReason}` : ""}
			</p>
			{edit && (
				<div className="flex flex-wrap items-center gap-1.5">
					{SKILL_WEIGHTS.map((w) => (
						<button key={w} type="button" aria-pressed={skill.weight === w && skill.weightBy === "learner"} className={cn(BTN, skill.weight === w && skill.weightBy === "learner" && "bg-muted")} data-testid={`weight-${skill.id}-${w}`} onClick={() => edit(skill.id, w as SkillWeightValue)}>
							{w}
						</button>
					))}
					{skill.weightBy === "learner" && (
						<button type="button" className={BTN} data-testid={`weight-${skill.id}-reset`} onClick={() => edit(skill.id, null)}>
							Reset
						</button>
					)}
				</div>
			)}
		</div>
	);
}

// ─── the section ────────────────────────────────────────────────────────────

const CARD = "min-w-0 space-y-2.5 rounded-xl border border-border/60 bg-card/50 p-4";

/** The exam card's big figure: "30 d", "today", "passed". Pure. */
export function examCountdown(daysLeft: number): string {
	if (daysLeft > 0) return `${daysLeft} d`;
	return daysLeft === 0 ? "today" : "passed";
}

/** "27 skills left", "1 skill left". Pure. */
export function skillsLeftLabel(skillsLeft: number): string {
	return skillsLeft === 1 ? "1 skill left" : `${skillsLeft} skills left`;
}

/** How many of the course's skills are known (understanding 6 or more), as one thin bar and its words. */
function KnownStrip({ known, total }: { known: number; total: number }) {
	return (
		<div className="space-y-1" data-testid="course-exam-known">
			<span
				role="meter"
				aria-label="Skills known"
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={known}
				className="block h-1.5 w-full overflow-hidden rounded-full bg-border/50"
			>
				<span className="block h-full rounded-full" style={{ width: `${(known / total) * 100}%`, backgroundColor: "var(--lh-understanding-8)" }} />
			</span>
			<span className="block text-xs text-foreground">
				{known} of {total} skills known
			</span>
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
	/** Skill names by id, for today's lessons. */
	names: ReadonlyMap<string, string>;
	weightOf: (skillId: string) => number;
	examDate?: string;
	/** All the course's skills, and how many of them are known: the strip on the exam card. */
	totalSkills: number;
	knownSkills: number;
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
 * Today and the exam, side by side (owner, 2026-11-14). Today holds the reviews due and the lessons to hold the pace
 * and is left out when there is nothing to do; the exam card shows the countdown, the skills left and the forecast. With
 * no exam date it holds the date field; with an exam date the field and Clear sit in the course settings. Before the
 * course is weighed the card holds "Weigh by exams"; afterwards it says so in one line and "Weigh again" is a setting.
 */
export function ExamPlanSection(props: ExamPlanSectionProps) {
	const { courseId, plan, names, weightOf, examDate, totalSkills, knownSkills, hasWeights, weightsError, weighing, canWeigh, busy, onStart, onChanged } = props;
	const { error, starting, patch, weigh } = useExamActions(courseId, onChanged);

	const f = plan.forecast;
	const todayHasItems = plan.reviewDue > 0 || plan.lessons.length > 0;
	return (
		<section data-testid="course-exam-plan" className={cn("grid gap-3", todayHasItems && "md:grid-cols-[1.25fr_1fr]")}>
			{todayHasItems && (
				<div data-testid="course-today" className={CARD}>
					<div className={SECTION_HEAD}>Today</div>
					<div className="divide-y divide-border/50">
						{plan.reviewDue > 0 && (
							<div className="flex items-center justify-between gap-2 py-2 text-sm first:pt-0" data-testid="course-today-review">
								<span className="flex items-center gap-2">
									<span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: "var(--lh-due)" }} />
									{plan.reviewBatch < plan.reviewDue ? `Review · ${plan.reviewBatch} of ${plan.reviewDue} due` : `Review · ${plan.reviewDue} due`}
								</span>
								<button type="button" className={cn(BTN, "border-foreground/40 text-foreground")} disabled={busy} onClick={() => onStart("review")}>
									Start
								</button>
							</div>
						)}
						{plan.lessons.map((id) => (
							<div key={id} className="flex items-center justify-between gap-2 py-2 text-sm first:pt-0" data-testid={`course-today-lesson-${id}`}>
								<span className="min-w-0 flex-1 truncate">
									Learn: {names.get(id) ?? id}
									{weightOf(id) !== 1 && <span className="ml-2 text-xs text-muted-foreground">w{weightOf(id)}</span>}
								</span>
								<button type="button" className={BTN} disabled={busy} onClick={() => onStart("learn", id)}>
									Learn
								</button>
							</div>
						))}
					</div>
				</div>
			)}
			<div className={CARD}>
				<div className={SECTION_HEAD}>Exam</div>
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
				{examDate && totalSkills > 0 && <KnownStrip known={knownSkills} total={totalSkills} />}
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
