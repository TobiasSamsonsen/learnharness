"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, CameraIcon, ChevronRightIcon, PenLineIcon, PlayIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhotoError, preparePhoto, releasePhoto, type PreparedPhoto } from "@/components/photo-answer";
import { useCamera } from "@/components/use-camera";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { enterSends, useEnterSubmits } from "@/components/enter-submits";
import { PathInput } from "@/components/path-input";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { FigureScope } from "@/components/figures/figure-scope";
import { SketchChoices } from "@/components/sketch/sketch-choices";
import { SketchView } from "@/components/sketch/sketch-view";
import { cn } from "@/lib/utils";
import {
	buildAnswer,
	repairMathForDisplay,
	normalizeQuizType,
	CONFIDENCE_LEVELS,
	CONFIDENCE_STOPS,
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
	type QuestionFormDraft,
	type QuestionData,
	type QuestionMode,
	type QuizToolInput,
	type SelectMode,
	type SketchPayload,
	type Phase3,
} from "@/src/core";
import { ConfidenceButtons } from "@/components/confidence-buttons";

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
	/** Restore only this call's unconfirmed submission after recovery. */
	initialDraft?: QuestionFormDraft;
	onSaveDraft?: (draft: QuestionFormDraft) => void;
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
	initialDraft,
	onSaveDraft,
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
					initialDraft={initialDraft}
					onSaveDraft={onSaveDraft}
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
	return repairMathForDisplay(q)
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
	initialDraft,
	onSaveDraft,
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
	const [sel, setSel] = useState<DockSelection>(() => initialDraft?.selection ?? emptyDockSelection());
	// The learner's transfer channel — thinking, never "a note".
	const [thinking, setThinking] = useState(initialDraft?.thinking ?? "");
	const [other, setOther] = useState(initialDraft?.other ?? "");
	const [text, setText] = useState(initialDraft?.text ?? "");
	/* Refs MIRROR the two dictation-target fields ("nothing gets lost"
	 * round, owner 2026-10-01): the run's flush lands via setState, which
	 * a closure waiting through `await finishDictation()` cannot observe
	 * in time — submit reads these, kept current at every write site. */
	const thinkingTextRef = useRef(initialDraft?.thinking ?? "");
	const answerTextRef = useRef(initialDraft?.text ?? "");
	// Confidence (owner, 2026-10-01): an index into CONFIDENCE_STOPS, or
	// null while unset — NO default (owner, 2026-10-25): a picked quiz
	// answer cannot be sent until the learner chooses a stop. The dock
	// unmounts between questions, so each question starts unset (a recovered
	// unconfirmed submission restores what was chosen).
	const [confIdx, setConfIdx] = useState<number | null>(initialDraft?.confidenceIndex ?? null);
	const [sketching, setSketching] = useState(false);
	// A photo of the work (M17): the same read-first sketch answer, as one raster page; sent through the sketch path below
	const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
	const [photoError, setPhotoError] = useState<string | null>(null);
	useEffect(() => () => releasePhoto(photo), [photo]);
	const camera = useCamera((files) => {
		const file = files[0];
		if (!file) return;
		setPhotoError(null);
		preparePhoto(file).then(setPhoto, (err: unknown) => setPhotoError(err instanceof PhotoError ? err.message : "The photo could not be used."));
	});
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

	/** A press on a confidence button (or "I don't know") submits THIS render's answer with that press, so the gate and the
	 *  request read the override rather than state that has not landed yet (owner, 2026-10-28: Anki-style buttons). */
	type SubmitOverride = { confIdx?: number; dontKnow?: boolean };
	const selFor = (ov?: SubmitOverride): DockSelection =>
		ov?.dontKnow ? { ...sel, selected: new Set(), otherSelected: false, dontKnow: true } : sel;
	const gateFor = (ov?: SubmitOverride) =>
		dockSubmitGate({
			kind,
			mode: qd.mode,
			sel: selFor(ov),
			other,
			text,
			confidenceSet: ov?.confIdx !== undefined || confIdx !== null,
							hasSketch: photo !== null,
						});
	const { canSubmit } = gateFor();
	// An answer is picked (the confidence buttons wait for this and nothing else).
	const answerPicked = dockSubmitGate({ kind, mode: qd.mode, sel, other, text, confidenceSet: true }).canSubmit;

	const submitWith = (ov?: SubmitOverride) => {
		if (!gateFor(ov).canSubmit || compactionRunning) return;
		/* FINISH DICTATION FIRST (owner, 2026-10-01): Enter may arrive while
		 * a run is live with reasoning still in Deepgram's hands. Stop the
		 * run, let the last finals land in the target field, and only then
		 * build the answer — the spoken reasoning is never lost to a
		 * forgotten stop. The field values below come from the REF mirrors
		 * because the flush lands via setState after an await. */
		if (!isDictationActive()) {
			doSubmit(ov);
			return;
		}
		void finishDictation().then(() => doSubmit(ov));
	};
	const submit = () => submitWith();
	const pressLevel = (stopIndex: number) => {
		setConfIdx(stopIndex);
		submitWith({ confIdx: stopIndex });
	};
	const pressDontKnow = () => submitWith({ dontKnow: true });
	const buildRequest = (ov?: SubmitOverride): AnswerRequest => {
		const dontKnow = ov?.dontKnow ?? sel.dontKnow;
		const conf = ov?.confIdx ?? confIdx;
		return {
			dontKnow,
			values: dontKnow ? [] : [...sel.selected].map((i) => qd.options[i]!.value),
			other: !dontKnow && sel.otherSelected ? other : undefined,
			text: qd.mode === "text" ? answerTextRef.current : undefined,
			thinking: qd.mode !== "text" ? thinkingTextRef.current.trim() || undefined : undefined,
			// Always chosen on a picked quiz answer (canSubmit waits for it);
			// buildAnswer drops it on "I don't know".
			confidence: kind === "quiz" && conf !== null ? CONFIDENCE_STOPS[conf] : undefined,
		};
	};
	const doSubmit = (ov?: SubmitOverride) => {
		if (!gateFor(ov).canSubmit) return;
		if (photo) {
			// a photo answer rides the sketch path (the answer carries its SketchRef); the photo is dropped once it is sent
			void submitSketch(photo.payload, ov?.confIdx).then((sent) => {
				if (sent) setPhoto(null);
			});
			return;
		}
		// Snapshot before optimistic submission unmounts the form. Ref values
		// include the dictation finals that just landed, unlike stale closures.
		onSaveDraft?.({
			selection: { ...selFor(ov), selected: new Set(selFor(ov).selected) },
			thinking: thinkingTextRef.current,
			other,
			text: answerTextRef.current,
			confidenceIndex: ov?.confIdx ?? confIdx,
		});
		onSubmit(buildAnswer(qd, buildRequest(ov), toolName));
	};
	/* The sketch submit (Android plan M1 + M3): in text mode the sketch
	 * answers on its own or with the typed/dictated text; in a choice mode
	 * the picked answer (and confidence) is the answer and the sketch rides
	 * as thinking. Dictation's tail lands first, exactly as for the Submit
	 * button. */
	const submitSketch = async (sketch: SketchPayload, pressedIdx?: number): Promise<boolean> => {
		if (compactionRunning) return false;
		setSketching(false);
		if (isDictationActive()) await finishDictation();
		// The dock's own gate (the view disables Submit with the same one). The sketch page asks for the confidence itself
		// (its Submit expands into the confidence buttons), so a press there counts like one in the dock.
		const ov: SubmitOverride | undefined = pressedIdx === undefined ? undefined : { confIdx: pressedIdx };
		if (!dockSubmitGate({ kind, mode: qd.mode, sel, other, text: answerTextRef.current, confidenceSet: pressedIdx !== undefined || confIdx !== null, hasSketch: true }).canSubmit) return false;
		const req: AnswerRequest = { ...buildRequest(ov), sketch: sketchRefOf(sketch) };
		return (await onSubmit(buildAnswer(qd, req, toolName), sketch)) ?? true;
	};
	// Why the sketch view's Submit waits (a choice question needs its pick; the confidence is asked on the sketch page).
	const sketchGate = dockSubmitGate({ kind, mode: qd.mode, sel, other, text, confidenceSet: true, hasSketch: true });
	const sketchBlocked = sketchGate.canSubmit ? undefined : "Pick an answer first";

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
	const otherInputRef = useRef<HTMLDivElement>(null);
	const thinkingRef = useRef<HTMLDivElement>(null);
	// One row past the options is the trailing row: quiz → don't-know,
	// ask → Other (a question never has both). Text mode (ask/explain)
	// has no rows — the composer IS the answer surface.
	const optionCount = qd.mode === "text" ? 0 : qd.options.length;
	// (the quiz's "I don't know" is a button beside the confidence buttons now, not a row)
	const rowCount = qd.mode === "text" ? 0 : optionCount + (kind === "quiz" ? 0 : 1);

	const kbdAct = (idx: number) => {
		if (idx < optionCount) toggle(idx);
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
		const el = (row.querySelector("input, [data-file-path-input]") as HTMLElement | null) ?? row;
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
				// Global confidence highlight (owner, UI round 2026-10-01; the
				// buttons since 2026-10-28): the SAME pattern as ↑/↓ over the
				// rows — works wherever focus sits. ←/→ move the highlight over
				// the five levels and Enter presses it. Dead on "I don't know".
				if (kind !== "quiz" || sel.dontKnow) return;
				e.preventDefault();
				const first = CONFIDENCE_LEVELS[0]!.index;
				const last = CONFIDENCE_LEVELS[CONFIDENCE_LEVELS.length - 1]!.index;
				// From unset, either arrow lands on 50 (the middle stop).
				setConfIdx((i) =>
					i === null
						? CONFIDENCE_STOPS.indexOf(50)
						: Math.min(last, Math.max(first, i + (e.key === "ArrowRight" ? 1 : -1))),
				);
			} else if (kind === "quiz" && /^[0-5]$/.test(e.key)) {
				// 1-5 press Guess..Certain and submit, 0 presses "I don't know" (owner, 2026-10-28)
				e.preventDefault();
				if (e.key === "0") pressDontKnow();
				else if (answerPicked) pressLevel(CONFIDENCE_LEVELS[Number(e.key) - 1]!.index);
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
			<div data-dock-scroll-area="" data-session-find-root="" className="max-h-[var(--dock-max-h,55dvh)] overflow-y-auto px-4 pt-3">
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
					<ToolContentResponse>{qd.question}</ToolContentResponse>
				</div>
				{qd.context && (
					<div className="mb-3 text-sm text-muted-foreground">
						<ToolContentResponse>{qd.context}</ToolContentResponse>
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
										<ToolContentResponse>{opt.label}</ToolContentResponse>
										{kind !== "quiz" && opt.description && (
											// Option subtext renders in Source Sans 3 (owner's mockup);
											// the "I don't know" copy stays JetBrains Mono. QUIZ options render
											// NO description (owner ruling 2026-09-26): the model used them to
											// telegraph correctness — the schema dropped the field and old
											// records must not leak either. Same MessageResponse path as the
											// label (owner, 2026-10-12): descriptions are full markdown —
											// LaTeX included — not plain text.
											<ToolContentResponse className="lh-prose block text-xs text-muted-foreground">
												{opt.description}
											</ToolContentResponse>
										)}
									</span>
								</button>
							);
						})}

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
								<PathInput
									ref={otherInputRef}
									singleLine
									value={other}
									onValueChange={(value) => {
										setOther(value);
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

			{/* The confidence BUTTONS (owner, 2026-10-28; Anki style, replacing the slider and the Submit button): pick an answer,
			    then press how sure you are — the press submits. "I don't know" is the leading button and needs no pick; the five
			    levels wait for one. Keys: 1-5 press the levels, 0 presses "I don't know", ←/→ move the highlight, Enter presses it. */}
			{kind === "quiz" && (
				<div className="border-t border-border/60 px-4 py-2.5" data-testid="confidence-row">
					<ConfidenceButtons
						onPick={pressLevel}
						disabled={!answerPicked || compactionRunning}
						highlight={confIdx}
						leading={
							<button
								type="button"
								disabled={compactionRunning}
								onClick={pressDontKnow}
								data-testid="dont-know-button"
								className="lh-touch h-9 min-w-0 flex-[1.8] truncate rounded-[6px] border border-dashed border-border/70 bg-transparent px-0 text-[11px] tracking-tighter text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
							>
								I don't know
							</button>
						}
					/>
				</div>
			)}

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
						<PathInput
							value={text}
							onValueChange={(value) => {
								answerTextRef.current = value;
								setText(value);
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
								if (enterSends(e)) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Type your answer…"
							className="field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
						/>
					) : (
						<PathInput
							ref={thinkingRef}
							value={thinking}
							onValueChange={(value) => {
								thinkingTextRef.current = value;
								setThinking(value);
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
								if (enterSends(e)) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Why this answer? Whatever comes to mind."
							className={cn(
								"field-sizing-content lh-input max-h-48 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70",
								// Phase-scaled prominence: teaching invites depth,
								// probing stays quick.
								phase === "teach" ? "min-h-[4.5rem]" : "min-h-10",
							)}
						/>
					)}
					{(photo || photoError) && (
						<div className="px-2.5 pb-1.5">
							{photo && (
								<span data-testid="question-photo-chip" className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 py-0.5 pr-1 pl-1 text-xs text-muted-foreground">
									{/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL of the photo just taken */}
									<img src={photo.previewUrl} alt="" className="size-5 rounded-full object-cover" />
									Photo attached
									<button
										type="button"
										data-testid="question-photo-chip-remove"
										aria-label="Don't attach the photo"
										title="Remove the photo"
										onClick={() => setPhoto(null)}
										className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground"
									>
										<XIcon className="size-3" />
									</button>
								</span>
							)}
							{!photo && photoError && (
								<span role="alert" data-testid="question-photo-error" className="text-xs text-destructive">
									{photoError}
								</span>
							)}
						</div>
					)}
					<div className="flex items-center gap-2 p-1">
						{sketchAvailable && camera.available && (
							<Button
								type="button"
								variant="secondary"
								data-testid="question-add-photo"
								onClick={camera.open}
								className="lh-press h-9 touch:h-12 gap-1.5 rounded-full px-4 text-sm active:rounded-lg"
							>
								<CameraIcon className="size-4" />
								Camera
							</Button>
						)}
						{sketchAvailable && (
							<Button
								type="button"
								variant="secondary"
								data-testid="question-open-sketch"
								onClick={() => setSketching(true)}
								className="lh-press h-9 touch:h-12 gap-1.5 rounded-full px-4 text-sm active:rounded-lg"
							>
								<PenLineIcon className="size-4" />
								Open in sketch
							</Button>
						)}
						<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
							{compactionRunning ? "compacting session…" : <span className="lh-enter-hint [@media(pointer:coarse)]:hidden">↵ submits · ⇧↵ newline</span>}
						</span>
						{kind !== "quiz" && (
							<Button
								type="submit"
								disabled={!canSubmit || compactionRunning}
								className="ml-auto h-9 rounded-[6px] px-3.5 text-sm font-medium"
							>
								Submit answer
							</Button>
						)}
					</div>
				</div>
			</form>
			{camera.node}
			{sketching && sketchAvailable && (
				<SketchView
					label="Question"
					statement={qd.context ? `${qd.question}\n\n${qd.context}` : qd.question}
					inkKey={toolCallId}
					onSubmit={submitSketch}
					onClose={() => setSketching(false)}
					onCancelDictation={onEscape}
					disabled={compactionRunning}
					blocked={qd.mode === "text" ? undefined : sketchBlocked}
					confidenceLevels={kind === "quiz" && qd.mode !== "text" && !sel.dontKnow}
					choices={
						qd.mode === "text" ? undefined : (
							<SketchChoices
								kind={kind as "quiz" | "ask" | "explain"}
								multi={qd.mode === "multi-select"}
								options={qd.options}
								sel={sel}
								onToggle={toggle}
								onDontKnow={() =>
									setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }))
								}
								onOther={selectOther}
								other={other}
								onOtherText={setOther}
							/>
						)
					}
				/>
			)}
		</div>
		</FigureScope>
	);
}
