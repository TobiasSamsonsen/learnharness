"use client";

import { useEffect, useState } from "react";
import { FileTextIcon } from "lucide-react";
import { SketchView } from "@/components/sketch/sketch-view";
import { LectureNoteTextPanel } from "@/components/lecture-note-text-panel";
import { noteSession, type NoteSession } from "@/components/sketch/note-ink";
import type { LectureNote } from "@/src/core";

/**
 * One lecture note open on its infinite canvas (owner plan, 2026-11-19): the sketch view with the note's ink, no Submit, and a
 * title and date in the corner. The ink is saved in segments while writing (sketch/note-ink.ts) and everything is saved when
 * the view closes, which also tells the course page to refresh its row.
 */
type View = { kind: "loading" } | { kind: "ready"; note: LectureNote; session: NoteSession } | { kind: "error"; message: string };

export function LectureNoteView({ courseId, noteId, onClose }: { courseId: string; noteId: string; onClose: () => void }) {
	const [state, setState] = useState<View>({ kind: "loading" });
	const [text, setText] = useState(false);

	// One session per run of the effect: a run that is cleaned up leaves ITS session and ignores its late answer.
	useEffect(() => {
		let alive = true;
		const session = noteSession(courseId, noteId);
		setState({ kind: "loading" });
		session.load().then(
			(note) => alive && setState({ kind: "ready", note, session }),
			(err: unknown) => alive && setState({ kind: "error", message: err instanceof Error ? err.message : "Could not load the lecture note." }),
		);
		return () => {
			alive = false;
			void session.leave();
		};
	}, [courseId, noteId]);

	if (state.kind === "ready") {
		return (
			<SketchView
				label="Lecture note"
				statement=""
				inkKey={noteId}
				note={{
					title: state.note.title,
					date: state.note.date,
					stamp: state.session.stamp,
					extra: (
						<button type="button" data-testid="lecture-note-text-toggle" aria-pressed={text} onClick={() => setText((t) => !t)} className="lh-touch inline-flex items-center gap-1 rounded-full border bg-background/85 px-2.5 py-1 text-xs text-foreground hover:bg-muted">
							<FileTextIcon className="size-3.5" />
							Text
						</button>
					),
					panel: text ? <LectureNoteTextPanel courseId={courseId} noteId={noteId} onClose={() => setText(false)} /> : null,
				}}
				onSubmit={async () => false}
				onClose={onClose}
			/>
		);
	}
	return (
		<div data-testid="lecture-note-loading" role="dialog" aria-label="Lecture note" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-6 text-sm text-muted-foreground">
			<p>{state.kind === "error" ? state.message : "Opening the lecture note…"}</p>
			{state.kind === "error" && (
				<button type="button" onClick={onClose} className="rounded-sm border px-3 py-1.5 text-xs text-foreground hover:bg-muted">
					Close
				</button>
			)}
		</div>
	);
}
