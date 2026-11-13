"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { SketchReadingBody } from "@/components/artifacts/read-sketch-card";
import { SketchThumbnail } from "@/components/sketch/sketch-thumbnail";
import { gradeNoteOf, isUngraded, repairMathForDisplay, type ArtifactPartProps, type Pace, type SketchRef } from "@/src/core";
import { LearnPaceDialog } from "@/components/learn-pace-dialog";
import { StatusBadge } from "@/components/ui/status-badge";

/**
 * The practice transcript cards (practice sessions, owner design
 * 2026-10-04): three quiet records in the stream —
 *
 * - ProblemCard — a posed problem: the statement, compact-expandable
 *   (like every card here; the dock is the working surface, this is the
 *   record). The commitment NEVER renders — only the call's statement.
 * - ConcludeCard — the conclusion: outcome badge + verdict + the reveal
 *   (the committed solution, shown when the problem ended). A dismissal
 *   synthesis (outcome:"dismissed") renders as one muted line.
 * - ThinkingCard — the learner's own submission, user-side: the register
 *   is the practice dock's one "Your thinking" lane (a working trace or the answer). The
 *   UNIFIED ThinkingBlock (owner round 2026-10-05): the quiz quote-block
 *   language in a faint user-side shell, never collapsible.
 */

import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { ThinkingBlock } from "@/components/thinking-block";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { ChatActionsContext } from "@/components/chat";
import { INTERACTION_LAYER_Z_BASE } from "@/components/host-dialog";
import { useInteractionLayers } from "@/components/interaction-layers";
import { RatingChangeNote } from "@/components/rating-change";

/* TARGET NAMES (owner round 17, 2026-10-06): targets are normalized to
 * opaque node ids at the record seam (owner round 9 — the mastery trace
 * groups on them), so the drawer resolves names at render time. One
 * lazy module-cached fetch of the graph view (the id → name map is a
 * few KB); failures degrade to raw ids — observability never breaks the
 * card. */
let nodeNameMapPromise: Promise<Record<string, string>> | null = null;
function nodeNameMap(): Promise<Record<string, string>> {
	nodeNameMapPromise ??= fetch("/api/graph")
		.then((r) => (r.ok ? r.json() : { nodes: [] }))
		.then((g: { nodes?: Array<{ id?: unknown; name?: unknown }> }) =>
			Object.fromEntries(
				(g.nodes ?? [])
					.filter((n) => typeof n.id === "string")
					.map((n) => [n.id as string, typeof n.name === "string" ? (n.name as string) : (n.id as string)]),
			),
		)
		.catch(() => ({}));
	return nodeNameMapPromise;
}

/** The practice-thinking marker's details (native-messages.ts). */
export interface PracticeThinkingData {
	problemCallId: string;
	/** Legacy records (pre 2026-10-05) carry the old two-lane flag; ignored. */
	commit?: boolean;
	text: string;
	/** The submission's handwriting (Android plan M1). */
	sketch?: SketchRef;
	/** The confidence button pressed with it (a CONFIDENCE_STOPS value), or "I don't know" (owner, 2026-10-28). */
	confidence?: number;
	dontKnow?: boolean;
	images?: readonly Readonly<import("@earendil-works/pi-ai").ImageContent>[];
}

export function ProblemCard({ part }: ArtifactPartProps) {
	// Always open, no chevron (owner round, 2026-10-05): the record IS the
	// statement — same container + eyebrow discipline as the answered card
	// and the dock (which mirrors this in Slice D). The commitment never
	// renders — only the call's statement.
	const input = (part.input ?? {}) as { statement?: string };
	const statement = typeof input.statement === "string" ? input.statement : "";
	return (
		<div data-testid="problem-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</div>
			<div className="lh-prose text-[15px]">
				<ToolContentResponse>{statement}</ToolContentResponse>
			</div>
		</div>
	);
}

const OUTCOME_LABEL: Record<string, string> = {
	solved: "Solved",
	solvedWithHints: "Solved with hints",
	movedOn: "Moved on",
	surrendered: "Surrendered",
	taught: "Taught",
	dismissed: "Dismissed",
};

