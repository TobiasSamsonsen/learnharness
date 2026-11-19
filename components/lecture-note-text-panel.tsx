"use client";

import { useCallback, useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { fetchTranscript, rereadNote, saveSegmentText, type NoteTranscriptView } from "@/components/lecture-notes-client";
import { cn } from "@/lib/utils";

/**
 * The Text view of a lecture note (owner plan, 2026-11-19): what the tutor has of the learner's handwriting, segment by segment,
 * each text editable. A correction is kept as written: a later automatic reading never overwrites it. While a reading runs, the
 * view refreshes itself.
 */

const STATE_LABEL = { unread: "Not read yet", read: "Read", changed: "Ink changed after your correction" } as const;

function clock(ms: number): string {
	return ms > 0 ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

export function LectureNoteTextPanel({ courseId, noteId, onClose }: { courseId: string; noteId: string; onClose: () => void }) {
	const [view, setView] = useState<NoteTranscriptView | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(() => {
		void fetchTranscript(courseId, noteId).then(setView);
	}, [courseId, noteId]);
	useEffect(refresh, [refresh]);
	useEffect(() => {
		if (view?.status !== "reading") return;
		const t = setInterval(refresh, 4000);
		return () => clearInterval(t);
	}, [view?.status, refresh]);

	const save = async (segId: string) => {
		const text = drafts[segId];
		if (text === undefined) return;
		setBusy(true);
		if (await saveSegmentText(courseId, noteId, segId, text)) {
			setDrafts(({ [segId]: _gone, ...rest }) => rest);
			refresh();
		}
		setBusy(false);
	};
	const reread = async (segments: string[] | null) => {
		setBusy(true);
		await rereadNote(courseId, noteId, segments);
		setBusy(false);
		refresh();
	};

	return (
		<div data-ink-hole="" data-testid="lecture-note-text" role="complementary" aria-label="Lecture note text" className="absolute inset-y-0 right-0 z-30 flex w-[min(30rem,100%)] flex-col border-l bg-background text-foreground shadow-xl">
			<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
				<div className="min-w-0">
					<h2 className="text-sm font-semibold">What the tutor reads</h2>
					<p className="truncate text-xs text-muted-foreground" data-testid="lecture-note-digest">
						{view?.status === "reading" ? "Reading your handwriting…" : view?.digest || (view?.status === "error" ? "" : "No summary yet")}
						{view?.status === "error" && view.error ? ` Could not read it: ${view.error}` : ""}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<button type="button" disabled={busy || view?.status === "reading" || (view?.segments.length ?? 0) === 0} onClick={() => void reread(null)} data-testid="lecture-note-reread-all" className="rounded-sm px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
						Read all again
					</button>
					<button type="button" aria-label="Close text" onClick={onClose} className="lh-touch grid size-8 place-items-center rounded-full hover:bg-muted">
						<XIcon className="size-4" />
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
				{view === null && <p className="text-sm text-muted-foreground">Loading…</p>}
				{view?.segments.length === 0 && <p className="text-sm text-muted-foreground">Nothing written yet. The text appears here after you leave the note.</p>}
				{view?.segments.map((s) => {
					const value = drafts[s.id] ?? s.text;
					return (
						<div key={s.id} data-testid="lecture-note-segment" className="space-y-1.5">
							<div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
								<span>
									Segment {s.index} {clock(s.startedAt) && `· from ${clock(s.startedAt)}`}
								</span>
								<span className={cn(s.state === "read" ? "text-muted-foreground" : "text-warning")}>{STATE_LABEL[s.state]}{s.edited && s.state === "read" ? " · corrected by you" : ""}</span>
							</div>
							<textarea
								value={value}
								onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
								rows={Math.min(14, Math.max(3, value.split("\n").length + 1))}
								placeholder={s.state === "unread" ? "Not read yet: it is read when you leave the note." : ""}
								className="w-full resize-y rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs leading-relaxed"
							/>
							<div className="flex justify-end gap-2">
								<button type="button" disabled={busy || view.status === "reading"} onClick={() => void reread([s.id])} className="rounded-sm px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
									Read again
								</button>
								<button type="button" disabled={busy || drafts[s.id] === undefined} onClick={() => void save(s.id)} data-testid="lecture-note-segment-save" className="rounded-sm border border-foreground/30 bg-muted px-2.5 py-1 text-xs hover:bg-muted/70 disabled:pointer-events-none disabled:opacity-40">
									Save correction
								</button>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
