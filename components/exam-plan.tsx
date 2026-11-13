"use client";

import { createContext, useContext, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { forecastLine, SKILL_WEIGHTS, WEIGHT_LABELS, type CoursePlan, type CourseMode, type CourseSkillView, type SkillWeightValue } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The exam plan on the course page (owner, 2026-11-13 — core/exam-plan.ts): the exam date and its countdown, the
 * forecast, "Weigh by exams", and today's list; plus the weight chip and the hand-edit control a skill row shows.
 */

const BTN = "rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
const SECTION_HEAD = "mb-2 text-xs uppercase tracking-widest text-muted-foreground/70";

/** "29 days left", "tomorrow", "today", "passed 3 days ago". Pure. */
export function daysLeftLabel(daysLeft: number): string {
	if (daysLeft === 0) return "exam today";
	if (daysLeft === 1) return "exam tomorrow";
	if (daysLeft > 1) return `${daysLeft} days left`;
	return daysLeft === -1 ? "passed yesterday" : `passed ${-daysLeft} days ago`;
}

/** "12 Dec 2026" from "2026-12-12", independent of the machine's time zone. Pure. */
export function examDateLabel(examDate: string): string {
	const [y, m, d] = examDate.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The plan's headline: "12 Dec 2026 · 29 days left · 27 skills left". Pure. */
export function planHeadline(plan: Pick<CoursePlan, "examDate" | "daysLeft" | "skillsLeft">): string {
	const parts: string[] = [];
	if (plan.examDate) parts.push(examDateLabel(plan.examDate));
	if (plan.daysLeft !== undefined) parts.push(daysLeftLabel(plan.daysLeft));
	parts.push(plan.skillsLeft === 1 ? "1 skill left" : `${plan.skillsLeft} skills left`);
	return parts.join(" · ");
}

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

export interface ExamPlanSectionProps {
	courseId: string;
	plan: CoursePlan;
	/** Skill names by id, for today's lessons. */
	names: ReadonlyMap<string, string>;
	weightOf: (skillId: string) => number;
	examDate?: string;
	hasWeights: boolean;
	weightsSummary?: string;
	weightsAt?: string;
	weightsError?: string;
	weighing: boolean;
	/** Drafting, no curriculum, or a request in flight: the pass cannot start. */
	canWeigh: boolean;
	busy: boolean;
	onStart: (mode: CourseMode, skillId?: string) => void;
	onChanged: () => void;
}

export function ExamPlanSection(props: ExamPlanSectionProps) {
	const { courseId, plan, names, weightOf, examDate, hasWeights, weightsSummary, weightsAt, weightsError, weighing, canWeigh, busy, onStart, onChanged } = props;
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

	const f = plan.forecast;
	const todayHasItems = plan.reviewDue > 0 || plan.lessons.length > 0;
	return (
		<section data-testid="course-exam-plan" className="space-y-3">
			<div>
				<div className={SECTION_HEAD}>Exam</div>
				<div className="flex flex-wrap items-center gap-2">
					<input
						type="date"
						aria-label="Exam date"
						data-testid="course-exam-date"
						value={examDate ?? ""}
						onChange={(e) => void patch({ examDate: e.target.value === "" ? null : e.target.value })}
						className="rounded-md border bg-background px-2 py-1 text-xs outline-none"
					/>
					{examDate && (
						<button type="button" className={BTN} data-testid="course-exam-date-clear" onClick={() => void patch({ examDate: null })}>
							Clear
						</button>
					)}
					<button type="button" className={BTN} disabled={!canWeigh || weighing || starting || busy} data-testid="course-weigh-button" onClick={() => void weigh()}>
						{hasWeights ? "Weigh again" : "Weigh by exams"}
					</button>
					{(weighing || starting) && (
						<span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="course-weighing">
							<Loader2Icon className="size-3.5 animate-spin" />
							Reading the exams…
						</span>
					)}
				</div>
				{(examDate || plan.skillsLeft > 0) && (
					<p className="mt-2 text-xs text-muted-foreground" data-testid="course-plan-headline">
						{planHeadline(plan)}
					</p>
				)}
				{f && (
					<p className={cn("text-xs", f.status === "behind" ? "text-warning" : "text-muted-foreground")} data-testid="course-plan-forecast">
						{forecastLine(f)}
					</p>
				)}
				{hasWeights && weightsSummary && !weighing && (
					<p className="mt-1 text-xs text-muted-foreground" data-testid="course-weights-summary">
						Weighed by the sources{weightsAt ? ` (${weightsAt.slice(0, 10)})` : ""}: {weightsSummary}
					</p>
				)}
				{!hasWeights && !weighing && <p className="mt-1 text-xs text-muted-foreground">Weigh by exams reads your past exams and orders what to learn by how much they use each skill.</p>}
				{weightsError && !weighing && (
					<p className="mt-1 text-xs text-error" data-testid="course-weights-error">
						Weighing failed: {weightsError}
					</p>
				)}
				{error && <p className="mt-1 text-xs text-error">{error}</p>}
			</div>
			{todayHasItems && (
				<div data-testid="course-today">
					<div className={SECTION_HEAD}>Today</div>
					<div className="space-y-1.5">
						{plan.reviewDue > 0 && (
							<div className="flex items-center justify-between rounded-lg border border-border/60 bg-card/50 px-3 py-2 text-sm" data-testid="course-today-review">
								<span>{plan.reviewBatch < plan.reviewDue ? `Review · ${plan.reviewBatch} of ${plan.reviewDue} due` : `Review · ${plan.reviewDue} due`}</span>
								<button type="button" className={BTN} disabled={busy} onClick={() => onStart("review")}>
									Start
								</button>
							</div>
						)}
						{plan.lessons.map((id) => (
							<div key={id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-card/50 px-3 py-2 text-sm" data-testid={`course-today-lesson-${id}`}>
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
		</section>
	);
}
