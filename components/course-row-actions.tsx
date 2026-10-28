"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CourseSummary } from "@/src/core";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useBackLayer } from "./back-layers.ts";

/**
 * Course row actions (Android phone pass, owner 2026-10-28: swiping a course row reveals the same actions as a session
 * row; course rows had no actions at all before). Rename is the sidebar's inline edit (Enter or blur commits, Esc
 * discards); Delete is a confirmation in the session delete dialog's shape, and the swipe itself never deletes
 * anything. The server routes already exist: PATCH /api/courses/[id] {title}, DELETE /api/courses/[id] (the record and
 * its material; its skills stay in the graph).
 */

export function CourseRenameRow({ course, onCommit, onCancel }: { course: CourseSummary; onCommit: (next: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(course.title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div data-testid="course-rename-row" className="relative mb-0.5 flex w-full items-center rounded-lg bg-accent px-3 py-1.5">
			<span className="flex w-full min-w-0 flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							e.stopPropagation(); // discard, not also the sidebar chain
							onCancel();
						}
					}}
					aria-label="Rename course"
					data-testid="course-rename-input"
					className="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
				/>
			</span>
		</div>
	);
}

export function DeleteCourseDialog({
	course,
	onClose,
	onDeleted,
}: {
	/** The course up for deletion; null = closed. */
	course: Pick<CourseSummary, "id" | "title"> | null;
	onClose: () => void;
	onDeleted: (id: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	useBackLayer(course !== null, onClose);

	// a fresh dialog starts clean
	useEffect(() => {
		setBusy(false);
		setFailure(null);
	}, [course?.id]);

	if (!course) return null;

	const run = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/courses/${encodeURIComponent(course.id)}`, { method: "DELETE" });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setFailure(body?.error ?? `Delete failed (${res.status}).`);
				setBusy(false);
				return;
			}
			onDeleted(course.id);
		} catch {
			setFailure("Delete failed — network error. Try again.");
			setBusy(false);
		}
	};

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Delete course"
				data-testid="delete-course-dialog"
				onClick={(e) => e.stopPropagation()}
				className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
			>
				<h2 className="text-sm font-semibold text-destructive">Delete course?</h2>
				<div className="mt-1.5">
					<code data-testid="course-name-code" className="font-mono text-sm text-foreground">
						{course.title}
					</code>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">
					This removes the course and its curriculum material. Its skills stay in your knowledge graph. This cannot be
					undone.
				</p>
				{failure && (
					<div role="alert" data-testid="delete-course-failure" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs">
						<span className="text-foreground">{failure}</span>
						<button
							type="button"
							data-testid="delete-course-retry"
							onClick={() => void run()}
							disabled={busy}
							className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
						>
							Try again
						</button>
					</div>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						data-testid="delete-course-cancel"
						onClick={onClose}
						disabled={busy}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="delete-course-confirm"
						onClick={() => void run()}
						disabled={busy}
						className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
					>
						{busy ? "Deleting…" : "Delete"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
