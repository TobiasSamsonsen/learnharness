"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ChevronRightIcon, PenLineIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { useEnterSubmits } from "@/components/enter-submits";
import { MessageResponse } from "@/components/ai-elements/message";
import { FigureScope } from "@/components/figures/figure-scope";
import { SketchView } from "@/components/sketch/sketch-view";
import { cn } from "@/lib/utils";
import {
	buildAnswer,
	normalizeQuizType,
	CONFIDENCE_STOPS,
	nearestConfidenceStop,
	dockSubmitGate,
	emptyDockSelection,
	normalizeOptions,
	resolveCorrect,
	seededRandom,
	shuffleOptions,
	toolQuestionKind,
	parseAskInput,
	parseQuizInput,
	parseExplainInput,
	sketchRefOf,
	toggleOption,
	toggleOther,
	type AnswerRequest,
	type AskToolInput,
	type DockSelection,
	type ExplainToolInput,
	type QuestionAnswerData,
	type QuestionData,
	type QuestionMode,
	type QuizToolInput,
	type SelectMode,
	type SketchPayload,
	type Phase3,
} from "@/src/core";
import { CONFIDENCE_COLORS, confidenceRailStyle } from "@/components/confidence-rail";

/**
 * The question dock — a pending quiz/ask REPLACES the chat composer: the
 * persistent bottom blob morphs into the question. Two voices meet here:
 * the teacher's (question, options, explanation) and the learner's —
 * "Your thinking", a labeled composer-twin field for dumping reasoning,
 * with Submit docked inside it exactly like the chat composer's send.
 *
 * The thinking field is the transfer channel of the whole product (wave-2):
 * never called "optional", Enter makes a NEWLINE (it is for dumping — soon
 * dictated, not typed), submission is the button only, and its size scales
 * with the phase (probing stays quick; teaching invites depth). The
 * "Other…" option is an editable option ROW — circle + inline input,
 * styled like its siblings — so picking Other never displaces thinking.
 *
 * Collapse behavior (scroll-up → slim bar) is owned by the DockOverlay in the
 * chat view, which also owns the persistent shell and its height morph. This
 * component is content only. The expanded form stays MOUNTED while collapsed
 * (hidden, not unmounted) so a half-made selection survives scrolling.
 */

export interface QuestionDockProps {
	toolName: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
	toolCallId: string;
	input: QuizToolInput | AskToolInput | ExplainToolInput;
	/** Collapse state, owned by the DockOverlay (it drives the shell's height morph). */
	expanded: boolean;
	/**
	 * Teach-phase check awaiting its reveal (vision §2, W5): while collapsed,
	 * the bar is the "Check your understanding" invitation instead of the
	 * scroll-collapse strip. Owned by the DockOverlay; false once the learner
	 * has revealed (afterwards the normal collapse machine rules apply).
	 */
	reveal?: boolean;
	onExpand: () => void;
	/** A sketch submit (Android plan M1, text mode) passes the handwriting;
	 *  the answer then carries its ref. */
	onSubmit: (output: QuestionAnswerData, sketch?: SketchPayload) => Promise<boolean> | void;
	/** The session's model reads images — text mode then offers "Open in
	 *  sketch" (a text-only model would silently drop the pages). */
	sketchAvailable?: boolean;
	/** Escape in a question field stops dictation (STT wave) — threaded
	 *  from the page that owns the dictation hook. */
	onEscape?: () => void;
	/** The keyboard machine (wave B) is armed only while the dock is
	 *  expanded — the collapsed bar keeps its native Enter-to-expand. */
	active?: boolean;
	/** Session phase at the question — scales the thinking field: probing
	 *  stays quick (one row), teaching invites dumping (three rows). */
	phase?: Phase3;
	/** Dictation claim (owner 2026-10-03): false while a teach-phase check
	 *  sits UNREVEALED — the reading-thinking field owns dictated speech
	 *  during the reading; the dock reclaims on reveal. Default true (probe
	 *  questions, predictions, old callers). */
	dictationClaim?: boolean;
	/** Compaction is running for this chat (owner round 14): the answer
	 *  POST would block on the server's compaction gate — disable submit
	 *  and say so in the hint row. The server registry is the real gate;
	 *  this is the affordance. */
	compactionRunning?: boolean;
}

