"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EraserIcon, Grid3x3Icon, MicIcon, PenLineIcon, Redo2Icon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfidenceButtons } from "@/components/confidence-buttons";
import { isDictationActive } from "@/components/dictation";
import { FloatingProblem } from "@/components/sketch/floating-problem";
import { SketchCanvas, type SketchTool } from "@/components/sketch/sketch-canvas";
import { ZoomControls } from "@/components/sketch/zoom-controls";
import { backgroundCss, loadBackground, nextBackground, saveBackground, type SketchBackground } from "@/components/sketch/sketch-background";
import { useNativeInk } from "@/components/sketch/use-native-ink";
import { loadEraser, loadPen, saveEraser, savePen, SKETCH_COLORS, SKETCH_ERASER_SIZES, SKETCH_WIDTHS, type EraserSettings, type PenSettings } from "@/components/sketch/pen-settings";
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
 * nothing; M13f adds E (eraser), 1-5 (ink colour) and G (paper). The listener sits at the window's CAPTURE phase and claims
 * those keys, so the dock's Enter-submits-anywhere and the page's Esc
 * chain (problem dismissal) never see them while the view is open.
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

/** The toolbar's mic (M3): the app's own dictation toggle (⌘D) — no new
 *  claim; text lands in the dock's field exactly as with the key. */
