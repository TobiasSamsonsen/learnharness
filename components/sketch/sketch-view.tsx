"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { isDictationActive } from "@/components/dictation";
import { FloatingProblem } from "@/components/sketch/floating-problem";
import { SketchCanvas, type SketchTool } from "@/components/sketch/sketch-canvas";
import { ZoomIndicator } from "@/components/sketch/zoom-indicator";
import { loadTone, saveTone, type SheetTone } from "@/components/sketch/sketch-sheet";
import { backgroundCss, loadBackground, loadPaperSize, nextBackground, PAPER_SIZES, saveBackground, savePaperSize, type SketchBackground } from "@/components/sketch/sketch-background";
import { SketchToolbar, usePenDown, type SketchPanel } from "@/components/sketch/sketch-toolbar";
import { limitShare, sketchStatus, submitBlockReason } from "@/components/sketch/sketch-status";
import { useNativeInk } from "@/components/sketch/use-native-ink";
import { loadEraser, loadPen, loadToolbar, saveEraser, savePen, saveToolbar, SKETCH_COLORS, SKETCH_WIDTHS, type EraserSettings, type PenSettings, type ToolbarPrefs } from "@/components/sketch/pen-settings";
import { applyOp, hasNewInk, pagePayload, readInk, revertOp, sendPage, thawInk, useInk, useKept, writeInk, type InkOp, type InkState } from "@/components/sketch/ink-memory";
import { cn } from "@/lib/utils";
import { SketchPayloadError, sketchStrokeCut, type SketchPayload } from "@/src/core";
import { useBackLayer } from "../back-layers.ts";

/**
 * The sketch view (Android plan M1): a full-screen plain canvas opened
 * from the practice dock or a text-mode question. The question or problem
 * floats in a draggable, collapsible box above the page (floating-problem
 * .tsx); the learner submits from here, and the dock's
 * own text (typed or dictated — the dock keeps its dictation claim) rides
 * along with the sketch.
 *
 * Keys (owner, M1): Ctrl/⌘+Enter submits, Esc closes (cancels dictation
 * first), Ctrl/⌘+Z undoes, Ctrl/⌘+Shift+Z redoes, plain Enter does
 * nothing; M13f adds E (eraser), 1-5 (ink colour) and G (paper); M16 adds [ and ] (pen width). The listener sits at the window's CAPTURE phase and claims
 * those keys, so the dock's Enter-submits-anywhere and the page's Esc
 * chain (problem dismissal) never see them while the view is open.
 *
 * One top bar holds every control (M16, owner: a resting palm hits nothing at the bottom edge): sketch-toolbar.tsx.
 */

export interface SketchViewProps {
	/** The box's eyebrow — "Problem" or "Question". */
	label: string;
	/** The statement (markdown + LaTeX). */
	statement: string;
	/** The question's or problem's tool-call id: unsent ink is kept per key. */
	inkKey: string;
	/** The sketch is ready; the caller finishes dictation and sends, and
	 *  resolves to whether the server accepted it. */
	onSubmit: (sketch: SketchPayload, confidenceIndex?: number) => Promise<boolean>;
	onClose: () => void;
	/** Cancel a live dictation run (the page's Esc behaviour). */
	onCancelDictation?: () => void;
	/** Submitting is blocked (compaction running). */
	disabled?: boolean;
	/** The kept page's earlier strokes are still being fetched ("failed":
	 *  they could not be — new ink then goes alone). */
	keptStatus?: "ready" | "loading" | "failed";
	/** A multiple-choice question's answer controls (M3), shown in the
	 *  floating box under the statement. */
	choices?: React.ReactNode;
	/** Why the dock would refuse this submit (a pick or confidence is
	 *  missing) — disables Submit and shows as its hint. */
	blocked?: string;
	/** A quiz answer is being given (owner, 2026-10-28): Submit then expands in place into the confidence buttons, and the
	 *  one pressed is handed to `onSubmit` as an index into CONFIDENCE_STOPS. */
	confidenceLevels?: boolean;
}

