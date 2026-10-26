"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Redo2Icon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { isDictationActive } from "@/components/dictation";
import { SketchCanvas } from "@/components/sketch/sketch-canvas";
import { clearInk, readInk, writeInk, type InkState } from "@/components/sketch/ink-memory";
import { newSketchId, parseSketchPayload, repairMathForDisplay, SketchPayloadError, type SketchPayload } from "@/src/core";

/**
 * The sketch view (Android plan M1): a full-screen plain canvas opened
 * from the practice dock or a text-mode question. The question or problem
 * sits in a box at the top; the learner submits from here, and the dock's
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
}

function focusVisible(el: HTMLElement): boolean {
	try {
		return el.matches(":focus-visible");
	} catch {
		return false; // a selector engine without the pseudo (linkedom)
	}
}

export function SketchView({ label, statement, inkKey, onSubmit, onClose, onCancelDictation, disabled = false }: SketchViewProps) {
	const [ink, setInkState] = useState<InkState>(() => readInk(inkKey));
	const [error, setError] = useState<string | null>(null);
	const inkRef = useRef(ink);
	const setInk = (next: InkState) => {
		inkRef.current = next;
		writeInk(inkKey, next);
		setInkState(next);
		setError(null);
	};

	const undo = () => {
		const { strokes, redo } = inkRef.current;
		if (strokes.length === 0) return;
		setInk({ strokes: strokes.slice(0, -1), redo: [...redo, strokes[strokes.length - 1]!] });
	};
	const redo = () => {
		const { strokes, redo } = inkRef.current;
		if (redo.length === 0) return;
		setInk({ strokes: [...strokes, redo[redo.length - 1]!], redo: redo.slice(0, -1) });
	};
	const submit = () => {
		if (disabled || inkRef.current.strokes.length === 0) return;
		let payload: SketchPayload;
		try {
			payload = parseSketchPayload({ id: newSketchId(), producer: "web-canvas", strokes: inkRef.current.strokes });
		} catch (err) {
			if (err instanceof SketchPayloadError) {
				setError(err.message);
				return;
			}
			throw err;
		}
		// The ink is cleared only once the server has the sketch (a 409/500/
		// 400 keeps it for a retry) — and only if nothing was drawn since.
		const sent = inkRef.current.strokes;
		void onSubmit(payload).then((accepted) => {
			if (accepted && readInk(inkKey).strokes === sent) clearInk(inkKey);
		});
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
	return createPortal(
		<div
			data-testid="sketch-view"
			role="dialog"
			aria-label="Sketch"
			className="lh-no-drag fixed inset-0 z-50 flex flex-col bg-background"
		>
			<div className="flex items-start gap-2 border-b px-4 py-3">
				<div className="max-h-[30vh] min-w-0 flex-1 overflow-y-auto">
					<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
					<div className="lh-prose text-[15px]">
						<MessageResponse>{repairMathForDisplay(statement)}</MessageResponse>
					</div>
				</div>
				<Button type="button" variant="ghost" size="icon" data-testid="sketch-close" aria-label="Close sketch" onClick={onClose}>
					<XIcon className="size-4" />
				</Button>
			</div>
			<div className="min-h-0 flex-1 bg-white">
				<SketchCanvas strokes={ink.strokes} onStroke={(s) => setInk({ strokes: [...inkRef.current.strokes, s], redo: [] })} />
			</div>
			<div className="flex items-center gap-1 border-t px-3 py-2">
				<Button type="button" variant="ghost" size="icon" data-testid="sketch-undo" aria-label="Undo" disabled={empty} onClick={undo}>
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
					onClick={() => setInk({ strokes: [], redo: [] })}
				>
					<Trash2Icon className="size-4" />
				</Button>
				<span aria-hidden className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{error ?? (disabled ? "compacting session…" : "⌘↵ submits · esc closes")}
				</span>
				<Button
					type="button"
					data-testid="sketch-submit"
					disabled={empty || disabled}
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
