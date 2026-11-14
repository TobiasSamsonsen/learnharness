"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDownIcon, ChevronRightIcon, GraduationCapIcon, PlusIcon } from "lucide-react";
import type { CourseSummary } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { CourseRenameRow, DeleteCourseDialog } from "@/components/course-row-actions";
import { CourseMenu, FolderMenu, FolderRenameRow, type CourseMenuView } from "@/components/course-folder-menus";
import { SwipeRow } from "@/components/swipe-row";
import { examCountdownLabel, filterGroups, folderKey, folderNames, groupCourses } from "@/src/core";

/**
 * The sidebar's Courses section (fork addition, 2026-10-24 — docs/courses.md
 * §6): one row per course with how much of its curriculum is known, and
 * "+ New course" (creates "Untitled course" and opens its page). Freshness
 * rides the events channel like the session list: courses-changed, and
 * every turn settle (a concluded practice problem moves understanding).
 *
 * FOLDERS (owner, 2026-11-14): courses with no folder first, then the folders (highest name first), each a collapsible
 * header "name · 3". The whole section collapses too; both are remembered on this device (not synced). A course moves
 * through its Folder action (swipe, or the right-click / long-press menu) or, with a mouse, by dragging it onto a folder
 * header (onto the Courses header to take it out). While the sidebar's search has text, the section filters with it and
 * every folder with a match is open.
 */

const SECTION_KEY = "lh:courses-open";
const CLOSED_FOLDERS_KEY = "lh:courses-closed-folders";
const DRAG_TYPE = "application/x-lh-course";
/** A touch long-press fires contextmenu and may then deliver the release as a click on the row (the session rows' guard). */
const RELEASE_GUARD_MS = 600;

function readSectionOpen(): boolean {
	try {
		return globalThis.localStorage?.getItem(SECTION_KEY) !== "0";
	} catch {
		return true;
	}
}