/** A text field the key belongs to (the sketch shortcuts are single letters and digits). */
function isEditable(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	return !!el && (el.isContentEditable === true || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}

function focusVisible(el: HTMLElement): boolean {
	try {
		return el.matches(":focus-visible");
	} catch {
		return false; // a selector engine without the pseudo (linkedom)
	}
}

export function SketchView({
	label,
	statement,
	inkKey,
	onSubmit,
	onClose,
	onCancelDictation,
	disabled = false,
	keptStatus = "ready",
	choices,
	blocked,
	confidenceLevels = false,
}: SketchViewProps) {
	const ink = useInk(inkKey);
	const kept = useKept(inkKey);
	const [tool, setTool] = useState<SketchTool>("pen");
	const [pen, setPenState] = useState<PenSettings>(loadPen);
	const setPen = (next: PenSettings) => {
		setPenState(next);
		savePen(next);
		setTool("pen");
	};
	const [tone, setToneState] = useState<SheetTone>(loadTone);
	const toggleTone = () => {
		const next = tone === "dark" ? "light" : "dark";
		setToneState(next);
		saveTone(next);
	};
	// Clear asks first (owner, M13): it is one tap from the toolbar and removes everything drawn since the last submit
	const [confirmClear, setConfirmClear] = useState(false);
	const [background, setBackgroundState] = useState<SketchBackground>(loadBackground);
	const [paperSize, setPaperSizeState] = useState(loadPaperSize);
	const setPaperSize = (next: number) => {
	setPaperSizeState(next);
	savePaperSize(next);
	};
	const cycleBackground = () => {
		const next = nextBackground(background);
		setBackgroundState(next);
		saveBackground(next);
	};
	const [eraser, setEraserState] = useState<EraserSettings>(loadEraser);
	const setEraser = (next: EraserSettings) => {
		setEraserState(next);
		saveEraser(next);
		setTool("eraser");
	};
	const [error, setError] = useState<string | null>(null);
	/** The reason a press on a waiting Submit was ignored, shown while it still holds. */
	const [noted, setNoted] = useState<string | null>(null);
	const [prefs, setPrefsState] = useState<ToolbarPrefs>(loadToolbar);
	const setPrefs = (next: ToolbarPrefs) => {
		setPrefsState(next);
		saveToolbar(next);
	};
	const [panel, setPanel] = useState<SketchPanel>(null);
		const drawing = usePenDown();
	// the options panel belongs to its tool: another tool (the E key, say) takes it away
	useEffect(() => setPanel((p) => ((p === "pen" || p === "eraser") && p !== tool ? null : p)), [tool]);
	const canvasRef = useRef<HTMLDivElement | null>(null);
	const setInk = (next: InkState) => {
	setPanel(null);
	writeInk(inkKey, next);
		setError(null);
		setNoted(null);
	};

	/** Record an operation: it joins the history and clears redo. */
	const record = (state: InkState, strokes: InkState["strokes"], op: InkOp) =>
		setInk({ ...state, strokes, undo: [...state.undo, op], redo: [] });
	const undo = () => {
		const state = readInk(inkKey);
		// Ink restored from a reload has no history: undo takes the newest stroke.
		const fromStack = state.undo[state.undo.length - 1];
		const newest = state.strokes[state.strokes.length - 1];
		const op: InkOp | undefined = fromStack ?? (newest && newest.fresh !== false ? { kind: "add", stroke: newest } : undefined);
		if (!op) return;
		setInk({ ...state, strokes: revertOp(state.strokes, op), undo: fromStack ? state.undo.slice(0, -1) : [], redo: [...state.redo, op] });
	};
	const redo = () => {
		const state = readInk(inkKey);
		const op = state.redo[state.redo.length - 1];
		if (!op) return;
		setInk({ ...state, strokes: applyOp(state.strokes, op), undo: [...state.undo, op], redo: state.redo.slice(0, -1) });
	};
	const addStroke = (stroke: InkState["strokes"][number]) => {
	const state = readInk(inkKey);
	record(state, [...state.strokes, stroke], { kind: "add", stroke });
	};
	const clear = () => {
		const state = readInk(inkKey);
		if (state.strokes.length > 0) record(state, [], { kind: "clear", removed: state.strokes });
	};
	/** The pixel eraser: every stroke the path touched becomes its surviving pieces (one undo step). */
	const cut = (path: number[], radius: number) => {
		let state = readInk(inkKey);
		// sent ink the eraser reaches is thawed into the working page first, then cut like the rest
		if (kept && state.thawed === undefined && keptStatus === "ready" && kept.strokes.some((s) => sketchStrokeCut(s, path, radius))) {
			state = thawInk(state, kept);
		}
		const changes: Extract<InkOp, { kind: "cut" }>["changes"] = [];
		state.strokes.forEach((stroke, index) => {
			const pieces = sketchStrokeCut(stroke, path, radius);
			if (pieces) changes.push({ index, stroke, pieces });
		});
		if (changes.length === 0) return;
		const op: InkOp = { kind: "cut", changes };
		record(state, applyOp(state.strokes, op), op);
	};
	const erase = (indices: number[]) => {
		const state = readInk(inkKey);
		const removed = [...indices].sort((a, b) => a - b).flatMap((index) => (state.strokes[index] ? [{ index, stroke: state.strokes[index]! }] : []));
		if (removed.length === 0) return;
		record(state, applyOp(state.strokes, { kind: "erase", removed }), { kind: "erase", removed });
	};
	// The Android shell's native ink layer, when the setting is on (owner, M10): it draws under the transparent page
	const native = useNativeInk({ inkKey, wrapperRef: canvasRef, strokes: ink.strokes, kept: ink.thawed === undefined ? kept?.strokes : undefined, tool, pen, tone, eraser, onStroke: addStroke, onErase: erase, onCut: cut });
	// Submit has been pressed on a quiz answer: the confidence buttons stand in for it until one is pressed
	const [asking, setAsking] = useState(false);
	const submit = (confidenceIndex?: number) => {
		const state = readInk(inkKey);
		const unsent = state.strokes;
		if (disabled || blocked || keptStatus === "loading" || !hasNewInk(state)) return;
		if (confidenceLevels && confidenceIndex === undefined) {
			setAsking(true);
			return;
		}
		let payload: SketchPayload;
		try {
			payload = pagePayload(kept, unsent, native.active ? "android-ink" : "web-canvas", state.thawed !== undefined);
		} catch (err) {
			if (err instanceof SketchPayloadError) {
				setError(err.message);
				return;
			}
			throw err;
		}
		// The ink folds into the kept page only once the server has the
		// sketch (a 409/500/400 keeps it for a retry); anything drawn since
		// stays unsent.
		void sendPage(inkKey, payload, unsent, () => onSubmit(payload, confidenceIndex));
	};

	// PC shortcuts (M13f): E toggles the eraser, 1-5 pick the ink, G changes the paper
	const toggleEraser = () => setTool(tool === "eraser" ? "pen" : "eraser");
	const stepWidth = (dir: 1 | -1) => {
		const i = SKETCH_WIDTHS.findIndex((w) => w.value === pen.size);
		const next = SKETCH_WIDTHS[Math.min(SKETCH_WIDTHS.length - 1, Math.max(0, i + dir))];
		if (next) setPen({ ...pen, size: next.value });
	};
	const pickColor = (i: number) => {
		const c = SKETCH_COLORS[i];
		if (c) setPen({ ...pen, color: c.value });
	};
	const handlers = useRef({ undo, redo, submit, onClose, onCancelDictation, toggleEraser, pickColor, stepWidth, cycleBackground, confirmOpen: confirmClear, cancelConfirm: () => setConfirmClear(false), panelOpen: panel !== null, closePanel: () => setPanel(null) });
	handlers.current = { undo, redo, submit, onClose, onCancelDictation, toggleEraser, pickColor, stepWidth, cycleBackground, confirmOpen: confirmClear, cancelConfirm: () => setConfirmClear(false), panelOpen: panel !== null, closePanel: () => setPanel(null) };
	// drawing on, or the answer changing under the page, puts Submit back
	const strokeCount = ink.strokes.length;
	useEffect(() => setAsking(false), [strokeCount, blocked, disabled, confidenceLevels]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			const h = handlers.current;
			if (e.key === "Escape") {
				if (h.confirmOpen) h.cancelConfirm();
				else if (h.panelOpen) h.closePanel();
				else if (isDictationActive() && h.onCancelDictation) h.onCancelDictation();
				else h.onClose();
			} else if (e.key === "Enter") {
				// A KEYBOARD-focused button activates natively (a pointer-clicked
				// one doesn't: plain Enter does nothing in the sketch view).
				const t = e.target as HTMLElement | null;
				if (!mod && t?.tagName === "BUTTON" && focusVisible(t)) return;
				if (mod) h.submit();
			} else if (mod && e.key.toLowerCase() === "z") {
				if (e.shiftKey) h.redo();
				else h.undo();
			} else if (!mod && !e.altKey && !e.shiftKey && /^[egEG1-5[\]]$/.test(e.key) && !isEditable(e.target)) {
				const k = e.key.toLowerCase();
				if (k === "[") h.stepWidth(-1);
				else if (k === "]") h.stepWidth(1);
				else if (k === "e") h.toggleEraser();
				else if (k === "g") h.cycleBackground();
				else h.pickColor(Number(k) - 1);
			} else {
				return; // every other key keeps its app-wide meaning (⌘D dictation, …)
			}
			e.preventDefault();
			e.stopPropagation();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);
	useBackLayer(confirmClear, () => setConfirmClear(false));
	useBackLayer(panel !== null, () => setPanel(null));
	useBackLayer(true, () => {
		const h = handlers.current;
		if (isDictationActive() && h.onCancelDictation) h.onCancelDictation();
		else h.onClose();
	});

	if (typeof document === "undefined") return null;
	const empty = !hasNewInk(ink);
	const canUndo = ink.undo.length > 0 || ink.strokes.some((s) => s.fresh !== false);
	const submitBlock = submitBlockReason({ empty, disabled, blocked, keptStatus });
	const status = sketchStatus({
		error,
		note: noted !== null && noted === submitBlock ? noted : null,
		nativeFallback: native.fallback,
		disabled,
		keptStatus,
		blocked,
		share: limitShare([...(ink.thawed === undefined ? (kept?.strokes ?? []) : []), ...ink.strokes]),
	});
	return createPortal(
		<div
			data-testid="sketch-view"
			role="dialog"
			aria-label="Sketch"
			className={cn(
				"lh-no-drag fixed inset-0 z-50 flex flex-col pb-[var(--lh-safe-bottom)] pl-[var(--lh-safe-left)] pr-[var(--lh-safe-right)] pt-[var(--lh-safe-top)]",
				// native ink draws UNDER the page: the page must let it through (the safe-area strips below keep the edges opaque)
				native.active ? "bg-transparent" : "bg-background",
			)}
		>
			{native.active && (
				<>
					<div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[var(--lh-safe-top)] bg-background" />
					<div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[var(--lh-safe-left)] bg-background" />
					<div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-[var(--lh-safe-right)] bg-background" />
					<div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[var(--lh-safe-bottom)] bg-background" />
				</>
			)}
			<SketchToolbar
				tool={tool}
				pen={pen}
				eraser={eraser}
				background={background}
				paperSize={paperSize}
				tone={tone}
				canUndo={canUndo}
				canRedo={ink.redo.length > 0}
				canClear={!empty}
				submitBlock={submitBlock}
				asking={asking}
				status={status}
				prefs={prefs}
				panel={panel}
				drawing={drawing}
				onPanel={setPanel}
				onPrefs={setPrefs}
				onTool={setTool}
				onPen={setPen}
				onEraser={setEraser}
				onBackground={(next) => {
					setBackgroundState(next);
					saveBackground(next);
				}}
				onToggleTone={toggleTone}
				onPaperSize={setPaperSize}
				onClose={onClose}
				onUndo={undo}
				onRedo={redo}
				onClear={() => setConfirmClear(true)}
				onSubmit={() => submit()}
				onSubmitBlocked={setNoted}
				onConfidence={(index) => submit(index)}
			/>
			{/* The whole page is canvas; the problem floats above it (owner,
			    2026-10-26) — draggable, collapsible to a pill. */}
			<div ref={canvasRef} className={cn("relative min-h-0 flex-1", !native.active && "bg-white")}>
				{native.active ? (
					<>
						<div aria-hidden data-testid="sketch-native-paper" style={backgroundCss(background, native.view, tone, PAPER_SIZES[paperSize] ?? 1)} className="pointer-events-none absolute inset-0" />
						<div ref={native.surfaceRef} data-testid="sketch-native-surface" style={{ touchAction: "none" }} className="absolute inset-0" />
						<ZoomIndicator zoomPct={native.zoomPct} />
					</>
				) : (
					<SketchCanvas strokes={ink.strokes} kept={ink.thawed === undefined ? kept?.strokes : undefined} tool={tool} brush={pen} eraser={eraser} background={background} tone={tone} paperSize={paperSize} onStroke={addStroke} onErase={erase} onCut={cut} onTwoFingerTap={undo} />
				)}
{empty && ink.strokes.length === 0 && (
					<p aria-hidden data-testid="sketch-empty-hint" className="pointer-events-none absolute inset-x-0 bottom-[20%] text-center text-sm text-muted-foreground/70">
						Write or draw here
					</p>
				)}
				<FloatingProblem label={label} statement={statement}>
					{choices}
				</FloatingProblem>
				{confirmClear && (
					// a touch hole (data-ink-hole): the native layer must not draw under it
					<div data-ink-hole="" data-testid="sketch-clear-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sketch-clear-title" className="absolute inset-0 z-20 grid place-items-center bg-black/40 p-4">
						<div className="w-full max-w-sm rounded-xl border bg-background p-4 text-foreground shadow-lg">
							<h2 id="sketch-clear-title" className="text-sm font-semibold">
								Clear the whole sketch?
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">Everything you have drawn since your last submit is removed. Ink you already sent stays. You can undo this.</p>
							<div className="mt-4 flex justify-end gap-2">
								<Button type="button" variant="ghost" data-testid="sketch-clear-cancel" autoFocus onClick={() => setConfirmClear(false)}>
									Cancel
								</Button>
								<Button
									type="button"
									variant="destructive"
									data-testid="sketch-clear-confirm"
									onClick={() => {
										setConfirmClear(false);
										clear();
									}}
								>
									Clear
								</Button>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