/* The outcome chips (owner round 3, 2026-10-05): the EXACT register of the
 * quiz cards' correct/incorrect bubbles. Colors per outcome — solved reads
 * green (the "correct" twin), solved-with-hints amber (succeeded with
 * cost), surrendered red (the problem beat the learner), moved on muted
 * (the agent's call, not a verdict against him). */
const OUTCOME_COLOR: Record<string, string | undefined> = {
	solved: "var(--lh-success)",
	solvedWithHints: "var(--lh-warning)",
	surrendered: "var(--lh-error)",
	// The fork's two extra outcomes: a concept taught instead of a problem posed (sky), and a dismissed problem (muted).
	taught: "oklch(0.685 0.169 237.323)",
	dismissed: undefined,
};

export function ConcludeCard({ part }: ArtifactPartProps) {
	// The conclusion redesigned (owner round, 2026-10-05): the SOLUTION is
	// the hero — the modelSolution committed at pose time (part.reveal, the
	// view-seam join), shown verbatim, never re-authored. The verdict sits
	// below in the quiz-explanation register (small, muted, low-key).
	// Nothing collapsible. Legacy inputs (pre-slim records) that carry
	// their own solutionReveal fall back to it.
	const input = (part.input ?? {}) as { outcome?: string; verdict?: string; solutionReveal?: string; grades?: unknown };
	// the grader's grades ride the result's details (agent/practice-grade.ts); older records kept the tutor's own on the call
	const output = part.output as { grades?: unknown } | null | undefined;
	const grades = Array.isArray(output?.grades) ? output.grades : input.grades;
	// a grading that failed, or that the session's model did instead (owner, 2026-11-13)
	const ungraded = isUngraded(output);
	const gradeNote = gradeNoteOf(output);
	const outcome = typeof input.outcome === "string" ? input.outcome : "";
	const verdict = typeof input.verdict === "string" ? input.verdict : "";
	const reveal =
		typeof part.reveal === "string" ? part.reveal : typeof input.solutionReveal === "string" ? input.solutionReveal : "";
	const chat = useContext(ChatActionsContext);

	// The dismissal synthesis: no verdict, no reveal — one muted line (the
	// learner clicked; the record needs only the fact).
	if (outcome === "dismissed") {
		return (
			<div data-testid="conclude-card" className="my-1 px-1 text-sm text-muted-foreground/70">
				Problem dismissed.
			</div>
		);
	}

	return (
		<div data-testid="conclude-card" className="lh-card-enter relative my-1 rounded-xl border bg-card p-4">
			{/* The heading row (owner round 3, 2026-10-05): plain 'Concluded'
			    eyebrow + the outcome in the quiz cards' EXACT chip register —
			    no more two same-weight headings stacked. */}
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Concluded
				{(OUTCOME_LABEL[outcome] ?? "") !== "" && outcome !== "dismissed" && (
					<StatusBadge text={OUTCOME_LABEL[outcome] ?? ""} color={OUTCOME_COLOR[outcome]} />
				)}
			</div>
			{/* The verdict — plain prose under the heading, no 'Verdict:' label
			    (owner round 3): the same quiet 50% register as quiz explanations. */}
			{verdict.length > 0 && (
				<div className="text-sm text-foreground/50">
					<ToolContentResponse>{verdict}</ToolContentResponse>
				</div>
			)}
			{/* Then the divider, then the labeled model solution (Slice G: the
			    hero is the pose's commitment, verbatim). */}
			{reveal.length > 0 && (
				<>
					<div className="my-3 border-t" />
					<div>
						<div className="mb-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Model solution</div>
						<div className="lh-prose text-[15px]">
							<ToolContentResponse>{reveal}</ToolContentResponse>
						</div>
					</div>
				</>
			)}
			{ungraded ? (
				<UngradedNote chatId={chat?.chatId} toolCallId={part.toolCallId} reason={gradeNote.gradeError} />
			) : (
				gradeNote.gradedBy === "session" && (
					<div data-testid="grade-fallback-note" className="mt-3 text-xs text-muted-foreground">
						Graded by the session's model.{gradeNote.gradeError ? ` The grader failed: ${gradeNote.gradeError}.` : ""}
					</div>
				)
			)}
			{chat && <RatingChangeNote chatId={chat.chatId} callId={part.toolCallId} />}
			{chat && <LearnSkillButtons chatId={chat.chatId} skillIds={learnableSkillIds({ outcome: input.outcome, grades })} />}
			<MetadataPopover
				concludeInput={input}
				problemInput={(part.problemInput ?? {}) as { mode?: unknown; target?: unknown }}
			/>
		</div>
	);
}

