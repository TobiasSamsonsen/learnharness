"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TodayCourse } from "@/src/core";
import { SidebarToggle } from "@/components/sidebar";
import { HEAD_COUNT, PAGE_HEAD } from "@/components/section-heads";
import { todayItemCount, useStartReview, useTodayCourses } from "@/components/today-section";
import { cn } from "@/lib/utils";

/**
 * The Today page (owner, 2026-11-16): what to do today in every course, uncapped. One block per course with something to
 * do, soonest exam first (server order, core/exam-plan.ts): the course and its days to the exam, the review with Start,
 * and the lessons to take today with Learn (which opens the course on that lesson's pace dialog). The sidebar keeps one
 * row that opens this page. Same data as the sidebar row (GET /api/today), fresh on the same events.
 */

/** The course page's Next up button (exam-plan.tsx), so the same rows look the same on both pages. */
const BTN = "rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
const CARD = "min-w-0 rounded-xl border border-border/60 bg-card/50 p-4";

/** "15 days to the exam", "exam today", "exam passed", or nothing without a date. Pure. */
export function examDaysLine(daysLeft: number | undefined): string | null {
	if (daysLeft === undefined) return null;
	if (daysLeft < 0) return "exam passed";
	if (daysLeft === 0) return "exam today";
	return daysLeft === 1 ? "1 day to the exam" : `${daysLeft} days to the exam`;
}

export function TodayPage({ initial }: { initial: TodayCourse[] }) {
	const router = useRouter();
	const courses = useTodayCourses(initial) ?? initial;
	const { busy, startReview } = useStartReview();
	const count = todayItemCount(courses);
	return (
		<div className="relative h-dvh overflow-y-auto">
			<header className="lh-drag z-10 bg-background/85 pb-2 pt-[calc(0.5rem+var(--lh-safe-top))] backdrop-blur sm:sticky sm:top-0">
				<div className="mx-auto flex max-w-5xl items-center gap-3 px-4 sm:px-6">
					<SidebarToggle />
					<h1 className="min-w-0 flex-1 font-title text-[30px] leading-tight">Today</h1>
				</div>
			</header>
			<div className="mx-auto max-w-5xl px-4 pb-16 pt-4 sm:px-6" data-testid="today-page">
				{count === 0 ? (
					<p className="text-sm text-muted-foreground" data-testid="today-empty">
						Nothing to review or learn today. Open a course to practice or learn ahead.
					</p>
				) : (
					<div className="grid items-start gap-4 md:grid-cols-2">
						{courses.map((c) => {
							const days = examDaysLine(c.daysLeft);
							return (
								<section key={c.courseId} className={CARD} data-testid={`today-course-${c.courseId}`}>
									<div className="flex items-baseline justify-between gap-3">
										<Link href={`/course/${c.courseId}`} className={cn(PAGE_HEAD, "min-w-0 truncate hover:underline")}>
											{c.title}
										</Link>
										{days && <span className="shrink-0 text-xs text-muted-foreground">{days}</span>}
									</div>
									<div className="divide-y divide-border/50">
										{c.reviewDue > 0 && (
											<div className="flex items-center justify-between gap-2 py-2 text-sm" data-testid="today-review">
												<span className="flex items-center gap-2">
													<span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: "var(--lh-due)" }} />
													{c.reviewBatch < c.reviewDue ? `Review · ${c.reviewBatch} of ${c.reviewDue}` : `Review · ${c.reviewDue}`}
												</span>
												<button type="button" className={cn(BTN, "border-foreground/40 text-foreground")} disabled={busy} onClick={() => void startReview(c.courseId)}>
													Start
												</button>
											</div>
										)}
										{c.lessons.map((l) => (
											<div key={l.skillId} className="flex items-center justify-between gap-2 py-2 text-sm" data-testid="today-learn">
												<span className="min-w-0 truncate">
													{l.name}
													{l.weight !== 1 && <span className={HEAD_COUNT}>w{l.weight}</span>}
												</span>
												<button type="button" className={BTN} onClick={() => router.push(`/course/${c.courseId}?learn=${encodeURIComponent(l.skillId)}`)}>
													Learn
												</button>
											</div>
										))}
									</div>
								</section>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
