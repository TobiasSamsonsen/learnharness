"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EraserIcon, MicIcon, PenLineIcon, Redo2Icon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isDictationActive } from "@/components/dictation";
import { FloatingProblem } from "@/components/sketch/floating-problem";
import { SketchCanvas, type SketchTool } from "@/components/sketch/sketch-canvas";
import { applyOp, pagePayload, readInk, revertOp, sendPage, useInk, useKept, writeInk, type InkOp, type InkState } from "@/components/sketch/ink-memory";
import { cn } from "@/lib/utils";
import { SketchPayloadError, type SketchPayload } from "@/src/core";

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
 * nothing. The listener sits at the window's CAPTURE phase and claims
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
	onSubmit: (sketch: SketchPayload) => Promise<boolean>;
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
}: SketchViewProps) {
	const ink = useInk(inkKey);
	const kept = useKept(inkKey);
	const [tool, setTool] = useState<SketchTool>("pen");
	const [error, setError] = useState<string | null>(null);
	const setInk = (next: InkState) => {
		writeInk(inkKey, next);
		setError(null);
	};

	/** Record an operation: it joins the history and clears redo. */
	const record = (state: InkState, strokes: InkState["strokes"], op: InkOp) =>
		setInk({ strokes, undo: [...state.undo, op], redo: [] });
	const undo = () => {
		const state = readInk(inkKey);
		// Ink restored from a reload has no history: undo takes the newest stroke.
		const fromStack = state.undo[state.undo.length - 1];
		const op: InkOp | undefined = fromStack ?? (state.strokes.length > 0 ? { kind: "add", stroke: state.strokes[state.strokes.length - 1]! } : undefined);
		if (!op) return;
		setInk({ strokes: revertOp(state.strokes, op), undo: fromStack ? state.undo.slice(0, -1) : [], redo: [...state.redo, op] });
	};
	const redo = () => {
		const state = readInk(inkKey);
		const op = state.redo[state.redo.length - 1];
		if (!op) return;
		setInk({ strokes: applyOp(state.strokes, op), undo: [...state.undo, op], redo: state.redo.slice(0, -1) });
	};
	const addStroke = (stroke: InkState["strokes"][number]) => {
		const state = readInk(inkKey);
		record(state, [...state.strokes, stroke], { kind: "add", stroke });
	};
	const erase = (indices: number[]) => {
		const state = readInk(inkKey);
		const removed = [...indices].sort((a, b) => a - b).flatMap((index) => (state.strokes[index] ? [{ index, stroke: state.strokes[index]! }] : []));
		if (removed.length === 0) return;
		record(state, applyOp(state.strokes, { kind: "erase", removed }), { kind: "erase", removed });
	};
	const submit = () => {
		const unsent = readInk(inkKey).strokes;
		if (disabled || blocked || keptStatus === "loading" || unsent.length === 0) return;
		let payload: SketchPayload;
		try {
			payload = pagePayload(kept, unsent);
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
		void sendPage(inkKey, payload, unsent, () => onSubmit(payload));
	};

	const handlers = useRef({ undo, redo, submit, onClose, onCancelDictation });
	handlers.current = { undo, redo, submit, onClose, onCancelDictation };
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
			} else {
				return; // every other key keeps its app-wide meaning (⌘D dictation, …)
			}
			e.preventDefault();
			e.stopPropagation();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);

	if (typeof document === "undefined") return null;
	const empty = ink.strokes.length === 0;
	const canUndo = ink.undo.length > 0 || ink.strokes.length > 0;
	return createPortal(
		<div
			data-testid="sketch-view"
			role="dialog"
			aria-label="Sketch"
			className="lh-no-drag fixed inset-0 z-50 flex flex-col bg-background pb-[var(--lh-safe-bottom)] pl-[var(--lh-safe-left)] pr-[var(--lh-safe-right)] pt-[var(--lh-safe-top)]"
		>
			{/* The whole page is canvas; the problem floats above it (owner,
			    2026-10-26) — draggable, collapsible to a pill. */}
			<div className="relative min-h-0 flex-1 bg-white">
				<SketchCanvas strokes={ink.strokes} kept={kept?.strokes} tool={tool} onStroke={addStroke} onErase={erase} />
				<FloatingProblem label={label} statement={statement}>
					{choices}
				</FloatingProblem>
			</div>
			<div className="flex items-center gap-1 border-t px-3 py-2">
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
					onClick={() => setInk({ strokes: [], undo: [], redo: [] })}
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
				<SketchMic />
				<span aria-hidden className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{error ??
						(disabled
							? "compacting session…"
							: keptStatus === "loading"
								? "loading your earlier page…"
								: blocked ??
									(keptStatus === "failed"
										? "couldn't load your earlier page — new ink goes alone"
										: "⌘↵ submits · esc closes"))}
				</span>
				<Button
					type="button"
					data-testid="sketch-submit"
					disabled={empty || disabled || !!blocked || keptStatus === "loading"}
					onClick={submit}
					className="h-9 rounded-[6px] px-3.5 text-sm font-medium"
				>
					Submit sketch
				</Button>
			</div>
		</div>,
		document.body,
	);
}