export function QuestionDock({
	toolName,
	toolCallId,
	input,
	expanded,
	reveal = false,
	onExpand,
	onSubmit,
	onEscape,
	phase = "probe",
	dictationClaim = true,
	compactionRunning = false,
	sketchAvailable = false,
}: QuestionDockProps) {
	// The probe-phase names (owner, 2026-10-09) canonicalize onto their
	// teach twins for every dock concern — parse dispatch, labels, kinds:
	// the probe quiz ("probe") is quiz-shaped, the probe free-recall
	// ("recall") is explain-shaped. Old records keep the teach names.
	const canonical =
		toolName === "probe" ? "quiz" : toolName === "recall" ? "explain" : toolName;
	// The chip's display name carries the tool's OWN name (owner
	// 2026-10-09): probe-phase questions label Probe/Recall in the
	// composer; teach tools keep the standing labels.
	const toolLabel = toolName === "probe" ? "Probe" : toolName === "recall" ? "Recall" : undefined;
	// Parse, don't cast (src/core/tool-parts.ts): the model authored this
	// input, and only the schema the tool declared vouches for its shape.
	// The dock mounts on input-available parts (already validated at the
	// bridge), so this is pure defense in depth — but it is STRUCTURAL now:
	// anything that slips through renders the quiet fallback, never a
	// crash on `.map` over model-authored bytes.
	const parsed =
		canonical === "quiz" ? parseQuizInput(input) : canonical === "explain" ? parseExplainInput(input) : parseAskInput(input);
	if (!parsed) {
		return (
			<div data-testid="malformed-question" className="rounded-xl border border-dashed bg-card/60 p-3 text-sm text-muted-foreground">
				This question arrived malformed — the transcript keeps the retry.
			</div>
		);
	}
	return (
		<>
			{!expanded && (
				<QuestionDockBar
					toolName={canonical}
					question={parsed.question}
					onExpand={onExpand}
					variant={reveal ? "reveal" : "collapsed"}
					toolLabel={toolLabel}
					label={
						(canonical === "quiz" || canonical === "explain") &&
						normalizeQuizType((parsed as { type?: unknown }).type) === "predict"
							? "Prediction"
							: undefined
					}
				/>
			)}
			<div className={expanded ? "dock-variant" : "invisible h-0 overflow-hidden"}>
				<QuestionDockForm
					toolName={toolName}
					toolCallId={toolCallId}
					input={parsed}
					phase={phase}
					active={expanded}
					onSubmit={onSubmit}
					onEscape={onEscape}
					dictationClaim={dictationClaim}
					compactionRunning={compactionRunning}
					sketchAvailable={sketchAvailable}
				/>
			</div>
		</>
	);
}