/** The outcomes that leave room to learn a skill graded `again`. */
const LEARNABLE_OUTCOMES = ["taught", "movedOn", "surrendered"];

/** The skill ids graded `again` on a concluded problem, when the
 *  outcome leaves room to learn them. Pure; malformed grades are skipped. */
export function learnableSkillIds(input: { outcome?: unknown; grades?: unknown }): string[] {
	if (typeof input.outcome !== "string" || !LEARNABLE_OUTCOMES.includes(input.outcome)) return [];
	if (!Array.isArray(input.grades)) return [];
	const ids: string[] = [];
	for (const g of input.grades as unknown[]) {
		if (typeof g !== "object" || g === null) continue;
		const { skill, grade } = g as { skill?: unknown; grade?: unknown };
		if (typeof skill === "string" && grade === "again") ids.push(skill);
	}
	return [...new Set(ids)];
}

/* NOT GRADED (owner, 2026-11-13): the grader and its fallback both failed, so a cautious default grade
 * stands. The line says why; "Grade again" re-runs the grading on the stored problem
 * (POST /api/chats/[id]/regrade). On success the record changes and the chat re-reads it, so this
 * note leaves with the next render; a failure shows its reason under the button. */
function UngradedNote({ chatId, toolCallId, reason }: { chatId: string | undefined; toolCallId: string; reason: string | undefined }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const regrade = async () => {
		if (!chatId || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/regrade`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ toolCallId }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
				setError(typeof body?.error === "string" ? body.error : `Could not grade the problem (${res.status})`);
			}
		} catch {
			setError("Could not grade the problem");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div data-testid="ungraded-note" className="mt-3 text-xs">
			<div className="text-[var(--lh-warning)]">
				Not graded.{reason ? ` The grader failed: ${reason}.` : ""} A cautious default grade applies.
			</div>
			{chatId && (
				<button type="button" className={`${LEARN_BTN} mt-2`} disabled={busy} onClick={() => void regrade()}>
					{busy ? "Grading…" : "Grade again"}
				</button>
			)}
			{error && <div className="mt-1 text-error">{error}</div>}
		</div>
	);
}

const LEARN_BTN =
	"rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

/* THE LEARN BUTTONS (owner goal, 2026-11-07): a concluded review or practice
 * problem offers a Learn session on each skill the tutor graded `again`. The
 * course's skill names are read once per mount; any failure renders nothing.
 * Starting a Learn session changes no mastery — the review resumes from the
 * Next problem chip. */
function LearnSkillButtons({ chatId, skillIds }: { chatId: string; skillIds: string[] }) {
	const [course, setCourse] = useState<{ courseId: string; skills: Array<{ id: string; name: string }> } | null>(null);
	const key = skillIds.join("|");
	useEffect(() => {
		if (key === "") return;
		let alive = true;
		fetch(`/api/chats/${encodeURIComponent(chatId)}/course`)
			.then((r) => (r.ok ? (r.json() as Promise<{ courseId?: unknown; skills?: unknown } | null>) : null))
			.then((body) => {
				if (alive && body && typeof body.courseId === "string" && Array.isArray(body.skills)) {
					setCourse({ courseId: body.courseId, skills: body.skills as Array<{ id: string; name: string }> });
				}
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [chatId, key]);
	if (!course) return null;
	const targets = skillIds
		.map((id) => course.skills.find((s) => s.id === id))
		.filter((s): s is { id: string; name: string } => s !== undefined);
	if (targets.length === 0) return null;
	return <LearnSkillRow courseId={course.courseId} skills={targets} />;
}

function LearnSkillRow({ courseId, skills }: { courseId: string; skills: Array<{ id: string; name: string }> }) {
	const router = useRouter();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// A Learn start asks for its pace first (fork addition, 2026-11-09): the button opens the dialog, Start calls learn().
	const [pending, setPending] = useState<string | null>(null);
	const learn = async (skillId: string, pace: Pace) => {
		setBusy(skillId);
		setError(null);
		try {
			const res = await fetch(`/api/courses/${courseId}/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "learn", skillId, pace }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
				setError(typeof body?.error === "string" ? body.error : `Could not start the lesson (${res.status})`);
				setBusy(null);
				return;
			}
			const { id, prompt } = (await res.json()) as { id: string; prompt: string };
			router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
		} catch {
			setError("Could not start the lesson");
			setBusy(null);
		}
	};
	return (
		<div className="mt-3">
			<div className="flex flex-wrap gap-2">
				{skills.map((s) => (
					<button
						key={s.id}
						type="button"
						data-testid={`learn-skill-${s.id}`}
						disabled={busy !== null}
						onClick={() => setPending(s.id)}
						className={LEARN_BTN}
					>
						{`Learn ${s.name}`}
					</button>
				))}
			</div>
			{error && <div className="mt-2 text-xs text-error">{error}</div>}
			{pending !== null && (
				<LearnPaceDialog
					courseId={courseId}
					busy={busy !== null}
					onClose={() => setPending(null)}
					onStart={(pace) => {
						const skillId = pending;
						setPending(null);
						void learn(skillId, pace);
					}}
				/>
			)}
		</div>
	);
}

