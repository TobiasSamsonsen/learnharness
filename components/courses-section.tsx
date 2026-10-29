"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { GraduationCapIcon, PlusIcon } from "lucide-react";
import type { CourseSummary } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { CourseRenameRow, DeleteCourseDialog } from "@/components/course-row-actions";
import { SwipeRow } from "@/components/swipe-row";

/**
 * The sidebar's Courses section (fork addition, 2026-10-24 — docs/courses.md
 * §6): one row per course with how much of its curriculum is known, and
 * "+ New course" (creates "Untitled course" and opens its page). Freshness
 * rides the events channel like the session list: courses-changed, and
 * every turn settle (a concluded practice problem moves a box).
 */

/** The row's meta line. Pure — exported for render tests. */
export function courseMeta(course: CourseSummary): string {
	if (course.status === "drafting") return "Drafting skill map…";
	if (course.total === 0) return course.status === "draft" ? "Draft ready to review" : course.status === "error" ? "Drafting failed" : "No skill map yet";
	const pct = Math.round((course.known / course.total) * 100);
	return `${course.known}/${course.total} known · ${pct}%${course.due > 0 ? ` · ${course.due} due` : ""}`;
}

export function CourseRow({ course, active, onOpen }: { course: CourseSummary; active: boolean; onOpen: () => void }) {
	return (
		<button
			type="button"
			onClick={onOpen}
			data-drawer-close
			data-testid="course-row"
			className={cn(
				"relative mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-accent",
				active && "bg-accent",
			)}
		>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-prose text-(length:--lh-prose-size)">{course.title}</span>
				<span className="block text-xs text-muted-foreground">{courseMeta(course)}</span>
			</span>
		</button>
	);
}

export function CoursesSection({ onCourses }: { onCourses?: (courses: CourseSummary[]) => void }) {
	const router = useRouter();
	const pathname = usePathname();
	const [courses, setCourses] = useState<CourseSummary[] | null>(null);
	const onCoursesRef = useRef(onCourses);
	onCoursesRef.current = onCourses;
	/** Swipe actions (owner 2026-10-28): the row whose actions are open, the row being renamed, the course up for deletion. */
	const [swipedId, setSwipedId] = useState<string | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<CourseSummary | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/courses", { cache: "no-store" });
			const d = (await res.json()) as { courses: CourseSummary[] };
			setCourses(d.courses);
			onCoursesRef.current?.(d.courses);
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

	const commitRename = async (id: string, next: string) => {
		setRenamingId(null);
		const title = next.trim();
		const current = courses?.find((c) => c.id === id)?.title;
		if (!title || title === current) return;
		try {
			await fetch(`/api/courses/${encodeURIComponent(id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title }),
			});
		} catch (err) {
			console.error("could not rename the course:", err);
		}
		void refresh();
	};

	const newCourse = async () => {
		try {
			const res = await fetch("/api/courses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const { id } = (await res.json()) as { id: string };
			router.push(`/course/${id}`);
		} catch (err) {
			console.error("could not create a course:", err);
		}
	};

	return (
		<div className="mx-3 mb-2" data-testid="courses-section">
			<div className="mb-1 flex items-center justify-between">
				<span className="flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground">
					<GraduationCapIcon className="size-3" />
					Courses
				</span>
				<button
					type="button"
					data-testid="new-course"
					onClick={() => void newCourse()}
					className="lh-touch lh-press flex items-center gap-1.5 rounded-pill bg-primary/20 px-2 py-0.5 touch:px-3 touch:py-1.5 text-xs font-medium uppercase tracking-wider text-primary hover:bg-primary/30 active:rounded-lg"
				>
					<PlusIcon className="size-3 touch:size-3.5" />
					New
					<span className="sr-only">create a new course</span>
				</button>
			</div>
			<div className="max-h-48 overflow-y-auto">
				{courses !== null && courses.length === 0 && (
					<div className="px-1 py-1 text-xs text-muted-foreground">No courses yet.</div>
				)}
				{courses?.map((c) =>
					renamingId === c.id ? (
						<CourseRenameRow key={c.id} course={c} onCommit={(next) => void commitRename(c.id, next)} onCancel={() => setRenamingId(null)} />
					) : (
						<SwipeRow
							key={c.id}
							id={c.id}
							openId={swipedId}
							onOpenChange={setSwipedId}
							actions={[
								{ key: "rename", label: "Rename", onPress: () => setRenamingId(c.id) },
								{ key: "delete", label: "Delete", tone: "danger", onPress: () => setDeleting(c) },
							]}
						>
							<CourseRow course={c} active={pathname === `/course/${c.id}`} onOpen={() => router.push(`/course/${c.id}`)} />
						</SwipeRow>
					),
				)}
			</div>
			<DeleteCourseDialog
				course={deleting}
				onClose={() => setDeleting(null)}
				onDeleted={(id) => {
					setDeleting(null);
					if (pathname === `/course/${id}`) router.push("/");
					void refresh();
				}}
			/>
		</div>
	);
}