function readClosedFolders(): Set<string> {
	try {
		const raw = globalThis.localStorage?.getItem(CLOSED_FOLDERS_KEY);
		const list = raw ? (JSON.parse(raw) as unknown) : [];
		return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

function remember(key: string, value: string) {
	try {
		globalThis.localStorage?.setItem(key, value);
	} catch {
		// remembering is a convenience
	}
}

/** The row's meta line, with the exam countdown when the course has an exam date. Pure — exported for render tests. */
export function courseMeta(course: CourseSummary, now: number = Date.now()): string {
	const base = baseMeta(course);
	if (!course.examDate || course.status === "drafting") return base;
	return `${base} · ${examCountdownLabel(course.examDate, now)}`;
}

function baseMeta(course: CourseSummary): string {
	if (course.status === "drafting") return "Drafting skill map…";
	if (course.total === 0) return course.status === "draft" ? "Draft ready to review" : course.status === "error" ? "Drafting failed" : "No skill map yet";
	return `${course.known}/${course.total} known · ${course.progress}%${course.needsReview > 0 ? ` · ${course.needsReview} due` : ""}`;
}

export function CourseRow({
	course,
	active,
	onOpen,
	onContextMenu,
	draggable,
	onDragStart,
	onDragEnd,
}: {
	course: CourseSummary;
	active: boolean;
	onOpen: () => void;
	onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
	draggable?: boolean;
	onDragStart?: (e: React.DragEvent<HTMLButtonElement>) => void;
	onDragEnd?: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			onContextMenu={onContextMenu}
			draggable={draggable}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			data-drawer-close
			data-testid="course-row"
			data-course-id={course.id}
			className={cn(
				"relative mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-accent",
				active && "bg-accent",
			)}
		>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-prose text-(length:--lh-prose-size)">{course.title}</span>
				<span className="block truncate text-xs text-muted-foreground">{courseMeta(course)}</span>
			</span>
		</button>
	);
}

/** What the open menu is about: a course (its folder list or its three actions) or a folder header. */
type MenuState = { kind: "course"; id: string; view: CourseMenuView } | { kind: "folder"; name: string };

export function CoursesSection({ onCourses, query = "" }: { onCourses?: (courses: CourseSummary[]) => void; query?: string }) {
	const router = useRouter();
	const pathname = usePathname();
	const [courses, setCourses] = useState<CourseSummary[] | null>(null);
	const onCoursesRef = useRef(onCourses);
	onCoursesRef.current = onCourses;
	/** Swipe actions (owner 2026-10-28): the row whose actions are open, the row being renamed, the course up for deletion. */
	const [swipedId, setSwipedId] = useState<string | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<CourseSummary | null>(null);
	const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
	const [menu, setMenu] = useState<MenuState | null>(null);
	const menuAnchorRef = useRef<HTMLElement | null>(null);
	const menuOpenedAtRef = useRef(0);

	// collapse state: per device, read after mount so the server render and the first client render agree
	const [sectionOpen, setSectionOpen] = useState(true);
	const [closedFolders, setClosedFolders] = useState<Set<string>>(() => new Set());
	useEffect(() => {
		setSectionOpen(readSectionOpen());
		setClosedFolders(readClosedFolders());
	}, []);
	const toggleSection = () => {
		const next = !sectionOpen;
		setSectionOpen(next);
		remember(SECTION_KEY, next ? "1" : "0");
	};
	const toggleFolder = (name: string) => {
		const key = folderKey(name);
		const next = new Set(closedFolders);
		if (!next.delete(key)) next.add(key);
		setClosedFolders(next);
		remember(CLOSED_FOLDERS_KEY, JSON.stringify([...next]));
	};

	// drag and drop: mouse and stylus only, so it never meets the touch swipe or the long-press menu
	const [canDrag, setCanDrag] = useState(false);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	useEffect(() => setCanDrag(!globalThis.matchMedia?.("(pointer: coarse)").matches), []);

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

	/** Put a course in a folder, or (null) take it out of its folder. */
	const moveCourse = async (id: string, folder: string | null) => {
		setMenu(null);
		try {
			const res = await fetch(`/api/courses/${encodeURIComponent(id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ folder }),
			});
			if (!res.ok) console.error("could not move the course:", res.status);
		} catch (err) {
			console.error("could not move the course:", err);
		}
		void refresh();
	};

	const changeFolders = async (body: { action: "rename"; from: string; to: string } | { action: "remove"; name: string }) => {
		try {
			const res = await fetch("/api/courses/folders", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) console.error("could not change the folder:", res.status);
		} catch (err) {
			console.error("could not change the folder:", err);
		}
		void refresh();
	};

	const commitFolderRename = (from: string, next: string) => {
		setRenamingFolder(null);
		const to = next.trim();
		if (to && to !== from) void changeFolders({ action: "rename", from, to });
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

	const openMenu = (state: MenuState, anchor: Element | null) => {
		if (!(anchor instanceof HTMLElement)) return;
		menuOpenedAtRef.current = performance.now();
		menuAnchorRef.current = anchor;
		setMenu(state);
	};
	const courseAnchor = (id: string) => document.querySelector(`[data-course-id="${CSS.escape(id)}"]`);

	const searching = query.trim() !== "";
	const groups = courses ? filterGroups(groupCourses(courses), query) : null;
	const allFolders = courses ? folderNames(courses) : [];
	const menuCourse = menu?.kind === "course" ? courses?.find((c) => c.id === menu.id) : undefined;

	const dropOn = (e: React.DragEvent, folder: string | null) => {
		setDropTarget(null);
		const id = e.dataTransfer.getData(DRAG_TYPE);
		if (!id) return;
		e.preventDefault();
		const course = courses?.find((c) => c.id === id);
		if (!course) return;
		if (folder === null ? course.folder === undefined : course.folder !== undefined && folderKey(course.folder) === folderKey(folder)) return;
		void moveCourse(id, folder);
	};
	/** The props that make an element a drop target for a dragged course. */
	const dropProps = (target: string, folder: string | null) =>
		canDrag
			? {
					onDragOver: (e: React.DragEvent) => {
						if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
						e.preventDefault();
						e.dataTransfer.dropEffect = "move";
						if (dropTarget !== target) setDropTarget(target);
					},
					onDragLeave: () => setDropTarget((t) => (t === target ? null : t)),
					onDrop: (e: React.DragEvent) => dropOn(e, folder),
				}
			: {};

	const renderCourse = (c: CourseSummary) =>
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
					{ key: "folder", label: "Folder", onPress: () => openMenu({ kind: "course", id: c.id, view: "folders" }, courseAnchor(c.id)) },
					{ key: "delete", label: "Delete", tone: "danger", onPress: () => setDeleting(c) },
				]}
			>
				<CourseRow
					course={c}
					active={pathname === `/course/${c.id}`}
					onOpen={() => {
						if (performance.now() - menuOpenedAtRef.current < RELEASE_GUARD_MS) return;
						router.push(`/course/${c.id}`);
					}}
					onContextMenu={(e) => {
						e.preventDefault(); // not the browser's menu
						openMenu({ kind: "course", id: c.id, view: "main" }, e.currentTarget);
					}}
					draggable={canDrag}
					onDragStart={(e) => {
						e.dataTransfer.setData(DRAG_TYPE, c.id);
						e.dataTransfer.effectAllowed = "move";
					}}
					onDragEnd={() => setDropTarget(null)}
				/>
			</SwipeRow>
		);

	const renderFolder = (f: { name: string; courses: CourseSummary[] }) => {
		const open = searching || !closedFolders.has(folderKey(f.name));
		return (
			<div key={folderKey(f.name)} data-testid="course-folder" data-folder={f.name}>
				{renamingFolder !== null && folderKey(renamingFolder) === folderKey(f.name) ? (
					<FolderRenameRow name={f.name} onCommit={(next) => commitFolderRename(f.name, next)} onCancel={() => setRenamingFolder(null)} />
				) : (
					<button
						type="button"
						data-testid="course-folder-header"
						aria-expanded={open}
						onClick={() => {
							if (performance.now() - menuOpenedAtRef.current < RELEASE_GUARD_MS) return;
							if (!searching) toggleFolder(f.name);
						}}
						onContextMenu={(e) => {
							e.preventDefault();
							openMenu({ kind: "folder", name: f.name }, e.currentTarget);
						}}
						{...dropProps(`folder:${folderKey(f.name)}`, f.name)}
						className={cn(
							"lh-touch mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground",
							dropTarget === `folder:${folderKey(f.name)}` && "bg-accent text-foreground ring-1 ring-border",
						)}
					>
						{open ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />}
						<span className="min-w-0 truncate">{f.name}</span>
						<span className="shrink-0">· {f.courses.length}</span>
					</button>
				)}
				{open && <div className="pl-2">{f.courses.map(renderCourse)}</div>}
			</div>
		);
	};

	const total = courses?.length ?? 0;
	const bodyOpen = sectionOpen || searching;

	return (
		<div className="mx-3 mb-2" data-testid="courses-section">
			<div className="mb-1 flex items-center justify-between">
				<button
					type="button"
					data-testid="courses-toggle"
					aria-expanded={bodyOpen}
					onClick={toggleSection}
					{...dropProps("section", null)}
					className={cn(
						"lh-touch flex items-center gap-1.5 rounded-lg text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground",
						dropTarget === "section" && "bg-accent text-foreground ring-1 ring-border",
					)}
				>
					<GraduationCapIcon className="size-3" />
					Courses{courses !== null ? ` · ${total}` : ""}
					{bodyOpen ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
				</button>
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
			{bodyOpen && (
				// capped so the sessions below always keep their room; the list scrolls inside
				<div className="max-h-[35dvh] overflow-y-auto" data-testid="courses-list">
					{courses !== null && courses.length === 0 && <div className="px-1 py-1 text-xs text-muted-foreground">No courses yet.</div>}
					{groups?.unfiled.map(renderCourse)}
					{groups?.folders.map(renderFolder)}
				</div>
			)}
			{menu?.kind === "course" && menuCourse && (
				<CourseMenu
					key={`${menu.id}:${menu.view}`}
					anchorRef={menuAnchorRef}
					initialView={menu.view}
					folders={allFolders}
					current={menuCourse.folder}
					onRename={() => {
						setMenu(null);
						setRenamingId(menu.id);
					}}
					onDelete={() => {
						setMenu(null);
						setDeleting(menuCourse);
					}}
					onMove={(folder) => void moveCourse(menu.id, folder)}
					onClose={() => setMenu(null)}
				/>
			)}
			{menu?.kind === "folder" && (
				<FolderMenu
					anchorRef={menuAnchorRef}
					onRename={() => {
						setRenamingFolder(menu.name);
						setMenu(null);
					}}
					onRemove={() => {
						setMenu(null);
						void changeFolders({ action: "remove", name: menu.name });
					}}
					onClose={() => setMenu(null)}
				/>
			)}
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
