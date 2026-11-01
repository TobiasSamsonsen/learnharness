"use client";

import { PACES, PACE_NOTE_MAX, type Pace } from "@/src/core";

/**
 * The new-session screen's centered setup panel (fork addition, 2026-11-01):
 * how fast to go, and an optional time note. The pace pick is also the
 * default for new sessions (the draft's language pill works the same way);
 * the note belongs to this session only. Both ride the creation request.
 * Presentational: NewSession owns the state and the default's save.
 */
export function SessionSetup({
	pace,
	note,
	onPace,
	onNote,
}: {
	pace: Pace;
	note: string;
	onPace: (pace: Pace) => void;
	onNote: (note: string) => void;
}) {
	return (
		<section data-testid="session-setup" aria-label="Session setup" className="flex w-full max-w-md flex-col gap-3 rounded-2xl border bg-card p-4 text-left shadow-lg">
			<div className="flex flex-col gap-1.5">
				<h4 className="text-xs font-medium text-muted-foreground">How fast do you want to go?</h4>
				<div role="radiogroup" aria-label="Pace" className="flex flex-col gap-1">
					{PACES.map((p) => (
						<button
							key={p.id}
							type="button"
							role="radio"
							aria-checked={p.id === pace}
							data-testid={`setup-pace-${p.id}`}
							onClick={() => onPace(p.id)}
							className={`flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted ${
								p.id === pace ? "border-foreground/40 bg-muted/60 text-foreground" : "border-transparent text-muted-foreground"
							}`}
						>
							<span className="flex flex-col">
								<span className="text-sm">{p.label}</span>
								<span className="text-xs text-muted-foreground/80">{p.blurb}</span>
							</span>
							{p.id === pace && <span aria-hidden>✓</span>}
						</button>
					))}
				</div>
			</div>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				Time note (optional)
				<textarea
					data-testid="setup-note"
					value={note}
					maxLength={PACE_NOTE_MAX}
					rows={2}
					placeholder="e.g. exam Thursday, 4 concepts"
					onChange={(e) => onNote(e.target.value)}
					className="resize-none rounded-md border bg-background px-2 py-1.5 text-sm text-foreground outline-none"
				/>
			</label>
			<p className="text-[11px] text-muted-foreground/70">
				Your pace is the default for new sessions. The note is for this session only; for a course, set it on the course page.
			</p>
		</section>
	);
}
