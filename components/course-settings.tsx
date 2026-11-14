"use client";

import { useEffect, useState } from "react";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import type { LessonMaterial, Pace } from "@/src/core";
import { CoursePace } from "@/components/course-pace";
import { ExamSettings, type ExamPlanSectionProps } from "@/components/exam-plan";
import { LanguageControl } from "@/components/language-control";
import { MaterialsControl } from "@/components/materials-control";

const BTN = "rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
const SECTION_HEAD = "mb-2 text-xs uppercase tracking-widest text-muted-foreground/70";

/**
 * Everything about a course that is set up rarely, behind one closed line under the page header (owner, 2026-11-14):
 * pace, the curriculum (sources, language, draft the skill map), the exam date and "Weigh again", and the placement
 * test. It opens by itself while the skill map is missing, drafting, failed or waiting for review, since the
 * curriculum controls are then the whole page.
 */
export function CourseSettings({
	courseId,
	pace,
	hasSkills,
	hasDraft,
	drafting,
	courseError,
	error,
	materialCount,
	busy,
	onMaterials,
	onDraft,
	onChanged,
	onPlacement,
	exam,
}: {
	courseId: string;
	pace: Pace | undefined;
	hasSkills: boolean;
	hasDraft: boolean;
	drafting: boolean;
	courseError?: string;
	error: string | null;
	materialCount: number;
	busy: boolean;
	onMaterials?: (materials: LessonMaterial[]) => void;
	onDraft: () => void;
	onChanged?: () => void;
	onPlacement: () => void;
	/** The exam settings' props; absent until the course has skills. */
	exam?: Pick<ExamPlanSectionProps, "examDate" | "hasWeights" | "weighing" | "canWeigh"> & { weightsSummary?: string; weightsAt?: string };
}) {
	const needsAttention = !hasSkills || hasDraft || drafting || !!courseError;
	const [open, setOpen] = useState(needsAttention);
	useEffect(() => {
		if (needsAttention) setOpen(true);
	}, [needsAttention]);

	return (
		<details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group" data-testid="course-settings">
			<summary className="flex cursor-pointer list-none items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
				<span className="flex items-center gap-2">
					Course settings
					{drafting && (
						<span className="flex items-center gap-1.5 normal-case tracking-normal" data-testid="course-drafting">
							<Loader2Icon className="size-3.5 animate-spin" />
							The course planner is reading the curriculum…
						</span>
					)}
				</span>
				<ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" aria-hidden />
			</summary>
			<div className="space-y-4 px-1 pt-4">
				<CoursePace courseId={courseId} pace={pace} onSaved={() => onChanged?.()} />
				<section data-testid="course-curriculum">
					<div className={SECTION_HEAD}>Curriculum</div>
					<div className="flex flex-wrap items-center gap-2">
						<MaterialsControl courseId={courseId} onChange={onMaterials} />
						<LanguageControl courseId={courseId} />
						<button type="button" className={BTN} disabled={busy || drafting || materialCount === 0} data-testid="course-draft-button" onClick={onDraft}>
							{hasSkills || hasDraft ? "Re-draft skill map" : "Draft skill map"}
						</button>
					</div>
					{materialCount === 0 && !drafting && <p className="mt-2 text-xs text-muted-foreground">Add the curriculum (PDFs, notes or links), then draft the skill map.</p>}
					{courseError && !drafting && (
						<p className="mt-2 text-xs text-error" data-testid="course-error">
							Drafting failed: {courseError}
						</p>
					)}
					{error && <p className="mt-2 text-xs text-error">{error}</p>}
				</section>
				{exam && <ExamSettings courseId={courseId} busy={busy} onChanged={() => onChanged?.()} {...exam} />}
				{hasSkills && (
					<div>
						<div className={SECTION_HEAD}>Starting point</div>
						<button type="button" className={BTN} disabled={busy} data-testid="course-placement" onClick={onPlacement}>
							Placement test
						</button>
					</div>
				)}
			</div>
		</details>
	);
}
