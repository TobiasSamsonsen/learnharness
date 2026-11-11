"use client";

import { useEffect, useState } from "react";
import { LEARNER_CLAIM_TEXT_MAX, LEARNER_NOTE_MAX, OVERCONFIDENT_AT, type LearnerClaim, type LearnerSettings, type LearnerStats } from "@/src/core";
import { SettingsGroup } from "@/components/settings/controls";

/**
 * Settings → Learner (fork addition, 2026-11-11, core/learner.ts): the one
 * global learner profile in three layers. The note is the learner's own words.
 * The mistake stats are folded from the chats on the spot (never stored). Adapt
 * drafts claims on demand; the draft lives only here, the learner edits or
 * deletes claims and presses Apply, and only then do the claims reach new
 * sessions. Sessions already open keep the profile they were born with.
 */

const BTN = "rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
const FIELD =
	"lh-prose w-full rounded-lg border border-border bg-background px-3 py-2 text-(length:--lh-prose-size) outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";

interface Draft {
	claims: LearnerClaim[];
	gaps: string[];
	sessions: number;
	truncated: boolean;
}

const KIND_LABEL: Record<LearnerClaim["kind"], string> = {
	mistake: "Mistake",
	calibration: "Calibration",
	"what-helped": "What helped",
	pacing: "Pacing",
};

const evidenceOf = (c: LearnerClaim): string =>
	`${c.events} ${c.events === 1 ? "event" : "events"} in ${c.chats.length} ${c.chats.length === 1 ? "chat" : "chats"}${c.tentative ? " · tentative" : ""}`;