/** A plain-text teaser of a question for the collapsed bar: unwrap math, flatten common LaTeX. */
function teaserText(q: string): string {
	return q
		.replace(/\\\(([\s\S]*?)\\\)/g, "$1") // \(...\) inline math
		.replace(/\\\[([\s\S]*?)\\\]/g, "$1") // \[...\] display math
		.replace(/\$\$?([^$]*)\$\$?/g, "$1") // standard $...$/$$...$$ math
		.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
		.replace(/\\([a-zA-Z]+)/g, "$1")
		.replace(/[{}]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The collapsed strip. Two species (W5): "collapsed" is the scroll minimization
 *  (kind chip + one-liner + Answer ↓); "reveal" is the teach-check invitation —
 *  a distinct, more inviting affordance, because it asks the learner to start
 *  something, not to resume something. */
export function QuestionDockBar({
	toolName,
	question,
	onExpand,
	variant = "collapsed",
	label,
	toolLabel,
}: {
	toolName: "quiz" | "ask_user_question" | "explain";
	question: string;
	onExpand: () => void;
	variant?: "collapsed" | "reveal";
	/** The kind chip's text (owner 2026-10-03): "Prediction" when a
	 *  predict-type quiz minimizes by scroll — predictions never use the
	 *  reveal variant, but the scroll-collapse strip can still hide them. */
	label?: string;
	/** The chip's TOOL display name (owner 2026-10-09): probe-phase calls
	 *  label Probe/Recall — the phase boundary visible in the composer. */
	toolLabel?: string;
}) {
	if (variant === "reveal") {
		return (
			<button
				type="button"
				data-testid="teach-check-reveal"
				onClick={onExpand}
				className="dock-variant flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
					<PlayIcon className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium">Check your understanding</span>
					<span className="block truncate text-xs text-muted-foreground">{teaserText(question)}</span>
				</span>
				<span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
					Open <ChevronRightIcon className="size-3.5" />
				</span>
			</button>
		);
	}
	return (
		<button
			type="button"
			data-testid="question-dock-bar"
			onClick={onExpand}
			className="dock-variant flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent/40"
		>
			<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label ??
							toolLabel ??
							(toolName === "quiz" ? "Check" : toolName === "explain" ? "Explain" : "Question")}
			</span>
			<span className="min-w-0 flex-1 truncate text-muted-foreground">{teaserText(question)}</span>
			<span className="flex shrink-0 items-center gap-1 text-xs font-medium">
				Answer <ArrowDownIcon className="size-3.5" />
			</span>
		</button>
	);
}

/** The expanded question: label, question, options, and the unified bottom row. */
function QuestionDockForm({
	toolName,
	toolCallId,
	input,
	phase = "probe",
	active,
	onSubmit,
	onEscape,
	dictationClaim = true,
	compactionRunning = false,
	sketchAvailable = false,
}: Omit<QuestionDockProps, "expanded" | "onExpand" | "reveal">) {
	const kind = toolQuestionKind(toolName);

	// Canonical QuestionData, built once per question. Quiz options are
	// deterministically shuffled (seeded by toolCallId) so position never leaks
	// correctness AND server/client render the same order (hydration-safe);
	// the display order is snapshotted into the answer record at submit time.
	const qd = useMemo<QuestionData>(() => {
		const quizInput = kind === "quiz" ? (input as QuizToolInput) : null;
		const askInput = kind === "ask" ? (input as AskToolInput) : null;
		const explainInput = kind === "explain" ? (input as ExplainToolInput) : null;
		const multi = input instanceof Object && "multiSelect" in input ? input.multiSelect === true : false;
		const mode: QuestionMode =
			kind === "quiz"
				? multi
					? "multi-select"
					: "single-select"
				: askInput?.options?.length
					? multi
						? "multi-select"
						: "single-select"
						: "text";
		const options = normalizeOptions(
			(quizInput?.options ?? askInput?.options ?? []) as { label: string; value?: string }[],
		);
		const ordered = kind === "quiz" && options.length > 0 ? shuffleOptions(options, seededRandom(toolCallId)) : options;
		const q: QuestionData = {
			id: toolCallId,
			kind,
			// The role (owner 2026-10-03): predict questions gate by it in the
			// view (never collapsed) and the answered card tucks the explanation.
			questionType: kind === "quiz" ? normalizeQuizType((input as { type?: unknown }).type) : undefined,
			question: input.question,
			context: input.details,
			mode,
			options: ordered,
			createdAt: new Date().toISOString(),
		};
		if (quizInput) {
			const resolved = resolveCorrect(quizInput.correctAnswer, ordered);
			if (resolved.error) console.error("[quiz] correctAnswer did not resolve:", resolved.error);
			q.correctIndices = resolved.indices;
			q.explanation = quizInput.explanation;
		}
		if (explainInput) {
			// The commitment rides the question data (never sent to the
			// client before answering) and snapshots into the answer at submit.
			// One field, reasoning included — no separate explanation
			// (owner ruling 2026-09-27).
			q.committedAnswer = explainInput.correctAnswer;
		}
		return q;
	}, [toolCallId, kind, input]);

	// The selection state machine lives in question-core (pure, tested):
	// single-select displaces, multi-select coexists — picking the ask
	// "Other…" row in a multi-select must never clear already-picked
	// options, and picking an option must never clear a typed custom answer.
	const [sel, setSel] = useState<DockSelection>(emptyDockSelection());
	// The learner's transfer channel — thinking, never "a note".
	const [thinking, setThinking] = useState("");
	const [other, setOther] = useState("");
	const [text, setText] = useState("");
	/* Refs MIRROR the two dictation-target fields ("nothing gets lost"
	 * round, owner 2026-10-01): the run's flush lands via setState, which
	 * a closure waiting through `await finishDictation()` cannot observe
	 * in time — submit reads these, kept current at every write site. */
	const thinkingTextRef = useRef("");
	const answerTextRef = useRef("");
	// Confidence (owner, 2026-10-01): an index into CONFIDENCE_STOPS, or
	// null while unset — NO default (owner, 2026-10-25): a picked quiz
	// answer cannot be sent until the learner chooses a stop. The dock
	// unmounts between questions, so each question starts unset.
	const [confIdx, setConfIdx] = useState<number | null>(null);
	const [sketching, setSketching] = useState(false);
	// A switch to a text-only model closes an open sketch (its ink stays).
	useEffect(() => {
		if (!sketchAvailable) setSketching(false);
	}, [sketchAvailable]);
	const selectMode: SelectMode = qd.mode === "multi-select" ? "multi-select" : "single-select";

	// The PRIMARY dictation input (owner, STT round 1): while a question
	// waits, dictated finals land HERE, never in the hidden composer — text
	// mode owns "Your answer", select modes own "Your thinking". The claim
	// is effect-scoped, so the question unmounting releases it and
	// dictation falls back to the composer automatically.
	useDictationTarget(
		useCallback(
			(t: string, withdraw?: boolean) => {
				// Ref-first (see the refs block above): the join is computed from
				// the mirror, then both mirrors agree with state — a submit
				// resuming post-finish reads the tail, never a stale closure.
				if (qd.mode === "text") {
					const v = joinDictation(answerTextRef.current, t, withdraw);
					answerTextRef.current = v;
					setText(v);
				} else {
					const v = joinDictation(thinkingTextRef.current, t, withdraw);
					thinkingTextRef.current = v;
					setThinking(v);
				}
			},
			[qd.mode],
		),
		// Released while a teach check sits unrevealed (owner 2026-10-03):
		// the reading-thinking field owns dictated speech during the reading.
		dictationClaim,
	);

	const toggle = (idx: number) => setSel(toggleOption(selectMode, sel, idx));

	const { canSubmit, needsConfidence } = dockSubmitGate({
		kind,
		mode: qd.mode,
		sel,
		other,
		text,
		confidenceSet: confIdx !== null,
	});

	const submit = () => {
		if (!canSubmit || compactionRunning) return;
		/* FINISH DICTATION FIRST (owner, 2026-10-01): Enter may arrive while
		 * a run is live with reasoning still in Deepgram's hands. Stop the
		 * run, let the last finals land in the target field, and only then
		 * build the answer — the spoken reasoning is never lost to a
		 * forgotten stop. The field values below come from the REF mirrors
		 * because the flush lands via setState after an await. */
		if (!isDictationActive()) {
			doSubmit();
			return;
		}
		void finishDictation().then(doSubmit);
	};
	const doSubmit = () => {
		if (!canSubmit) return;
		const req: AnswerRequest = {
			dontKnow: sel.dontKnow,
			values: [...sel.selected].map((i) => qd.options[i]!.value),
			other: sel.otherSelected ? other : undefined,
			text: qd.mode === "text" ? answerTextRef.current : undefined,
			thinking: qd.mode !== "text" ? thinkingTextRef.current.trim() || undefined : undefined,
			// Always chosen on a picked quiz answer (canSubmit waits for it);
			// buildAnswer drops it on "I don't know".
			confidence: kind === "quiz" && confIdx !== null ? CONFIDENCE_STOPS[confIdx] : undefined,
		};
		onSubmit(buildAnswer(qd, req, toolName));
	};
	/* The sketch submit (Android plan M1, text mode only): the sketch
	 * answers on its own or with the typed/dictated text; dictation's tail
	 * lands first, exactly as for the Submit button. */
	const submitSketch = async (sketch: SketchPayload): Promise<boolean> => {
		if (compactionRunning || qd.mode !== "text") return false;
		setSketching(false);
		if (isDictationActive()) await finishDictation();
		// The dock's own gate: text mode answers on a sketch alone.
		if (!dockSubmitGate({ kind, mode: qd.mode, sel, other, text: answerTextRef.current, confidenceSet: confIdx !== null, hasSketch: true }).canSubmit) return false;
		const req: AnswerRequest = {
			dontKnow: false,
			values: [],
			text: answerTextRef.current,
			sketch: sketchRefOf(sketch),
		};
		return (await onSubmit(buildAnswer(qd, req, toolName), sketch)) ?? true;
	};

	/* ENTER SUBMITS FROM ANYWHERE (owner round 6, 2026-10-05): the same
	 * law as the practice dock — dictated answers rarely focus the field.
	 * Rides submit() so the dictation-flush law is shared, not forked. */
	useEnterSubmits(submit);

	// Selecting Other never clears the thinking field — two channels, the
	// answer and the reasoning behind it, side by side.
	const selectOther = () => setSel(toggleOther(selectMode, sel));

	/* ── The keyboard machine (shortcut wave B, owner rounds 2026-09-17) ──
	   ↑/↓ walk EVERY answerable row in order — options first, then the
	   quiz's "I don't know" or the ask's "Other…" (whichever exists) —
	   CLAMPED at the ends, no wrap (owner: faster to navigate when the
	   walk stops at the last row). Space acts on the walked row exactly
	   like a click (multi toggles, single displaces; Other also focuses
	   its input for typing), Enter submits once an answer exists.
	   Tab toggles FOCUS between the thinking field and the answer rows
	   (owner round 3) — nothing else; Shift+Tab is NOT ours (the global
	   thinking-level cycle owns it). Two guards keep native behavior
	   intact: keys from a TYPING SURFACE keep their meaning (arrows move
	   the caret, space types), and modifier combos are never ours
	   (Alt+arrows cycle sessions — they must not ALSO walk the rows).
	   The listener is document-level and lives only while the dock is
	   expanded — collapsed, the bar's native Enter expands it. */
	const [kbdIdx, setKbdIdx] = useState<number | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const otherInputRef = useRef<HTMLInputElement>(null);
	const thinkingRef = useRef<HTMLTextAreaElement>(null);
	// One row past the options is the trailing row: quiz → don't-know,
	// ask → Other (a question never has both). Text mode (ask/explain)
	// has no rows — the composer IS the answer surface.
	const optionCount = qd.mode === "text" ? 0 : qd.options.length;
	const rowCount = qd.mode === "text" ? 0 : optionCount + 1;

	const kbdAct = (idx: number) => {
		if (idx < optionCount) toggle(idx);
		else if (kind === "quiz")
			setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }));
		else {
			// Space on the ask's Other row (owner refinement round,
			// 2026-09-24): SELECTING it focuses the input for typing, but
			// the Space that DESELECTS an already-selected Other must never
			// drop the user back into the typing field — the core's
			// toggleOther has no single-select off-path (it displaces), so
			// the off-path lives here: clear the pick, keep the typed text,
			// focus stays where it is. Re-selecting is the way back into
			// the field.
			if (sel.otherSelected) setSel((prev) => ({ ...prev, otherSelected: false, dontKnow: false }));
			else {
				otherInputRef.current?.focus();
				selectOther();
			}
		}
	};

	// Focus the walked row's focusable element — the Other row is a div,
	// so its inline input is the focus target there.
	const focusRow = (idx: number) => {
		const row = rootRef.current?.querySelector(`[data-kbdrow="${idx}"]`) as HTMLElement | null;
		if (!row) return;
		const el = (row.querySelector("input") as HTMLElement | null) ?? row;
		el.focus();
	};

	useEffect(() => {
		if (!active || rowCount === 0) return;
		const onKeyDown = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			// A TYPING field is where keys mean text (owner round 4): the
			// thinking/answer fields, search boxes, renames — never a range
			// input, whose focus after a click or drag must not kill the
			// arrow cycling. Everywhere else the arrows act.
			const typing =
				!!t &&
				((t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable);
			// Alt/Cmd/Ctrl combos are never ours (Alt+arrows cycle sessions
			// globally — they must not ALSO walk the question rows).
			const modded = e.altKey || e.metaKey || e.ctrlKey;
			// Plain Tab toggles focus: rows → thinking. The confidence
			// slider takes NO focus at all (owner, UI round 2026-10-01) —
			// global ←/→ own its keyboard, so it never joins the chain.
			// Shift+Tab falls through (the global thinking-level cycle owns
			// it), so the shift check matters.
			if (e.key === "Tab" && !e.shiftKey && !modded) {
				e.preventDefault();
				e.stopPropagation();
				if (t?.closest?.("[data-kbdrow]")) thinkingRef.current?.focus();
				else {
					const idx = kbdIdx ?? 0;
					setKbdIdx(idx);
					focusRow(idx);
				}
				return;
			}
			// Keys from a typing surface keep their meaning (arrows move
			// the caret, space types).
			if (typing || modded) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				const next = Math.min((kbdIdx ?? -1) + 1, rowCount - 1);
				setKbdIdx(next);
				// Focus follows the walk while the user is IN the rows (Tab
				// put them there) so focused and walked never diverge.
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				const next = Math.max((kbdIdx ?? rowCount) - 1, 0);
				setKbdIdx(next);
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				// Global confidence cycling (owner, UI round 2026-10-01): the
				// SAME pattern as ↑/↓ over the rows — works wherever focus
				// sits, no click-in, no focus ring. Dead on "I don't know"
				// (the slider grays out and nothing is sent).
				if (kind !== "quiz" || sel.dontKnow) return;
				e.preventDefault();
				// From unset, either arrow lands on 50 (the middle stop).
				setConfIdx((i) =>
					i === null
						? CONFIDENCE_STOPS.indexOf(50)
						: Math.min(CONFIDENCE_STOPS.length - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1))),
				);
			} else if (e.key === " ") {
				if (kbdIdx === null) return; // plain Space keeps scrolling the page
				e.preventDefault();
				kbdAct(kbdIdx);
			} else if (e.key === "Enter") {
				if (kbdIdx === null || !canSubmit) return;
				e.preventDefault();
				submit();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	});

	// Keep the walked row visible (the question area scrolls internally).
	useEffect(() => {
		if (kbdIdx === null) return;
		rootRef.current
			?.querySelector(`[data-kbdrow="${kbdIdx}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [kbdIdx]);

	return (
		// one figure scope for the whole question: an option's plot may
		// reference the stem's diagram (figures, 2026-10-26)
		<FigureScope texts={[qd.question, qd.context, ...qd.options.flatMap((o) => [o.label, o.description])]}>
		<div ref={rootRef} data-testid="question-dock">
			{/* Question area — scrolls internally if very tall; the bottom row stays put.
			    Capped by the measured column (--dock-max-h; the old fixed 55dvh cut
			    long questions short — owner round, 2026-10-05). */}
			<div data-session-find-root="" className="max-h-[var(--dock-max-h,55dvh)] overflow-y-auto px-4 pt-3">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{toolName === "probe"
						? "Probe"
						: toolName === "recall"
							? "Recall"
							: kind === "quiz"
								? qd.questionType === "predict"
									? "Prediction"
									: "Check"
									: kind === "explain"
										? "Explain"
											: "Question"}
					{qd.mode === "multi-select" && " · select all that apply"}
				</div>
				<div className="mb-3 font-medium">
					<MessageResponse>{qd.question}</MessageResponse>
				</div>
				{qd.context && (
					<div className="mb-3 text-sm text-muted-foreground">
						<MessageResponse>{qd.context}</MessageResponse>
					</div>
				)}

				{qd.mode !== "text" && (
					<div className="flex flex-col gap-2 pb-2" role={qd.mode === "multi-select" ? "group" : "radiogroup"}>
						{qd.options.map((opt, i) => {
							const isSel = sel.selected.has(i);
							return (
								<button
									key={opt.value}
									type="button"
									role={qd.mode === "multi-select" ? "checkbox" : "radio"}
									aria-checked={isSel}
									data-kbdrow={i}
									onClick={() => toggle(i)}
									className={cn(
										"flex items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors",
										isSel ? "border-primary bg-accent" : "hover:bg-accent/50",
										i === kbdIdx && !isSel && "ring-1 ring-border bg-accent/40",
									)}
								>
									<span
										className={cn(
											"mt-0.5 flex size-4 shrink-0 items-center justify-center border",
											qd.mode === "multi-select" ? "rounded-sm" : "rounded-full",
											isSel ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
										)}
									>
										{isSel && (
											<span className={cn(qd.mode === "multi-select" ? "text-base leading-none" : "size-1.5 rounded-full bg-current")}>
												{qd.mode === "multi-select" ? "✓" : ""}
											</span>
										)}
									</span>
									<span>
										<MessageResponse>{opt.label}</MessageResponse>
										{kind !== "quiz" && opt.description && (
											// Option subtext renders in Source Sans 3 (owner's mockup);
											// the "I don't know" copy stays JetBrains Mono. QUIZ options render
											// NO description (owner ruling 2026-09-26): the model used them to
											// telegraph correctness — the schema dropped the field and old
											// records must not leak either. Same MessageResponse path as the
											// label (owner, 2026-10-12): descriptions are full markdown —
											// LaTeX included — not plain text.
											<MessageResponse className="lh-prose block text-xs text-muted-foreground">
												{opt.description}
											</MessageResponse>
										)}
									</span>
								</button>
							);
						})}

						{kind === "quiz" && (
							<button
								type="button"
								onClick={() =>
									setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }))
								}
								data-kbdrow={optionCount}
								aria-pressed={sel.dontKnow}
								className={cn(
									// Option-row layout + radio circle (owner); the dashed
									// outline stays — this is the deliberate non-answer.
									"flex items-start gap-3 rounded-lg border border-dashed px-3 py-2 text-left text-sm outline-none transition-colors",
									sel.dontKnow ? "border-primary text-foreground" : "text-muted-foreground",
									kbdIdx === optionCount && !sel.dontKnow && "ring-1 ring-border bg-accent/40",
								)}
							>
								<span
									className={cn(
										"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
										sel.dontKnow
											? "border-primary bg-primary text-primary-foreground"
											: "border-muted-foreground/40",
									)}
								>
									{sel.dontKnow && <span className="size-1.5 rounded-full bg-current" />}
								</span>
								<span>I don't know</span>
							</button>
						)}

						{kind === "ask" && (
							<div
								role={qd.mode === "multi-select" ? "checkbox" : "radio"}
								aria-checked={sel.otherSelected}
								data-testid="other-option"
								data-kbdrow={optionCount}
								onClick={selectOther}
								className={cn(
									"flex items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors",
									sel.otherSelected ? "border-primary bg-accent" : "border-dashed hover:bg-accent/50",
									kbdIdx === optionCount && !sel.otherSelected && "ring-1 ring-border bg-accent/40",
								)}
							>
								<span
									className={cn(
										"mt-0.5 flex size-4 shrink-0 items-center justify-center border",
										qd.mode === "multi-select" ? "rounded-sm" : "rounded-full",
										sel.otherSelected
											? "border-primary bg-primary text-primary-foreground"
											: "border-muted-foreground/40",
									)}
								>
									{sel.otherSelected && (
										<span className={cn(qd.mode === "multi-select" ? "text-base leading-none" : "size-1.5 rounded-full bg-current")}>
											{qd.mode === "multi-select" ? "✓" : ""}
										</span>
									)}
								</span>
								<input
									ref={otherInputRef}
									value={other}
									onChange={(e) => {
										setOther(e.target.value);
										// Typing selects the row — displacing in
										// single-select, alongside the siblings in multi.
										setSel((prev) => (prev.otherSelected ? prev : toggleOther(selectMode, prev)));
									}}
									onKeyDown={(e) => {
										// Esc escapes the typing (owner refinement round,
										// 2026-09-24): focus leaves the input, the row STAYS
										// selected — deselection is the next Space's job, acting
										// on the row — and the arrow walk resumes from this
										// row (kbdIdx pins it). stopPropagation keeps the
										// window chain from reading this Esc as abort-turn.
										if (e.key === "Escape") {
											e.preventDefault();
											e.stopPropagation();
											e.currentTarget.blur();
											setKbdIdx(optionCount);
										}
											// Enter submits directly (owner, keyboard round 2026-10-06):
											// the custom answer is a single-line input — no newline
											// to protect, and typing has already selected the row, so
											// the payload is ready. Every Enter (shift or not — nothing
											// else could ever happen in a one-line field) rides the
											// same submit seam as the button, dictation finish-first
											// included.
											if (e.key === "Enter") {
												e.preventDefault();
												submit();
											}
									}}
									placeholder="Type your own answer…"
									className="lh-input w-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
									onClick={(e) => e.stopPropagation()}
								/>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Confidence (owner, 2026-10-01; UI rounds same day): a snapped
				slider below the options and above "Your thinking" — the
				learner's stated probability that his selected answer is
				correct. The thumb's POSITION is the raw fraction; the painted
				RAIL overlays exactly the thumb-center range (inset half a disc
				per side), so 0 and 100 rest flush against the rail's very
				ends. Fill + handle wear the stop's ramp color; SOLID stop
				ticks are background layers behind the fill (empty side only,
				never over the color; 0/100 need no tick — the flush ends say
				them). Keyboard: GLOBAL ←/→ (the ↑/↓ pattern; the ring is gone
				app-wide). Clicking and dragging are native. "I don't know"
				GRAYS it out — the layout holds, no value is sent, the IDK
				signal stands alone. */}
			{kind === "quiz" && (
				<div className="border-t border-border/60 px-4 py-2.5">
					<div className="flex items-center gap-3">
						<span
							className={cn(
								"shrink-0 text-xs font-medium uppercase tracking-wide",
								sel.dontKnow ? "text-muted-foreground/50" : "text-muted-foreground",
							)}
						>
							Confidence
							{confIdx === null && !sel.dontKnow && (
								<span
									data-testid="confidence-unset-hint"
									className="ml-1.5 font-normal normal-case tracking-normal text-muted-foreground/70"
								>
									set before submitting
								</span>
							)}
						</span>
						<div
							className={cn("relative h-4 min-w-0 flex-1", sel.dontKnow && "opacity-40")}
							data-testid="confidence-track"
						>
							{/* The RAIL is painted here, not on the input: this overlay spans
								exactly the thumb-CENTER range (inset 8px = half the 16px disc,
								left and right), so at 0 and 100 the disc sits flush against the
								rail's very ends — no bare stub poking past it (owner round 4).
								STACKING LAW (owner round 5): the input is absolute too — a
								positioned overlay paints above an in-flow input no matter the
								DOM order, which put the rail OVER the disc. Both positioned,
								input later in DOM → the disc rides on top. The wrapper's height
								is pinned (h-4) so the rail's top-1/2 and the disc's track share
								one box — centered by construction, not by hope. */}
							<div
								aria-hidden
								data-testid="confidence-rail"
								className="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border"
								// Unset paints an empty rail (a 0-width fill).
								style={confidenceRailStyle(confIdx === null ? 0 : CONFIDENCE_STOPS[confIdx]!)}
							/>
							<input
								type="range"
								min={0}
								max={100}
								step={1}
								// Unset: the native input still needs a value — it rests,
								// invisible, at 50.
								value={confIdx === null ? 50 : CONFIDENCE_STOPS[confIdx]}
								disabled={sel.dontKnow}
								aria-label="Confidence — the probability your selected answer is correct"
								aria-valuetext={confIdx === null ? "not set" : `${CONFIDENCE_STOPS[confIdx]} percent`}
								title="The probability your selected answer is correct — 50% is a coin flip. Adjust with ←/→."
								data-testid="confidence-slider"
								onChange={(e) => setConfIdx(nearestConfidenceStop(Number(e.target.value)))}
								// A click on the hidden resting value changes nothing, so
								// onChange never fires: the release sets it too.
								onPointerUp={(e) => setConfIdx(nearestConfidenceStop(Number(e.currentTarget.value)))}
								style={{ color: confIdx === null ? undefined : CONFIDENCE_COLORS[confIdx] }}
								className={cn(
									"absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none",
									"[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
									"[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current",
									"[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent",
									"[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current",
									confIdx === null &&
										"[&::-webkit-slider-thumb]:opacity-0 [&::-moz-range-thumb]:opacity-0",
								)}
							/>
						</div>
						<span
							data-testid="confidence-value"
							className={cn(
								"w-9 shrink-0 text-right font-mono text-sm tabular-nums",
								sel.dontKnow && "text-muted-foreground/50",
							)}
						>
							{sel.dontKnow || confIdx === null ? "—" : `${CONFIDENCE_STOPS[confIdx]}%`}
						</span>
					</div>
				</div>
			)}

			{/* The learner's half of the dock — a composer TWIN: a labeled, bordered
			    field with Submit docked inside, exactly like the chat composer's
			    send. Select modes get "Your thinking" (Enter makes a newline — it
			    is for dumping, soon dictated; the button submits); text mode
			    keeps "Your answer" with Enter-to-submit. */}
			<form
				className="border-t border-border/60 p-1.5"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div
					data-testid={qd.mode === "text" ? "answer-field" : "thinking-field"}
					className="rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
				>
					<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						{qd.mode === "text" ? "Your answer" : "YOUR THINKING"}
					</div>
					{qd.mode === "text" ? (
						<textarea
							value={text}
							onChange={(e) => {
								answerTextRef.current = e.target.value;
								setText(e.target.value);
							}}
							onKeyDown={(e) => {
								// Esc ends dictation (the dictate decisions: click-again
								// or Esc) — stopPropagation claims it (keyboard wave
								// A) so the window chain doesn't also abort a turn.
								if (e.key === "Escape" && onEscape) {
									e.preventDefault();
									e.stopPropagation();
									onEscape();
									return;
								}
								// Chat convention: Enter submits, Shift+Enter is a newline;
								// ⌘/Ctrl+Enter also submits (universal across the app).
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Type your answer…"
							rows={1}
							className="field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
						/>
					) : (
						<textarea
							ref={thinkingRef}
							value={thinking}
							onChange={(e) => {
								thinkingTextRef.current = e.target.value;
								setThinking(e.target.value);
							}}
							onKeyDown={(e) => {
								// Esc ends dictation (the dictate decisions: click-again
								// or Esc) — stopPropagation claims it (keyboard wave
								// A) so the window chain doesn't also abort a turn.
								if (e.key === "Escape" && onEscape) {
									e.preventDefault();
									e.stopPropagation();
									onEscape();
									return;
								}
								// THE STANDARD CHORD (owner round 5, 2026-10-05): Enter
								// submits, Shift+Enter is a newline, ⌘/Ctrl+Enter works
								// too — identical to the practice dock and the composer.
								if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Why this answer? Whatever comes to mind."
							rows={1}
							className={cn(
								"field-sizing-content lh-input max-h-48 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70",
								// Phase-scaled prominence: teaching invites depth,
								// probing stays quick.
								phase === "teach" ? "min-h-[4.5rem]" : "min-h-10",
							)}
						/>
					)}
					<div className="flex items-center justify-between gap-2 p-1">
						<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
								{compactionRunning ? "compacting session…" : "↵ submits · ⇧↵ newline"}
						</span>
						{qd.mode === "text" && sketchAvailable && (
							<Button
								type="button"
								variant="ghost"
								data-testid="question-open-sketch"
								onClick={() => setSketching(true)}
								className="ml-auto h-9 gap-1.5 rounded-[6px] px-3 text-sm"
							>
								<PenLineIcon className="size-4" />
								Open in sketch
							</Button>
						)}
						<Button
							type="submit"
							disabled={!canSubmit || compactionRunning}
							title={needsConfidence ? "Set your confidence first" : undefined}
							className={cn("h-9 rounded-[6px] px-3.5 text-sm font-medium", !(qd.mode === "text" && sketchAvailable) && "ml-auto")}
						>
							Submit answer
						</Button>
					</div>
				</div>
			</form>
			{sketching && sketchAvailable && (
				<SketchView
					label="Question"
					statement={qd.context ? `${qd.question}\n\n${qd.context}` : qd.question}
					inkKey={toolCallId}
					onSubmit={submitSketch}
					onClose={() => setSketching(false)}
					onCancelDictation={onEscape}
					disabled={compactionRunning}
				/>
			)}
		</div>
		</FigureScope>
	);
}