/* THE METADATA POPOVER (owner round 17 refinement, 2026-10-06 — full
 * transparency): a quiet METADATA trigger at the very bottom of the
 * conclude card (no divider — it just sits there); click opens the
 * info-box register of the graph-view node cards (rounded-xl border
 * bg-card p-4 shadow-lg, opening BELOW the trigger — always); any scroll or
 * click outside closes it (plus Esc, claimed from the layered chain
 * per the popover law). Shows every field the agent filled in both the
 * problem call (mode, targets — names resolved lazily) and the
 * conclude call (outcome, rung, miss class, retest). Statement and
 * modelSolution stay out — they are the visible card. The data keeps
 * the original SMALL register (text-xs rows, mono values — owner
 * correction: the 15px pass was way too large); the trigger matches
 * the eyebrow size; the box opens BELOW the trigger, always. */
function MetadataPopover({
	concludeInput,
	problemInput,
}: {
	concludeInput: { outcome?: string; rung?: unknown; missClass?: unknown; retest?: unknown };
	problemInput: { mode?: unknown; target?: unknown };
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const interactions = useInteractionLayers();
	// The portal's anchor (owner fix, 2026-10-06): the box is placed from
	// the trigger's viewport rect AT OPEN TIME — any scroll closes the
	// box, so there is nothing to track.
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const [names, setNames] = useState<Record<string, string> | null>(null);
	const targets = Array.isArray(problemInput.target)
		? problemInput.target.filter((t): t is string => typeof t === "string")
		: [];
	// Resolve names only when there is something to resolve.
	useEffect(() => {
		if (!open || targets.length === 0 || names) return;
		let alive = true;
		void nodeNameMap().then((m) => {
			if (alive) setNames(m);
		});
		return () => {
			alive = false;
		};
	}, [open, targets.length, names]);

	const popupLayer = usePopoverDismiss(rootRef, open, () => setOpen(false), { layerRootRef: panelRef });
	// ANY scroll closes it (owner law): capture-phase, so every scroller
	// in the tree counts — the transcript's own scroll included.
	useEffect(() => {
		if (!open) return;
		const close = () => { if (interactions.isElementEligible(panelRef.current)) setOpen(false); };
		window.addEventListener("scroll", close, { capture: true, passive: true });
		return () => window.removeEventListener("scroll", close, { capture: true });
	}, [open, interactions]);

	const mode = typeof problemInput.mode === "string" ? problemInput.mode : "";
	const rung = typeof concludeInput.rung === "string" ? concludeInput.rung : "";
	const miss = typeof concludeInput.missClass === "string" ? concludeInput.missClass : "";
	const retest = typeof concludeInput.retest === "boolean" ? concludeInput.retest : undefined;
	const outcome = typeof concludeInput.outcome === "string" ? concludeInput.outcome : "";
	if (!mode && targets.length === 0 && !rung && !miss && retest === undefined) return null;

	return (
		<div ref={rootRef} className="relative mt-3">
			<button
				type="button"
				data-testid="metadata-toggle"
				ref={triggerRef}
				onClick={() => {
					setOpen((v) => {
						if (v) return false;
						const r = triggerRef.current?.getBoundingClientRect();
						if (r) {
							// Below the trigger, always; clamped so the 320px box
							// never leaves the viewport's right edge.
							const left = Math.max(8, Math.min(r.left, window.innerWidth - 328));
							setAnchor({ top: r.bottom + 8, left });
						}
						return true;
					});
				}}
				aria-expanded={open}
				className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
			>
				Metadata
			</button>
			{open &&
				anchor &&
				createPortal(
					<div
						ref={panelRef}
						data-testid="metadata-box"
						// PORTALED TO BODY (owner fix, 2026-10-06): the transcript's
						// MessageContent boxes carry overflow-hidden — an absolutely
						// positioned child clips at its own message block's edge (the
						// cut-off bug). A fixed-position portal sits on top of
						// EVERYTHING, the dialogs' law. Node-card info-box register;
						// opening BELOW the trigger — always.
						// capped to the room below the trigger (owner goal 2026-10-28: nothing off the screen): it scrolls inside instead
						style={{ position: "fixed", top: anchor.top, left: anchor.left, maxHeight: `max(6rem, calc(100dvh - ${anchor.top}px - 8px))`, overflowY: "auto", zIndex: INTERACTION_LAYER_Z_BASE + popupLayer.order }}
						className="w-80 max-w-[calc(100vw-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg"
					>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
						<dt className="text-muted-foreground">Mode</dt>
						<dd className="font-mono">{mode || "—"}</dd>
						<dt className="text-muted-foreground">Targets</dt>
						<dd className="font-mono">
							{targets.length === 0 ? (
								"untagged"
							) : (
								<span>
									{targets.map((t, i) => (
										<span key={t}>
											{i > 0 && ", "}
											{names?.[t] ?? t}
										</span>
									))}
								</span>
							)}
						</dd>
						<dt className="text-muted-foreground">Outcome</dt>
						<dd className="font-mono">{outcome || "—"}</dd>
						<dt className="text-muted-foreground">Hint rung</dt>
						<dd className="font-mono">{rung || "none"}</dd>
						<dt className="text-muted-foreground">Miss class</dt>
						<dd className="font-mono">{miss || "none"}</dd>
						<dt className="text-muted-foreground">Retest</dt>
						<dd className="font-mono">{retest === undefined ? "—" : retest ? "yes" : "no"}</dd>
					</dl>
					</div>,
					interactions.getPortalContainer(triggerRef.current)!,
				)}
		</div>
	);
}

export function ThinkingCard({ data, chatId, reading }: { data: PracticeThinkingData; chatId?: string; reading?: ArtifactPartProps["part"] }) {
	// The unified row (owner rounds, 2026-10-05): one style, one label —
	// 50%-italic quote block on expand. Legacy records' commit flag is
	// deliberately unread (one lane now). A TRANSCRIPT row (owner round,
	// 2026-10-07): full-width band + rail, arriving expanded.
	const label = data.dontKnow ? "YOUR THINKING · I DON'T KNOW" : data.confidence !== undefined ? `YOUR THINKING · ${data.confidence}%` : "YOUR THINKING";
	const block = data.text.trim() || data.images?.length ? <ThinkingBlock testId="thinking-card" label={label} text={data.text} images={data.images} defaultOpen /> : null;
	if (!data.sketch || !chatId) return block;
	// A sketch submission (Android plan M1): the page under the words —
	// or alone, when the learner only drew.
	return (
		<div data-testid="thinking-sketch">
			{block}
			<SketchThumbnail chatId={chatId} sketch={data.sketch} />
			{/* the tutor's reading of it, right under it (owner, 2026-10-29) */}
			{reading && <SketchReadingBody part={reading} framed />}
			</div>
	);
}
