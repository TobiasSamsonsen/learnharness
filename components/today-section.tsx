"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CalendarCheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { TodayCourse } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";

/**
 * The sidebar's Today list (owner, 2026-11-13 — core/exam-plan.ts): above Courses, so the next step is one tap away on
 * the home screen and inside every session. Per course with something to do, soonest exam first: the reviews that are
 * due (a tap starts the review) and the lessons to take today (a tap opens the course page on that lesson's pace
 * dialog). At most five lines in all. Freshness rides the same events as the course list.
 *
 * CLOSED BY DEFAULT (owner, 2026-11-14): open, it took a third of a tablet's sidebar and pushed the sessions out of view,
 * so it is one header line, "Today · 5", that opens it. The choice is remembered on this device.
 */

const OPEN_KEY = "lh:today-open";

function readOpen(): boolean {
	try {
		return globalThis.localStorage?.getItem(OPEN_KEY) === "1";
	} catch {
		return false;
	}
}

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

export function TodaySection() {
	const router = useRouter();
	const pathname = usePathname();
	const [courses, setCourses] = useState<TodayCourse[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [open, setOpen] = useState(false);
	useEffect(() => setOpen(readOpen()), []);
	const toggle = () => {
		const next = !open;
		setOpen(next);
		try {
			globalThis.localStorage?.setItem(OPEN_KEY, next ? "1" : "0");
		} catch {
			// remembering is a convenience
		}
	};

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

	const lines = courses ? todayLines(courses) : [];
	if (lines.length === 0) return null;
	return (
		<div className="mx-3 mb-2" data-testid="today-section">
			<button
				type="button"
				data-testid="today-toggle"
				aria-expanded={open}
				onClick={toggle}
				className="lh-touch mb-1 flex w-full items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
			>
				<CalendarCheckIcon className="size-3" />
				Today · {todayCount(lines)}
				{open ? <ChevronDownIcon className="ml-auto size-3" /> : <ChevronRightIcon className="ml-auto size-3" />}
			</button>
			{open && (
			<div data-testid="today-lines">
				{lines.map((line, i) =>
					line.kind === "head" ? (
						<button
							key={`${line.courseId}-${i}`}
							type="button"
							data-drawer-close
							data-testid="today-course"
							onClick={() => router.push(`/course/${line.courseId}`)}
							className="mt-1 block w-full truncate rounded-md px-2 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							{line.text}
						</button>
					) : (
						<button
							key={`${line.courseId}-${i}`}
							type="button"
							data-drawer-close
							data-testid={line.kind === "review" ? "today-review" : "today-learn"}
							disabled={busy}
							onClick={() => (line.kind === "review" ? void startReview(line.courseId) : router.push(`/course/${line.courseId}?learn=${encodeURIComponent(line.skillId)}`))}
							className={cn("block w-full truncate rounded-lg px-3 py-0.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50")}
						>
							{line.text}
						</button>
					),
				)}
			</div>
			)}
		</div>
	);
}
