"use client";

/**
 * Finishing a course lesson (owner, 2026-10-25 — docs/courses.md): the
 * top bar's Finish lesson button, the transcript divider both finish
 * paths render (the learner's marker, the teacher's finish_lesson call),
 * and the session's course link read off the context card.
 */

import { CheckIcon, FlagIcon } from "lucide-react";
import type { CourseContextDetails, LhViewMessage } from "@/src/core";
import { Hint } from "@/components/ui/hint";

/** The session's course details — the graph-context card's `course`
 *  block (message[0] of a course session); undefined otherwise. */
export function courseOfView(messages: readonly LhViewMessage[]): CourseContextDetails | undefined {
	for (const m of messages) {
		for (const part of m.parts) {
			if (part.type === "data-graph-context") return (part.data as { course?: CourseContextDetails } | null)?.course;
		}
	}
	return undefined;
}

/** The centered divider: "Lesson finished · <skill> learned". */
export function LessonFinishedLine({ skill }: { skill?: string }) {
	return (
		<div
			data-testid="lesson-finished-line"
			className="my-4 flex items-center justify-center gap-1.5 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground"
		>
			<CheckIcon className="size-3" />
			Lesson finished{skill ? ` · ${skill} learned` : ""}
		</div>
	);
}

/** The top bar's button: Finish lesson, then Finished ✓ (inert). */
export function FinishLessonButton({ finished, blocked, onFinish }: { finished: boolean; blocked: string | null; onFinish: () => void }) {
	if (finished) {
		return (
			<span
				data-testid="lesson-finished-chip"
				className="flex shrink-0 select-none items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
			>
				<CheckIcon className="size-3" />
				Finished
			</span>
		);
	}
	return (
		<Hint label={blocked ?? "Log this lesson as finished — its skill becomes learned and the skills that build on it unlock"} side="bottom">
			<button
				type="button"
				data-testid="finish-lesson"
				disabled={blocked !== null}
				onClick={onFinish}
				className="lh-no-drag flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-50 disabled:hover:border-border/80 disabled:hover:text-muted-foreground"
			>
				<FlagIcon className="size-3" aria-hidden />
				Finish lesson
			</button>
		</Hint>
	);
}