function SketchMic() {
	const [live, setLive] = useState(isDictationActive());
	useEffect(() => {
		const t = window.setInterval(() => setLive(isDictationActive()), 250);
		return () => window.clearInterval(t);
	}, []);
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			data-testid="sketch-mic"
			aria-label={live ? "Stop dictation" : "Start dictation"}
			aria-pressed={live}
			onClick={() => window.dispatchEvent(new CustomEvent("lh:kbd-toggle-dictation"))}
			className={cn(live && "bg-destructive/10 text-destructive hover:bg-destructive/20")}
		>
			<MicIcon className="size-4" />
		</Button>
	);
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
	const [background, setBackgroundState] = useState<SketchBackground>(loadBackground);
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
	const canvasRef = useRef<HTMLDivElement | null>(null);
	const setInk = (next: InkState) => {
		writeInk(inkKey, next);
		setError(null);
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
	const native = useNativeInk({ inkKey, wrapperRef: canvasRef, strokes: ink.strokes, kept: ink.thawed === undefined ? kept?.strokes : undefined, tool, pen, eraser, onStroke: addStroke, onErase: erase, onCut: cut });
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
	const pickColor = (i: number) => {
		const c = SKETCH_COLORS[i];
		if (c) setPen({ ...pen, color: c.value });
	};
	const handlers = useRef({ undo, redo, submit, onClose, onCancelDictation, toggleEraser, pickColor, cycleBackground });
	handlers.current = { undo, redo, submit, onClose, onCancelDictation, toggleEraser, pickColor, cycleBackground };
	// drawing on, or the answer changing under the page, puts Submit back
	const strokeCount = ink.strokes.length;
	useEffect(() => setAsking(false), [strokeCount, blocked, disabled, confidenceLevels]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			const h = handlers.current;
			if (e.key === "Escape") {
				if (isDictationActive() && h.onCancelDictation) h.onCancelDictation();
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
			} else if (!mod && !e.altKey && !e.shiftKey && /^[egEG1-5]$/.test(e.key) && !isEditable(e.target)) {
				const k = e.key.toLowerCase();
				if (k === "e") h.toggleEraser();
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
	useBackLayer(true, () => {
		const h = handlers.current;
		if (isDictationActive() && h.onCancelDictation) h.onCancelDictation();
		else h.onClose();
	});

	if (typeof document === "undefined") return null;
	const empty = !hasNewInk(ink);
	const canUndo = ink.undo.length > 0 || ink.strokes.some((s) => s.fresh !== false);
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
			{/* The whole page is canvas; the problem floats above it (owner,
			    2026-10-26) — draggable, collapsible to a pill. */}
			<div ref={canvasRef} className={cn("relative min-h-0 flex-1", !native.active && "bg-white")}>
				{native.active ? (
					<>
						<div aria-hidden data-testid="sketch-native-paper" style={backgroundCss(background, native.view)} className="pointer-events-none absolute inset-0" />
						<div ref={native.surfaceRef} data-testid="sketch-native-surface" style={{ touchAction: "none" }} className="absolute inset-0" />
						<ZoomControls zoomPct={native.zoomPct} onZoom={native.zoomBy} onReset={native.resetView} />
					</>
				) : (
					<SketchCanvas strokes={ink.strokes} kept={ink.thawed === undefined ? kept?.strokes : undefined} tool={tool} brush={pen} eraser={eraser} background={background} onStroke={addStroke} onErase={erase} onCut={cut} />
				)}
				<FloatingProblem label={label} statement={statement}>
					{choices}
				</FloatingProblem>
			</div>
			<div data-testid="sketch-pen-strip" className="flex items-center gap-1 overflow-x-auto border-t bg-background px-3 py-1">
				{tool === "eraser" ? (
					<>
						{(["pixel", "stroke"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								data-testid={`sketch-erase-${mode}`}
								aria-label={mode === "pixel" ? "Erase part of a stroke" : "Erase whole strokes"}
								aria-pressed={eraser.mode === mode}
								onClick={() => setEraser({ ...eraser, mode })}
								className={cn("lh-touch shrink-0 rounded-md px-2.5 text-xs font-medium", eraser.mode === mode ? "bg-accent" : "text-muted-foreground")}
							>
								{mode === "pixel" ? "Part" : "Stroke"}
							</button>
						))}
						<span aria-hidden className="mx-1 h-5 w-px bg-border" />
						{SKETCH_ERASER_SIZES.map((z) => (
							<button
								key={z.value}
								type="button"
								data-testid={`sketch-erase-size-${z.name.toLowerCase()}`}
								aria-label={`${z.name} eraser`}
								aria-pressed={eraser.radius === z.value}
								onClick={() => setEraser({ ...eraser, radius: z.value })}
								className={cn("lh-touch grid size-8 shrink-0 place-items-center rounded-md", eraser.radius === z.value && "bg-accent")}
							>
								<span aria-hidden style={{ width: z.value / 2 + 4, height: z.value / 2 + 4 }} className="rounded-full border border-foreground/60" />
							</button>
						))}
					</>
				) : (
					<>
				{SKETCH_COLORS.map((c) => (
					<button
						key={c.value}
						type="button"
						data-testid={`sketch-color-${c.name.toLowerCase()}`}
						aria-label={`${c.name} ink`}
						aria-pressed={tool === "pen" && pen.color === c.value}
						onClick={() => setPen({ ...pen, color: c.value })}
						className="lh-touch grid size-8 shrink-0 place-items-center rounded-full"
					>
						<span
							aria-hidden
							style={{ backgroundColor: c.value }}
							className={cn("size-5 rounded-full border border-black/10", tool === "pen" && pen.color === c.value && "ring-2 ring-ring ring-offset-2 ring-offset-background")}
						/>
					</button>
				))}
				<span aria-hidden className="mx-1 h-5 w-px bg-border" />
				{SKETCH_WIDTHS.map((w) => (
					<button
						key={w.value}
						type="button"
						data-testid={`sketch-width-${w.name.toLowerCase()}`}
						aria-label={`${w.name} pen`}
						aria-pressed={tool === "pen" && pen.size === w.value}
						onClick={() => setPen({ ...pen, size: w.value })}
						className={cn("lh-touch grid size-8 shrink-0 place-items-center rounded-md", tool === "pen" && pen.size === w.value && "bg-accent")}
					>
						<span aria-hidden style={{ width: w.value + 4, height: w.value + 4 }} className="rounded-full bg-foreground" />
					</button>
				))}
					</>
				)}
			</div>
			<div className="flex items-center gap-1 border-t bg-background px-3 py-2">
				<Button type="button" variant="ghost" size="icon" data-testid="sketch-close" aria-label="Close sketch" onClick={onClose}>
					<XIcon className="size-4" />
				</Button>
				<Button type="button" variant="ghost" size="icon" data-testid="sketch-undo" aria-label="Undo" disabled={!canUndo} onClick={undo}>
					<Undo2Icon className="size-4" />
				</Button>
				<Button type="button" variant="ghost" size="icon" data-testid="sketch-redo" aria-label="Redo" disabled={ink.redo.length === 0} onClick={redo}>
					<Redo2Icon className="size-4" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					data-testid="sketch-clear"
					aria-label="Clear"
					disabled={empty}
					onClick={clear}
				>
					<Trash2Icon className="size-4" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					data-testid="sketch-eraser"
					aria-label={tool === "eraser" ? "Switch to pen" : "Switch to eraser"}
					aria-pressed={tool === "eraser"}
					onClick={() => setTool(tool === "eraser" ? "pen" : "eraser")}
					className={cn(tool === "eraser" && "bg-accent")}
				>
					{tool === "eraser" ? <PenLineIcon className="size-4" /> : <EraserIcon className="size-4" />}
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					data-testid="sketch-background"
					aria-label={`Paper: ${background}`}
					title={`Paper: ${background} (tap to change)`}
					onClick={cycleBackground}
					className={cn(background !== "none" && "bg-accent")}
				>
					<Grid3x3Icon className="size-4" />
				</Button>
				<SketchMic />
				<span aria-hidden className={cn("ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground", asking && "hidden")}>
					{error ??
						(native.fallback
							? `native ink unavailable (${native.fallback}) — using the web canvas`
							: disabled
							? "compacting session…"
							: keptStatus === "loading"
								? "loading your earlier page…"
								: blocked ??
									(keptStatus === "failed"
										? "couldn't load your earlier page — new ink goes alone"
										: "⌘↵ submits · esc closes"))}
				</span>
				{asking ? (
					<ConfidenceButtons onPick={(index) => submit(index)} testidPrefix="sketch-confidence" className="ml-2 min-w-0 flex-1" />
				) : (
					<Button
						type="button"
						data-testid="sketch-submit"
						disabled={empty || disabled || !!blocked || keptStatus === "loading"}
						onClick={() => submit()}
						className="h-9 rounded-[6px] px-3.5 text-sm font-medium"
					>
						Submit sketch
					</Button>
				)}
			</div>
		</div>,
		document.body,
	);
}
