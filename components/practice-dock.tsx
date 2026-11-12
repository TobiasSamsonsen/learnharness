"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ViewReaderRef } from "./session-view-readers";
import { CameraIcon, ChevronRightIcon, PenLineIcon, XIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { RichLine } from "@/components/rich-text";
import { ClarifyWording } from "@/components/clarify-wording";
import { Button } from "@/components/ui/button";
import { PhotoError, preparePhoto, releasePhoto, type PreparedPhoto } from "@/components/photo-answer";
import { useCamera } from "@/components/use-camera";
import { ConfidenceButtons } from "@/components/confidence-buttons";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { enterSends, useEnterSubmits } from "@/components/enter-submits";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";
import { PathInput } from "@/components/path-input";
import type { PrepareThinkingSubmission } from "./plugin-submission-adapters";
import { pagePayload, sendPage, useInk } from "@/components/sketch/ink-memory";
import { useKeptPage } from "@/components/sketch/kept-page";
import { SketchView } from "@/components/sketch/sketch-view";
import { cn } from "@/lib/utils";
import { CONFIDENCE_STOPS, repairMathForDisplay, SketchPayloadError, type SketchPayload, type SketchRef } from "@/src/core";

/**
 * The practice dock (practice sessions, owner design 2026-10-04): an
 * ACTIVE problem replaces the chat composer — the persistent bottom blob
 * morphs into the problem. The agent's statement above; the learner's
 * half below — "Your thinking", a labeled field with ONE Send button
 * (owner round 2, 2026-10-05): Enter sends, Shift+Enter makes a newline.
 * There are no lanes — whether a submission claims an answer is apparent
 * from the thinking itself; the agent reads it. One problem may carry
 * many submissions; each starts a turn.
 *
 * Collapse (scroll-up → slim bar) is owned by the DockOverlay; this
 * component is content only, and the expanded form stays MOUNTED while
 * collapsed (hidden) so a half-written trace survives scrolling.
 *
 * The commitment (modelSolution, decisionPoints, …) rides the tool call's
 * arguments and is NOT rendered here — only the statement is the
 * learner's. Esc dismisses the problem (the layered-Esc chain; the
 * confirm dialog then the silent route) — claimed by the page, not here.
 */

/** What the confidence buttons add to a submission: how sure the learner is (a CONFIDENCE_STOPS value), or that they pressed
 *  "I don't know" and claim no answer (owner, 2026-10-28). */
export type ThinkingMark = { confidence?: number; dontKnow?: true };

export interface PracticeDockProps {
	viewReader?: ViewReaderRef<string>;
	/** The active problem's tool-call id (submissions target it). */
	problemCallId: string;
	/** The native message the problem sits in: with it the statement is markable for "Ask about this" (owner, 2026-11-06). */
	messageId?: string;
	/** A follow-up card about the statement is open: only the statement shows (the learner's half stays mounted, hidden). */
	wordingOnly?: boolean;
	/** The pose's arguments — only the statement is the learner's (the
	 *  mode badge would edge toward announcing the target; dropped). */
	input: { statement: string };
	/** Collapse state, owned by the DockOverlay. */
	expanded: boolean;
	onExpand: () => void;
	/** text — POST {type:"thinking"} (one lane; the register is read from
	 *  the text). A sketch submit (Android plan M1) adds the handwriting;
	 *  its text may then be empty. `sketchRef` re-sends the problem's kept
	 *  page by id (no new ink). `mark` is the confidence button pressed with it. */
	onSubmit: (text: string, sketch?: SketchPayload, sketchRef?: string, mark?: ThinkingMark) => Promise<boolean> | void;
	/** The host's capture step for a thinking that carries more than text (a plugin adapter's images). It runs inside
	 *  the confidence-first flow: the confidence press (`mark`) rides along, and the field clears once the host accepts. */
	onPrepareSubmission?: PrepareThinkingSubmission;
	/** Host-owned alternative editor (a plugin problem's). The native statement/thinking/controls stay shared; its
	 *  submission goes straight through its own `prepare`, with no confidence step. */
	customInput?: {
		editor: ReactNode;
		thinking: string;
		onThinkingChange(value: string): void;
		ready: boolean;
		prepare: PrepareThinkingSubmission;
	};
	/** Images are waiting to go with the thinking (so an empty text may still be sent). */
	hasPendingInput?: boolean;
	preparing?: boolean;
	/** The chat (the kept page's strokes are fetched from it after a reload). A plugin problem's dock has no kept page. */
	chatId?: string;
	/** The problem's newest sketch — its kept page (M3). */
	keptSketch?: SketchRef | null;
	/** The session's model reads images — "Open in sketch" shows only then
	 *  (a text-only model would silently drop the pages). */
	sketchAvailable?: boolean;
	/** Escape in the thinking field stops dictation (threaded from the page). */
	onEscape?: () => void;
	/** Compaction is running for this chat (owner round 14): the thinking
	 *  POST would block on the server's compaction gate — disable submit
	 *  and say so in the hint row. The server registry is the real gate;
	 *  this is the affordance. */
	compactionRunning?: boolean;
}

export function PracticeDock({
	viewReader,
	problemCallId,
	messageId,
	wordingOnly = false,
	input,
	expanded,
	onExpand,
	onSubmit,
	onPrepareSubmission,
	customInput,
	hasPendingInput = false,
	preparing = false,
	chatId,
	keptSketch = null,
	onEscape,
	compactionRunning = false,
	sketchAvailable = false,
}: PracticeDockProps) {
	const controller = useOptionalInteractionLayers();
	const rootRef = useRef<HTMLElement>(null);
	const [nativeThinking, setNativeThinking] = useState("");
	const custom = useRef(customInput); custom.current = customInput;
	const thinking = customInput ? customInput.thinking : nativeThinking;
	const setThinking = (value: string) => { if (custom.current) custom.current.onThinkingChange(value); else setNativeThinking(value); };
	const [sketching, setSketching] = useState(false);
	// Submit has been pressed: the confidence buttons stand in for it until one is pressed (owner, 2026-10-28)
	const [asking, setAsking] = useState(false);
	// The kept page (M3): the problem's earlier sketch plus unsent ink. A
	// text submit attaches them (the chip) unless the learner removed it.
	const { kept, status: keptStatus } = useKeptPage(chatId ?? "", problemCallId, keptSketch);
	const ink = useInk(problemCallId);
	const [detached, setDetached] = useState(false);
	const [sketchError, setSketchError] = useState<string | null>(null);
	// A photo of the work (M17): taken with the camera, sent as its own sketch page; it wins over unsent ink (the ink stays)
	const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
	useEffect(() => () => releasePhoto(photo), [photo]);
	const camera = useCamera((files) => {
		const file = files[0];
		if (!file) return;
		setSketchError(null);
		preparePhoto(file).then(setPhoto, (err: unknown) => setSketchError(err instanceof PhotoError ? err.message : "The photo could not be used."));
	});
	const attach = sketchAvailable && !detached && (ink.strokes.length > 0 || keptSketch !== null);
	// A switch to a text-only model closes an open sketch (its ink stays).
	useEffect(() => {
		if (!sketchAvailable) setSketching(false);
	}, [sketchAvailable]);
	// Ref MIRRORS the field ("nothing gets lost", the question-dock
	// discipline): a submit resuming after `await finishDictation()` reads
	// the tail, never a stale closure.
	const thinkingRef = useRef(thinking); thinkingRef.current = thinking;
	const editRevision = useRef(0);
	useLayoutEffect(() => {
		if (!viewReader) return;
		const read = () => thinkingRef.current;
		viewReader.current = read;
		return () => { if (viewReader.current === read) viewReader.current = null; };
	}, [viewReader]);

	useDictationTarget(
		useCallback(
			(t: string, withdraw?: boolean) => {
				const v = joinDictation(thinkingRef.current, t, withdraw);
				thinkingRef.current = v; editRevision.current++;
				setThinking(v);
			},
			[],
		),
		true,
	);

	useLayoutEffect(() => { viewReader?.changed?.(); }, [viewReader, thinking]);

	/** Hand the thinking to the host's capture step (upstream: a plugin's editor or adapter); `mark` is the confidence pressed. */
	const runPrepare = (prepare: PrepareThinkingSubmission, mark?: ThinkingMark) => {
		let capturedRevision = editRevision.current;
		const read = () => (customInput ? thinkingRef.current : thinkingRef.current.trim());
		prepare(() => { capturedRevision = editRevision.current; return read(); }, captured => {
			if (editRevision.current === capturedRevision && read() === captured) { thinkingRef.current = ""; setThinking(""); }
		}, mark);
	};

	/** Submit (the button, or Enter). A plugin's own editor goes straight through its prepare; the native field asks for the
	 *  confidence first: the text must exist, then the confidence buttons take its place. */
	const submit = () => {
		if (compactionRunning || preparing) return;
		if (customInput) {
			if (!customInput.ready) return;
			runPrepare(customInput.prepare);
			return;
		}
		if (thinkingRef.current.trim().length === 0 && !photo && !hasPendingInput) return;
		setAsking(true);
	};

	/** The send itself, once a confidence button (or "I don't know") has been pressed. */
	const send = (mark: ThinkingMark) => {
		if (compactionRunning || preparing) return;
		const text = thinkingRef.current.trim();
		if (text.length === 0 && !photo && !hasPendingInput) return;
		setAsking(false);
		const hasInk = attach && (ink.strokes.length > 0 || keptSketch !== null);
		if (hasPendingInput && (photo || hasInk)) {
			// A thinking carries a sketch OR images, never both (the input contract says so too).
			setSketchError("A sketch and attached images can't be sent together — remove one.");
			return;
		}
		if (onPrepareSubmission && !photo && !hasInk) {
			runPrepare(onPrepareSubmission, mark);
			return;
		}
		if (photo) {
			// a photo answer: no ink to fold into a kept page, nothing to retry client-side
			setSketchError(null);
			thinkingRef.current = "";
			setThinking("");
			setPhoto(null);
			void onSubmit(text, photo.payload, undefined, mark);
			return;
		}
		let payload: SketchPayload | undefined;
		if (attach && ink.strokes.length > 0) {
			if (keptStatus === "loading") return; // the earlier page is still on its way
			try {
				payload = pagePayload(kept, ink.strokes, undefined, ink.thawed !== undefined);
			} catch (err) {
				if (!(err instanceof SketchPayloadError)) throw err;
				setSketchError(err.message);
				return;
			}
		}
		setSketchError(null);
		thinkingRef.current = "";
		setThinking("");
		if (payload) {
			// The ink folds into the kept page once the server accepts it.
			const unsent = ink.strokes;
			void sendPage(problemCallId, payload, unsent, async () => (await onSubmit(text, payload, undefined, mark)) ?? true);
		} else if (attach && keptSketch) onSubmit(text, undefined, keptSketch.id, mark);
		else onSubmit(text, undefined, undefined, mark);
	};

	/* The sketch submit: the thinking's dictated tail lands first (the
	 * question dock's finish-dictation discipline), then text + sketch go
	 * out as one submission. */
	const submitSketch = async (sketch: SketchPayload, confidenceIndex?: number): Promise<boolean> => {
		if (compactionRunning) return false;
		setSketching(false);
		if (isDictationActive()) await finishDictation();
		const text = thinkingRef.current.trim();
		thinkingRef.current = "";
		setThinking("");
		const mark: ThinkingMark | undefined = confidenceIndex === undefined ? undefined : { confidence: CONFIDENCE_STOPS[confidenceIndex] };
		return (await onSubmit(text, sketch, undefined, mark)) ?? true;
	};

	/* ENTER SUBMITS FROM ANYWHERE (owner round 6, 2026-10-05): dictation
	 * means the field is often never focused — the window-level Enter
	 * (typing surfaces and buttons excluded) submits the trace. Mounted
	 * while the dock is — collapsed bar included (the trace survives). */
	useEnterSubmits(submit, rootRef);

	/* ── the collapsed bar ── */
	const bar = (
			<button
				ref={element => { if (!customInput) rootRef.current = element; }}
				type="button"
				data-testid="practice-dock-bar"
				onClick={onExpand}
				className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon className="size-4 shrink-0 rotate-90" />
				<span className="font-medium">Problem</span>
				{/* The statement's first line, math rendered (owner, 2026-11-12); display-only, so nothing interactive nests in this button. */}
				<RichLine className="flex-1 [--lh-prose-size:var(--text-sm)] [--lh-prose-leading:var(--text-sm--line-height)]">{input.statement}</RichLine>
			</button>
		);
	if (!expanded && !customInput) return bar;

	/* ── the expanded form ── */
	return (
		<div ref={element => { rootRef.current = element; }} data-testid="practice-dock" data-problem={problemCallId}>
			{!expanded && bar}
			<div hidden={!expanded}>
			{/* The agent's half: the 'Problem' eyebrow (mirroring the quiz
			    cards' label row — owner round, 2026-10-05) + the statement,
			    markdown + LaTeX rendered, capped by the measured column
			    (--dock-max-h; the old fixed 40vh cut long problems short). */}
			<div data-dock-scroll-area="" className="max-h-[var(--dock-max-h,40vh)] overflow-y-auto px-4 pt-3 pb-2">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</div>
				<ClarifyWording messageId={messageId} callId={problemCallId} dock className="lh-prose text-[15px]">
					<ToolContentResponse>{input.statement}</ToolContentResponse>
				</ClarifyWording>
			</div>

			{customInput?.editor}

			{/* The learner's half: Enter SENDS (owner round 2, 2026-10-05);
			    Shift+Enter makes a newline — less to decide about. */}
			<div
				data-testid="practice-thinking-field"
				className={cn("m-1.5 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50", wordingOnly && "hidden")}
			>
				<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					YOUR THINKING
				</div>
				<PathInput
					value={thinking}
					onValueChange={(value) => {
						thinkingRef.current = value; editRevision.current++;
						setThinking(value);
						setAsking(false); // changing the text puts Submit back
					}}
					onKeyDown={(e) => {
						if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
						// Esc ends dictation — stopPropagation claims it (the
						// keyboard machine) so the window chain doesn't also fire.
						if (e.key === "Escape" && onEscape) {
							controller?.claimEscape(e);
							e.preventDefault();
							e.stopPropagation();
							onEscape();
							return;
						}
						// Enter SENDS — the single lane (owner round 2, 2026-10-05);
						// Shift+Enter is the newline, ⌘/Ctrl+Enter the chord too.
						if (enterSends(e)) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder="Work here, think out loud."
					className={cn(
						"field-sizing-content lh-input max-h-64 min-h-16 w-full resize-none bg-transparent px-2.5 pb-2 outline-none placeholder:text-muted-foreground",
					)}
				/>
				{photo && (
					<div className="px-2.5 pb-1.5">
						<span data-testid="practice-photo-chip" className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 py-0.5 pr-1 pl-1 text-xs text-muted-foreground">
							{/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL of the photo just taken */}
							<img src={photo.previewUrl} alt="" className="size-5 rounded-full object-cover" />
							Photo attached
							<button
								type="button"
								data-testid="practice-photo-chip-remove"
								aria-label="Don't attach the photo"
								title="Remove the photo"
								onClick={() => setPhoto(null)}
								className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground"
							>
								<XIcon className="size-3" />
							</button>
						</span>
					</div>
				)}
				{attach && !photo && (
					<div className="px-2.5 pb-1.5">
						<span
							data-testid="practice-sketch-chip"
							className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2 text-xs text-muted-foreground"
						>
							<PenLineIcon className="size-3" />
							Sketch attached
							<button
								type="button"
								data-testid="practice-sketch-chip-remove"
								aria-label="Don't attach the sketch"
								title="Send the text alone"
								onClick={() => setDetached(true)}
								className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground"
							>
								<XIcon className="size-3" />
							</button>
						</span>
					</div>
				)}
				{/* The submit row (owner round 4, 2026-10-05): IDENTICAL to the
				    question dock's — hint left, the SAME Button (h-9, px-3.5),
				    one p-1 row. Corner radii concentric: shell 16 − m-1.5 (6) =
				    field 10 − p-1 (4) = button 6. */}
				{asking ? (
					<div className="p-1" data-testid="practice-confidence-row">
						<ConfidenceButtons
							onPick={(index) => send({ confidence: CONFIDENCE_STOPS[index] })}
							disabled={compactionRunning}
							testidPrefix="practice-confidence"
							leading={
								<button
									type="button"
									disabled={compactionRunning}
									onClick={() => send({ dontKnow: true })}
									data-testid="practice-dont-know"
									className="lh-touch h-10 min-w-0 flex-[1.8] truncate rounded-[6px] border border-dashed border-border/70 bg-transparent px-0 text-[11px] tracking-tighter text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
								>
									I don't know
								</button>
							}
						/>
					</div>
				) : (
					<div className="flex items-center gap-2 p-1">
						{!customInput && sketchAvailable && camera.available && (
							<Button
								type="button"
								variant="secondary"
								data-testid="practice-add-photo"
								onClick={camera.open}
								className="lh-press h-9 gap-1.5 rounded-pill px-4 text-sm active:rounded-lg"
							>
								<CameraIcon className="size-4" />
								Camera
							</Button>
						)}
						{!customInput && sketchAvailable && (
							<Button
								type="button"
								variant="secondary"
								data-testid="practice-open-sketch"
								onClick={() => {
									setDetached(false);
									setSketching(true);
								}}
								className="lh-press h-9 gap-1.5 rounded-pill px-4 text-sm active:rounded-lg"
							>
								<PenLineIcon className="size-4" />
								Open in sketch
							</Button>
						)}
						<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
							{compactionRunning ? "compacting session…" : (sketchError ?? <span className="lh-enter-hint [@media(pointer:coarse)]:hidden">↵ submits · ⇧↵ newline</span>)}
						</span>
						<Button
							type="button"
							data-testid="practice-send"
							disabled={(customInput ? !customInput.ready : (!thinking.trim() && !photo && !hasPendingInput)) || compactionRunning || preparing}
							onClick={() => submit()}
							className="ml-auto h-9 rounded-[6px] px-3.5 text-sm font-medium"
						>
							{customInput ? "Submit" : "Submit thinking"}
						</Button>
					</div>
				)}
			</div>
			{camera.node}
			{sketching && sketchAvailable && !customInput && (
				<SketchView
					label="Problem"
					statement={typeof input.statement === "string" ? input.statement : ""}
					inkKey={problemCallId}
					onSubmit={submitSketch}
					onClose={() => setSketching(false)}
					onCancelDictation={onEscape}
					disabled={compactionRunning}
					keptStatus={keptStatus}
					confidenceLevels
				/>
			)}
			</div>
		</div>
	);
}
