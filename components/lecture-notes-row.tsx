"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PlusIcon, MoreHorizontalIcon, PencilLineIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useInteractionLayer } from "@/components/interaction-layers";
import { HEAD_COUNT, PAGE_HEAD } from "@/components/section-heads";
import { LectureNoteView } from "@/components/lecture-note-view";
import { createLectureNote, deleteLectureNote, fetchLectureNotes, thumbnailUrl, updateLectureNote, type LectureNoteItem } from "@/components/lecture-notes-client";
import { useNotifyHub } from "@/components/server-events";
import { defaultNoteTitle, titleShowsDate, todayDate } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The Lecture notes row of the course page (owner, 2026-11-19): a Netflix-style strip of the course's lectures, the first card a
 * "+" that starts a note, each card an ink thumbnail with the title and date. A card opens the note on its infinite canvas
 * (?notes=<id> in the address, so a reload comes back to it); its ⋯ renames, redates or deletes it.
 */

const PARAM = "notes";
const PARAM_EVENT = "lh-notes-param";

function subscribeParam(onChange: () => void): () => void {
	window.addEventListener("popstate", onChange);
	window.addEventListener(PARAM_EVENT, onChange);
	return () => {
		window.removeEventListener("popstate", onChange);
		window.removeEventListener(PARAM_EVENT, onChange);
	};
}

/** The open note's id from the address, and a setter that pushes it there (null closes). */
function useOpenNote(): [string | null, (id: string | null) => void] {
	const id = useSyncExternalStore(subscribeParam, () => (window.location ? new URLSearchParams(window.location.search).get(PARAM) : null), () => null);
	const set = useCallback((next: string | null) => {
		if (!window.location) return;
		const url = new URL(window.location.href);
		if (next) url.searchParams.set(PARAM, next);
		else url.searchParams.delete(PARAM);
		window.history.pushState(window.history.state, "", url);
		window.dispatchEvent(new Event(PARAM_EVENT));
	}, []);
	return [id, set];
}

const CARD_W = "w-40 shrink-0 snap-start";

const READ_DOT: Record<LectureNoteItem["read"], { label: string; dot: string } | null> = {
	none: null,
	unread: { label: "Not read to text yet (it is read when you leave the note)", dot: "bg-warning" },
	reading: { label: "Reading your handwriting…", dot: "animate-pulse bg-primary" },
	read: { label: "Read: the tutor can use this note", dot: "bg-success" },
	error: { label: "Could not be read to text", dot: "bg-error" },
};

export function LectureNotesRow({ courseId }: { courseId: string }) {
	const [notes, setNotes] = useState<LectureNoteItem[] | null>(null);
	const [openId, setOpenId] = useOpenNote();
	const [dialog, setDialog] = useState<{ kind: "create" } | { kind: "edit"; note: LectureNoteItem } | null>(null);

	const refresh = useCallback(() => {
		void fetchLectureNotes(courseId).then(setNotes);
	}, [courseId]);
	useEffect(refresh, [refresh]);
	// the live channel is optional here (an isolated render has none): without it the row simply refetches when it mounts
	const hub = useNotifyHub();
	useEffect(() => {
		const off = hub?.subscribe("courses-changed", refresh);
		return () => {
			off?.();
		};
	}, [hub, refresh]);

	const count = notes?.length ?? 0;
	return (
		<section data-testid="course-lecture-notes" className="min-w-0">
			<h2 className={PAGE_HEAD}>
				Lecture notes
				{count > 0 && <span className={HEAD_COUNT}>{count}</span>}
			</h2>
			<div data-testid="lecture-notes-strip" className="lh-no-scrollbar -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
				<button
					type="button"
					data-testid="lecture-note-new"
					aria-label="New lecture note"
					onClick={() => setDialog({ kind: "create" })}
					className={cn(CARD_W, "lh-touch flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground")}
				>
					<PlusIcon className="size-6" />
					<span className="text-xs">New note</span>
				</button>
				{(notes ?? []).map((n) => (
					<div key={n.id} data-testid="lecture-note-card" className={cn(CARD_W, "group relative")}>
						<button type="button" onClick={() => setOpenId(n.id)} className="block w-full text-left">
							<div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-border/60 bg-white">
								{READ_DOT[n.read] && <span data-testid="lecture-note-read" data-read={n.read} title={READ_DOT[n.read]!.label} className={cn("absolute bottom-1.5 right-1.5 size-2.5 rounded-full ring-2 ring-white", READ_DOT[n.read]!.dot)} />}
								{n.inkAt > 0 ? (
									// eslint-disable-next-line @next/next/no-img-element
									<img src={thumbnailUrl(courseId, n.id, n.inkAt)} alt="" loading="lazy" className="size-full object-cover" />
								) : (
									<div className="grid size-full place-items-center text-muted-foreground/50">
										<PencilLineIcon className="size-6" />
									</div>
								)}
							</div>
							<div className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-foreground">{n.title}</div>
							{!titleShowsDate(n) && <div className="text-xs tabular-nums text-muted-foreground">{n.date}</div>}
						</button>
						<button
							type="button"
							data-testid="lecture-note-edit"
							aria-label={`Edit ${n.title}`}
							onClick={() => setDialog({ kind: "edit", note: n })}
							className="lh-touch absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-full bg-background/85 text-muted-foreground shadow-sm hover:text-foreground"
						>
							<MoreHorizontalIcon className="size-4" />
						</button>
					</div>
				))}
			</div>
			{dialog && (
				<NoteDialog
					courseId={courseId}
					dialog={dialog}
					onClose={() => setDialog(null)}
					onDone={(opened) => {
						setDialog(null);
						refresh();
						if (opened) setOpenId(opened);
					}}
				/>
			)}
			{openId && <LectureNoteView courseId={courseId} noteId={openId} onClose={() => setOpenId(null)} />}
		</section>
	);
}

