"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CalendarCheckIcon, CheckIcon, ChevronRightIcon } from "lucide-react";
import type { TodayCourse } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";

/**
 * The sidebar's Today list (owner, 2026-11-13 — core/exam-plan.ts): above Courses, so the next step is one tap away on
 * the home screen and inside every session. Per course with something to do, soonest exam first: the reviews that are
 * due (a tap starts the review) and the lessons to take today (a tap opens the course page on that lesson's pace
 * dialog). At most five lines in all. Freshness rides the same events as the course list.
 *
 * CLOSED BY DEFAULT (owner, 2026-11-14): open, it took a third of a tablet's sidebar and pushed the sessions out of view.
 * A PAGE SINCE 2026-11-16 (owner): the sidebar keeps one row that opens /today (components/today-page.tsx), which lists
 * every course's plan uncapped. todayLines / todayHead stay the pure line model (render tests).
 */

/** The header's count: the item lines (reviews and lessons), not the course headings. Pure. */
export function todayCount(lines: readonly TodayLine[]): number {
	return lines.filter((l) => l.kind !== "head").length;
}

/** Most item lines the list shows. */
export const TODAY_MAX_LINES = 5;

export type TodayLine =
	| { kind: "head"; courseId: string; text: string }
	| { kind: "review"; courseId: string; text: string }
	| { kind: "learn"; courseId: string; skillId: string; text: string };

/** "Matte 1 · 29 days": the course line. Pure. */
export function todayHead(c: Pick<TodayCourse, "title" | "daysLeft">): string {
	if (c.daysLeft === undefined) return c.title;
	if (c.daysLeft < 0) return `${c.title} · exam passed`;
	return `${c.title} · ${c.daysLeft === 0 ? "exam today" : c.daysLeft === 1 ? "1 day" : `${c.daysLeft} days`}`;
}

/** The lines to show: a course line, then its review and lessons, until `max` item lines are used; a course whose items
 *  do not fit at all is left out. Pure. */
export function todayLines(courses: readonly TodayCourse[], max = TODAY_MAX_LINES): TodayLine[] {
	const lines: TodayLine[] = [];
	let used = 0;
	for (const c of courses) {
		const items: TodayLine[] = [];
		if (c.reviewDue > 0) items.push({ kind: "review", courseId: c.courseId, text: `Review (${c.reviewDue} due)` });
		for (const l of c.lessons) items.push({ kind: "learn", courseId: c.courseId, skillId: l.skillId, text: `Learn: ${l.name}` });
		const room = max - used;
		if (room <= 0) break;
		const shown = items.slice(0, room);
		if (shown.length === 0) continue;
		lines.push({ kind: "head", courseId: c.courseId, text: todayHead(c) }, ...shown);
		used += shown.length;
	}
	return lines;
}

/** Every item line across the courses, uncapped: the Today page's count. Pure. */
export function todayItemCount(courses: readonly TodayCourse[]): number {
	return courses.reduce((n, c) => n + (c.reviewDue > 0 ? 1 : 0) + c.lessons.length, 0);
}

/** Every item completed today across the courses. Pure. */
export function todayDoneCount(courses: readonly TodayCourse[]): number {
	return courses.reduce((n, c) => n + (c.reviewDoneToday ? 1 : 0) + (c.doneLessons?.length ?? 0), 0);
}

/** The Today data, fresh on the same events as the course list (the sidebar row and the Today page). */
export function useTodayCourses(initial: TodayCourse[] | null = null) {
	const pathname = usePathname();
	const [courses, setCourses] = useState<TodayCourse[] | null>(initial);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/today", { cache: "no-store" });
			const d = (await res.json()) as { courses: TodayCourse[] };
			setCourses(d.courses);
		} catch {
			setCourses((prev) => prev ?? []);
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh, pathname]);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refresh();
		}, 250);
	};
	useServerEvent("courses-changed", schedule);
	useServerEvent("turn-settled", schedule);
	useServerEvent("chats-changed", schedule);
	useServerResync(() => void refresh());
	useEffect(() => () => debounceRef.current && clearTimeout(debounceRef.current), []);
	return courses;
}

/** Start a course's review session and open it; on any failure, open the course page instead. */
export function useStartReview() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const startReview = async (courseId: string) => {
		if (busy) return;
		setBusy(true);
		try {
			const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "review" }) });
			if (!res.ok) {
				router.push(`/course/${courseId}`);
				return;
			}
			const { id, prompt } = (await res.json()) as { id: string; prompt: string };
			router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
		} catch {
			router.push(`/course/${courseId}`);
		} finally {
			setBusy(false);
		}
	};
	return { busy, startReview };
}

/**
 * The sidebar's Today row (owner, 2026-11-16): one line, "Today 5", that opens the Today page (/today). The list itself
 * moved to the page, so the sidebar never gives its height to it.
 */
export function TodaySection() {
	const pathname = usePathname();
	const courses = useTodayCourses();
	const count = courses ? todayItemCount(courses) : 0;
	const done = courses ? todayDoneCount(courses) : 0;
	if (count === 0 && done === 0) return null;
	const active = pathname === "/today";
	return (
		<div className="mx-3 mb-1" data-testid="today-section">
			<Link
				href="/today"
				data-drawer-close
				data-testid="today-link"
				aria-current={active ? "page" : undefined}
				className={cn(
					"lh-touch flex w-full items-center gap-2 rounded-lg px-2 py-1 text-[13px] font-medium transition-colors hover:bg-accent",
					active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
				)}
			>
				<CalendarCheckIcon className="size-3.5" />
				Today
				{count > 0 ? (
					<span className="font-normal tabular-nums text-muted-foreground/60">{count}</span>
				) : (
					<CheckIcon className="size-3.5 shrink-0 text-muted-foreground/60" aria-label="All done today" data-testid="today-done" />
				)}
				<ChevronRightIcon className="ml-auto size-3.5" />
			</Link>
		</div>
	);
}
