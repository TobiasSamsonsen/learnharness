"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { FOLDER_NAME_MAX, folderKey } from "@/src/core";
import { MenuShell } from "./menu-shell.tsx";

/**
 * The menus of the sidebar's course folders (owner, 2026-11-14): the menu on a course row (Rename, Folder, Delete — the
 * same three the swipe shows, for the mouse and the stylus too), its folder list (existing folders, "No folder", "New
 * folder…"), and the menu on a folder header (Rename folder, Remove folder). Placement is the shared MenuShell; the
 * dismissal contract is the session menu's: a pointerdown outside the menu or its anchor closes it, Esc closes it.
 */

const ITEM = "flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent [@media(pointer:coarse)]:min-h-11";
const MENU = "flex w-56 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl";

/** Close the menu when a pointer goes down anywhere but on the menu or its anchor. */
function useOutsideClose(anchorRef: RefObject<HTMLElement | null>, onClose: () => void) {
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			const target = e.target;
			if (!(target instanceof Node)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (anchorRef.current?.contains(target)) return;
			closeRef.current();
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [anchorRef]);
}

export type CourseMenuView = "main" | "folders";

/** The menu of one course row. `folders` are the names in use; `current` is this course's folder, if any. `onMove(null)`
 *  takes it out of its folder. */
export function CourseMenu({
	anchorRef,
	initialView,
	folders,
	current,
	onRename,
	onDelete,
	onMove,
	onClose,
}: {
	anchorRef: RefObject<HTMLElement | null>;
	initialView: CourseMenuView;
	folders: readonly string[];
	current: string | undefined;
	onRename: () => void;
	onDelete: () => void;
	onMove: (folder: string | null) => void;
	onClose: () => void;
}) {
	const [view, setView] = useState<CourseMenuView | "new">(initialView);
	useOutsideClose(anchorRef, onClose);
	return (
		<MenuShell
			onClose={() => {
				onClose();
				return "closed";
			}}
			anchorRef={anchorRef}
			testid="course-context-menu"
			preferredSide="down"
			menuClass={MENU}
		>
			{view === "main" && (
				<>
					<button type="button" data-testid="ctx-course-rename" onClick={onRename} className={ITEM}>
						Rename
					</button>
					<button type="button" data-testid="ctx-course-folder" onClick={() => setView("folders")} className={`${ITEM} justify-between`}>
						Folder
						<ChevronRightIcon className="size-3 text-muted-foreground" />
					</button>
					<button
						type="button"
						data-testid="ctx-course-delete"
						onClick={onDelete}
						className={`${ITEM} text-muted-foreground/80 hover:text-foreground`}
					>
						Delete…
					</button>
				</>
			)}
			{view === "folders" && (
				<>
					<button type="button" data-testid="folder-option-none" onClick={() => onMove(null)} className={`${ITEM} justify-between`}>
						No folder
						{current === undefined && <CheckIcon className="size-3.5" aria-label="Current" />}
					</button>
					{folders.map((name) => (
						<button
							key={name}
							type="button"
							data-testid="folder-option"
							onClick={() => onMove(name)}
							className={`${ITEM} justify-between gap-2`}
						>
							<span className="min-w-0 truncate">{name}</span>
							{current !== undefined && folderKey(current) === folderKey(name) && <CheckIcon className="size-3.5 shrink-0" aria-label="Current" />}
						</button>
					))}
					<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
					<button type="button" data-testid="folder-option-new" onClick={() => setView("new")} className={ITEM}>
						New folder…
					</button>
				</>
			)}
			{view === "new" && <NewFolderField onCommit={onMove} />}
		</MenuShell>
	);
}

/** The text box inside the menu that names a new folder. Enter commits; blank does nothing. */
function NewFolderField({ onCommit }: { onCommit: (name: string) => void }) {
	const [draft, setDraft] = useState("");
	const ref = useRef<HTMLInputElement | null>(null);
	useEffect(() => ref.current?.focus(), []);
	const commit = () => {
		const name = draft.trim();
		if (name) onCommit(name);
	};
	return (
		<div className="flex flex-col gap-1.5 px-1 py-0.5">
			<input
				ref={ref}
				value={draft}
				maxLength={FOLDER_NAME_MAX}
				spellCheck={false}
				placeholder="e.g. 2026-2 Høst"
				aria-label="New folder name"
				data-testid="new-folder-input"
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					}
				}}
				className="lh-input w-full min-w-0 border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
			/>
			<span className="text-muted-foreground">Folders sort highest name first: name them so the newest is on top.</span>
			<button
				type="button"
				data-testid="new-folder-commit"
				onClick={commit}
				disabled={draft.trim() === ""}
				className="self-end rounded-lg px-2.5 py-1.5 text-foreground transition-colors hover:bg-accent disabled:opacity-40 [@media(pointer:coarse)]:min-h-11"
			>
				Create
			</button>
		</div>
	);
}

/** The menu of a folder header: rename it (merges into a folder of the same name) or remove it (its courses move out of
 *  any folder; none is deleted). */
export function FolderMenu({
	anchorRef,
	onRename,
	onRemove,
	onClose,
}: {
	anchorRef: RefObject<HTMLElement | null>;
	onRename: () => void;
	onRemove: () => void;
	onClose: () => void;
}) {
	useOutsideClose(anchorRef, onClose);
	return (
		<MenuShell
			onClose={() => {
				onClose();
				return "closed";
			}}
			anchorRef={anchorRef}
			testid="folder-context-menu"
			preferredSide="down"
			menuClass={MENU}
		>
			<button type="button" data-testid="ctx-folder-rename" onClick={onRename} className={ITEM}>
				Rename folder
			</button>
			<button type="button" data-testid="ctx-folder-remove" onClick={onRemove} className={ITEM}>
				Remove folder
			</button>
			<span className="px-2.5 pb-1 text-muted-foreground">Removing a folder deletes no course.</span>
		</MenuShell>
	);
}

/** The folder header's inline rename: Enter or blur commits, Esc discards (the course rename row's rules). */
export function FolderRenameRow({ name, onCommit, onCancel }: { name: string; onCommit: (next: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(name);
	const ref = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	return (
		<div data-testid="folder-rename-row" className="mb-0.5 flex w-full items-center rounded-lg bg-accent px-3 py-1.5">
			<input
				ref={ref}
				value={draft}
				maxLength={FOLDER_NAME_MAX}
				spellCheck={false}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => onCommit(draft)}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") {
						e.stopPropagation();
						onCancel();
					}
				}}
				aria-label="Rename folder"
				data-testid="folder-rename-input"
				className="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
			/>
		</div>
	);
}