/** The create / edit dialog: a title and a date; an existing note can also be deleted (after a second press). */
function NoteDialog({
	courseId,
	dialog,
	onClose,
	onDone,
}: {
	courseId: string;
	dialog: { kind: "create" } | { kind: "edit"; note: LectureNoteItem };
	onClose: () => void;
	onDone: (openNoteId?: string) => void;
}) {
	const editing = dialog.kind === "edit" ? dialog.note : null;
	const [date, setDate] = useState(editing?.date ?? todayDate());
	const [title, setTitle] = useState(editing?.title ?? "");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const backdropDismiss = useBackdropDismiss(onClose);
	useInteractionLayer({ kind: "modal", enabled: true, rootRef, onClose: () => { onClose(); return "closed"; } });

	const save = async () => {
		setBusy(true);
		setError(null);
		if (editing) {
			// the title goes only when it was changed: an unchanged (or emptied) field keeps an automatic title automatic
			const changed = title.trim() !== "" && title.trim() !== editing.title;
			const ok = await updateLectureNote(courseId, editing.id, { ...(changed ? { title: title.trim() } : {}), date });
			if (ok) onDone();
			else setError("Could not save the change.");
		} else {
			const created = await createLectureNote(courseId, { ...(title.trim() ? { title: title.trim() } : {}), date });
			if (created) onDone(created.id);
			else setError("Could not create the note.");
		}
		setBusy(false);
	};
	const remove = async () => {
		if (!editing) return;
		setBusy(true);
		if (await deleteLectureNote(courseId, editing.id)) onDone();
		else {
			setError("Could not delete the note.");
			setBusy(false);
		}
	};

	return (
		<div ref={rootRef} className="contents">
			<div role="dialog" aria-modal="true" aria-label={editing ? "Edit lecture note" : "New lecture note"} data-testid="lecture-note-dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" {...backdropDismiss}>
				<form
					className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg"
					onClick={(e) => e.stopPropagation()}
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<h2 className="text-sm font-semibold text-card-foreground">{editing ? "Edit lecture note" : "New lecture note"}</h2>
					<label className="mt-3 block text-xs text-muted-foreground">
						Title
						<input
							data-testid="lecture-note-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder={defaultNoteTitle(date)}
							maxLength={120}
							autoFocus
							className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm text-foreground"
						/>
					</label>
					<label className="mt-3 block text-xs text-muted-foreground">
						Date
						<input data-testid="lecture-note-date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm text-foreground" />
					</label>
					{error && <p className="mt-2 text-xs text-destructive">{error}</p>}
					<div className="mt-4 flex items-center justify-between gap-2">
						{editing ? (
							<button type="button" data-testid="lecture-note-delete" disabled={busy} onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))} className="rounded-sm px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50">
								{confirmDelete ? "Delete lecture and its ink?" : "Delete"}
							</button>
						) : (
							<span />
						)}
						<div className="flex gap-2">
							<button type="button" onClick={onClose} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
								Cancel
							</button>
							<button type="submit" data-testid="lecture-note-save" disabled={busy} className="rounded-sm border border-foreground/30 bg-muted px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/70 disabled:pointer-events-none disabled:opacity-50">
								{editing ? "Save" : "Start note"}
							</button>
						</div>
					</div>
				</form>
			</div>
		</div>
	);
}