export function LearnerSection({
	learner,
	onChange,
}: {
	learner: LearnerSettings | undefined;
	/** Writes the WHOLE learner section (replace-whole). */
	onChange: (next: LearnerSettings) => void;
}) {
	const note = learner?.note ?? "";
	const applied = learner?.applied ?? [];
	const [noteDraft, setNoteDraft] = useState(note);
	const [stats, setStats] = useState<LearnerStats | null | undefined>(undefined);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The stored note flows back after a commit (or arrives from a sync): follow it.
	useEffect(() => setNoteDraft(note), [note]);

	useEffect(() => {
		let live = true;
		fetch("/api/learner")
			.then((r) => (r.ok ? (r.json() as Promise<LearnerStats>) : null))
			.then((s) => live && setStats(s))
			.catch(() => live && setStats(null));
		return () => {
			live = false;
		};
	}, []);

	const commitNote = () => {
		const next = noteDraft.trim();
		if (next === note) return;
		onChange({ ...(next ? { note: next } : {}), ...(applied.length > 0 ? { applied } : {}) });
	};

	const adapt = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/learner/adapt", { method: "POST" });
			const body = (await res.json().catch(() => ({}))) as Partial<Draft> & { error?: string };
			if (!res.ok) setError(body.error ?? `Adapt failed (${res.status})`);
			else setDraft({ claims: body.claims ?? [], gaps: body.gaps ?? [], sessions: body.sessions ?? 0, truncated: body.truncated === true });
		} catch {
			setError("Adapt could not reach the server.");
		} finally {
			setBusy(false);
		}
	};

	const apply = () => {
		if (!draft) return;
		const claims = draft.claims.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text !== "");
		// The note field's text, not the stored note: clicking Apply while the field has focus blurs it first, and the
		// two writes must agree (a stale prop here would overwrite the note just typed).
		const typed = noteDraft.trim();
		onChange({ ...(typed ? { note: typed } : {}), ...(claims.length > 0 ? { applied: claims } : {}) });
		setDraft(null);
	};

	const removeApplied = (index: number) => {
		const next = applied.filter((_, i) => i !== index);
		const typed = noteDraft.trim();
		onChange({ ...(typed ? { note: typed } : {}), ...(next.length > 0 ? { applied: next } : {}) });
	};

	const shownClasses = stats?.fold.classes ?? [];
	const cal = stats?.fold.calibration;

	return (
		<>
			<SettingsGroup label="How I learn best" testid="group-learner-note">
				<p className="text-xs text-muted-foreground/70">
					In your own words: what helps you, what does not. The tutor reads it at the start of new practice, review, teach and learn sessions (not placement tests), as
					background about you, not as instructions. Sessions already open keep what they started with.
				</p>
				<textarea
					value={noteDraft}
					onChange={(e) => setNoteDraft(e.target.value.slice(0, LEARNER_NOTE_MAX))}
					onBlur={commitNote}
					placeholder="For example: I get a concept faster from a worked example than from the definition; I rush the algebra."
					aria-label="How I learn best"
					data-testid="learner-note"
					rows={4}
					className={FIELD}
				/>
				<p className="text-right text-xs text-muted-foreground/60">
					{noteDraft.length}/{LEARNER_NOTE_MAX}
				</p>
			</SettingsGroup>

			<SettingsGroup label="Mistake patterns" testid="group-learner-stats">
				{stats === undefined ? (
					<p className="text-xs text-muted-foreground/70">Reading your sessions…</p>
				) : stats === null ? (
					<p className="text-xs text-muted-foreground/70">The statistics could not be loaded.</p>
				) : (
					<>
						<p className="text-xs text-muted-foreground/70">
							Counted from your sessions, never stored. The tutor sees the pattern only once there are at least 6 classified misses, and names a kind only when it has
							at least 3 of them from 2 sessions. Recent misses rank first.
						</p>
						{shownClasses.length === 0 ? (
							<p className="text-xs text-muted-foreground" data-testid="learner-no-misses">
								No classified misses yet.
							</p>
						) : (
							<ul className="flex flex-col gap-1" data-testid="learner-misses">
								{shownClasses.map((c) => (
									<li key={c.missClass} className="flex items-baseline justify-between gap-3 text-xs">
										<span className="font-prose text-(length:--lh-prose-size)">{c.missClass}</span>
										<span className="text-muted-foreground">
											{c.count} {c.count === 1 ? "miss" : "misses"} · {c.sessions} {c.sessions === 1 ? "session" : "sessions"}
											{stats.fold.missesShown && c.named ? " · shown to the tutor" : ""}
										</span>
									</li>
								))}
							</ul>
						)}
						{cal && cal.answers > 0 && (
							<p className="text-xs text-muted-foreground" data-testid="learner-calibration">
								Lessons: {cal.answers} answers from {cal.sessions} {cal.sessions === 1 ? "session" : "sessions"}; {cal.wrongHigh} of {cal.scored} scored answers were
								wrong at a stated confidence of {OVERCONFIDENT_AT} or more; "I don't know" on {cal.dontKnow}.{" "}
								{cal.shown ? "Shown to the tutor." : "Not shown to the tutor yet (it needs 20 answers from 2 sessions)."}
							</p>
						)}
						<p className="text-xs text-muted-foreground/60">
							Gaps: lessons carry no miss classification (only the answers above), practice outside a course carries no skill, and the kind of problem (proof, example,
							computation) is not recorded.
						</p>
					</>
				)}
			</SettingsGroup>

			<SettingsGroup label="Adapt" testid="group-learner-adapt">
				<p className="text-xs text-muted-foreground/70">
					Asks the strong model to draft observations about you from your sessions. Nothing reaches the tutor until you edit the draft and press Apply. It works from your
					transcripts each time, not from the last profile.
				</p>
				<div className="flex items-center gap-2">
					<button type="button" className={BTN} disabled={busy || stats?.adaptReady === false} onClick={() => void adapt()} data-testid="learner-adapt">
						{busy ? "Drafting…" : "Adapt"}
					</button>
					{stats && !stats.adaptReady && (
						<span className="text-xs text-muted-foreground/70" data-testid="learner-adapt-needs">
							Needs {stats.adaptMinSessions} sessions with evidence; you have {stats.sessions}.
						</span>
					)}
				</div>
				{error && (
					<p role="alert" className="text-xs text-error" data-testid="learner-adapt-error">
						{error}
					</p>
				)}
				{draft && (
					<div className="mt-2 flex flex-col gap-2" data-testid="learner-draft">
						<p className="text-xs text-muted-foreground">
							Draft from {draft.sessions} sessions{draft.truncated ? " (the oldest were left out to fit)" : ""}. Edit or delete anything, then Apply.
						</p>
						{draft.claims.length === 0 && <p className="text-xs text-muted-foreground/70">The evidence did not support any claim.</p>}
						{draft.claims.map((c, i) => (
							<div key={i} className="rounded-md border border-border p-2" data-testid="learner-draft-claim">
								<div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
									<span>
										{KIND_LABEL[c.kind]} · {evidenceOf(c)}
									</span>
									<button
										type="button"
										className={BTN}
										aria-label={`Delete claim ${i + 1}`}
										onClick={() => setDraft({ ...draft, claims: draft.claims.filter((_, j) => j !== i) })}
									>
										Delete
									</button>
								</div>
								<textarea
									value={c.text}
									rows={2}
									aria-label={`Claim ${i + 1}`}
									onChange={(e) =>
										setDraft({ ...draft, claims: draft.claims.map((x, j) => (j === i ? { ...x, text: e.target.value.slice(0, LEARNER_CLAIM_TEXT_MAX) } : x)) })
									}
									className={FIELD}
								/>
							</div>
						))}
						{draft.gaps.length > 0 && (
							<ul className="list-disc pl-5 text-xs text-muted-foreground" data-testid="learner-draft-gaps">
								{draft.gaps.map((g, i) => (
									<li key={i}>{g}</li>
								))}
							</ul>
						)}
						<div className="flex justify-end gap-2">
							<button type="button" className={BTN} onClick={() => setDraft(null)}>
								Discard
							</button>
							<button type="button" className={BTN} onClick={apply} data-testid="learner-apply">
								Apply
							</button>
						</div>
					</div>
				)}
			</SettingsGroup>

			<SettingsGroup label="Applied to new sessions" testid="group-learner-applied">
				{applied.length === 0 ? (
					<p className="text-xs text-muted-foreground/70" data-testid="learner-no-applied">
						Nothing applied yet.
					</p>
				) : (
					<ul className="flex flex-col gap-2" data-testid="learner-applied">
						{applied.map((c, i) => (
							<li key={i} className="rounded-md border border-border p-2">
								<div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
									<span>
										{KIND_LABEL[c.kind]} · {evidenceOf(c)}
									</span>
									<button type="button" className={BTN} aria-label={`Remove applied claim ${i + 1}`} onClick={() => removeApplied(i)}>
										Remove
									</button>
								</div>
								<p className="font-prose text-(length:--lh-prose-size)">{c.text}</p>
							</li>
						))}
					</ul>
				)}
			</SettingsGroup>
		</>
	);
}
