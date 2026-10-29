"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, EllipsisIcon, EraserIcon, MicIcon, MoonIcon, PenLineIcon, Redo2Icon, SendIcon, SunIcon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react";
import { ConfidenceButtons } from "@/components/confidence-buttons";
import { isDictationActive } from "@/components/dictation";
import { usePalmGuard } from "@/components/sketch/palm-guard";
import { SKETCH_BACKGROUNDS, type SketchBackground } from "@/components/sketch/sketch-background";
import type { SketchTool } from "@/components/sketch/sketch-canvas";
import { displayInk, type SheetTone } from "@/components/sketch/sketch-sheet";
import type { SketchStatus } from "@/components/sketch/sketch-status";
import { SKETCH_COLORS, SKETCH_ERASER_SIZES, SKETCH_WIDTHS, type EraserSettings, type PenSettings, type ToolbarPrefs } from "@/components/sketch/pen-settings";
import { cn } from "@/lib/utils";

/**
 * The sketch view's ONE top bar (owner, 2026-10-29, docs/android/m16-plan.md: a resting palm must hit nothing, so every
 * control lives at the top and the bottom edge is empty). It FLOATS over the canvas as a rounded pill (owner): close, undo,
 * redo, the pen and eraser, a "more" menu and Submit in a single row; tapping the active tool again opens its options
 * (colours and widths, or the eraser's mode and size) in a rounded card under the pill. The pill and the cards are touch
 * holes for the native ink layer (data-ink-hole), so a press on them never draws underneath. The bar folds to a small tab
 * (remembered), can fade while the pen is down, and ignores a palm (palm-guard.ts).
 */

export type SketchPanel = "pen" | "eraser" | "more" | null;

/** Where the floating bar sits: a little below the top edge, clear of the system inset. */
export const BAR_TOP = "top-[calc(0.5rem+var(--lh-safe-top))]";

/** Is a pen pressed on the screen right now (the web canvas; the Android shell's native layer does not report it yet)? */
export function usePenDown(): boolean {
	const [down, setDown] = useState(false);
	useEffect(() => {
		const on = (e: PointerEvent) => e.pointerType === "pen" && setDown(true);
		const off = (e: PointerEvent) => e.pointerType === "pen" && setDown(false);
		window.addEventListener("pointerdown", on, true);
		window.addEventListener("pointerup", off, true);
		window.addEventListener("pointercancel", off, true);
		return () => {
			window.removeEventListener("pointerdown", on, true);
			window.removeEventListener("pointerup", off, true);
			window.removeEventListener("pointercancel", off, true);
		};
	}, []);
	return down;
}

const barButton = "lh-touch relative grid size-9 shrink-0 place-items-center rounded-full text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40";
/** The cards under the pill: rounded, floating, as wide as a phone allows and no wider than a comfortable palette. */
const card = "pointer-events-auto absolute top-full left-1/2 mt-2 w-[min(28rem,calc(100vw-1rem))] -translate-x-1/2 rounded-2xl border bg-background/95 p-3 shadow-lg backdrop-blur";

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-1">
			<span className="w-14 shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</span>
			{children}
		</div>
	);
}

export interface SketchToolbarProps {
	tool: SketchTool;
	pen: PenSettings;
	eraser: EraserSettings;
	background: SketchBackground;
	tone: SheetTone;
canUndo: boolean;
	canRedo: boolean;
	canClear: boolean;
	/** Why Submit would do nothing right now (shown instead of a silent disabled button); null when it goes through. */
	submitBlock: string | null;
	/** A quiz answer is being given: the confidence buttons stand in for Submit. */
	asking: boolean;
	status: SketchStatus | null;
	prefs: ToolbarPrefs;
	panel: SketchPanel;
	/** The pen is down (auto-hide). */
	drawing: boolean;
	onPanel: (panel: SketchPanel) => void;
	onPrefs: (next: ToolbarPrefs) => void;
	onTool: (tool: SketchTool) => void;
	onPen: (next: PenSettings) => void;
	onEraser: (next: EraserSettings) => void;
	onBackground: (next: SketchBackground) => void;
	onToggleTone: () => void;
onClose: () => void;
	onUndo: () => void;
	onRedo: () => void;
	onClear: () => void;
	onSubmit: () => void;
	/** Submit pressed while it cannot go through: say why. */
	onSubmitBlocked: (reason: string) => void;
	onConfidence: (index: number) => void;
}

export function SketchToolbar(p: SketchToolbarProps) {
	const root = useRef<HTMLDivElement | null>(null);
	usePalmGuard(root);
	const { panel, onPanel } = p;
	// a press outside the bar closes the open panel
	useEffect(() => {
		if (!panel) return;
		const onDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) onPanel(null);
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [panel, onPanel]);

	const toolButton = (which: "pen" | "eraser") => {
		const active = p.tool === which;
		const name = which === "pen" ? "Pen" : "Eraser";
		return (
			<button
				type="button"
				data-testid={which === "pen" ? "sketch-tool-pen" : "sketch-eraser"}
				aria-label={name}
				aria-pressed={active}
				aria-expanded={active ? panel === which : undefined}
				title={active ? `${name} options` : name}
				onClick={() => {
					if (!active) {
						p.onTool(which);
						onPanel(null);
					} else onPanel(panel === which ? null : which);
				}}
				className={cn(barButton, active && "bg-accent")}
			>
				{which === "pen" ? <PenLineIcon className="size-4" /> : <EraserIcon className="size-4" />}
				{which === "pen" && (
					<span
						aria-hidden
						style={{ backgroundColor: displayInk(p.pen.color, p.tone) }}
						className="absolute right-1 bottom-1 size-2 rounded-full border border-black/20"
					/>
				)}
			</button>
		);
	};

	const hidden = p.prefs.autoHide && p.drawing;
	// the layer that places the bar: it takes no touches itself, only the pill and the cards do
	const place = cn("pointer-events-none absolute right-[calc(0.5rem+var(--lh-safe-right))] left-[calc(0.5rem+var(--lh-safe-left))] z-30 flex justify-center", BAR_TOP);

	if (p.prefs.collapsed) {
		return (
			<div data-testid="sketch-toolbar" className={place}>
				<div ref={root} className="relative">
					<button
						type="button"
						data-ink-hole=""
						data-testid="sketch-toolbar-expand"
						aria-label="Show the toolbar"
						title="Show the toolbar"
						onClick={() => p.onPrefs({ ...p.prefs, collapsed: false })}
						className="lh-touch pointer-events-auto grid h-7 w-16 place-items-center rounded-full border bg-background/95 text-muted-foreground shadow-lg backdrop-blur hover:text-foreground"
					>
						<ChevronDownIcon className="size-4" />
					</button>
				</div>
			</div>
		);
	}

	return (
		<div data-testid="sketch-toolbar" className={cn(place, "transition-opacity duration-150", hidden && "opacity-0")}>
			<div ref={root} className="relative">
				<div
					data-ink-hole=""
					className={cn(
						"flex items-center gap-0.5 rounded-full border bg-background/95 px-1.5 py-1 shadow-lg backdrop-blur",
						hidden ? "pointer-events-none" : "pointer-events-auto",
					)}
				>
					<button type="button" data-testid="sketch-close" aria-label="Close sketch" onClick={p.onClose} className={barButton}>
						<XIcon className="size-4" />
					</button>
					<button type="button" data-testid="sketch-undo" aria-label="Undo" disabled={!p.canUndo} onClick={p.onUndo} className={barButton}>
						<Undo2Icon className="size-4" />
					</button>
					<button type="button" data-testid="sketch-redo" aria-label="Redo" disabled={!p.canRedo} onClick={p.onRedo} className={barButton}>
						<Redo2Icon className="size-4" />
					</button>
					<span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
					{toolButton("pen")}
					{toolButton("eraser")}
					<button
						type="button"
						data-testid="sketch-more"
						aria-label="More"
						aria-expanded={panel === "more"}
						onClick={() => onPanel(panel === "more" ? null : "more")}
						className={cn(barButton, panel === "more" && "bg-accent")}
					>
						<EllipsisIcon className="size-4" />
					</button>
					{!p.asking && (
						<button
							type="button"
							data-testid="sketch-submit"
							aria-label="Submit sketch"
							aria-disabled={p.submitBlock !== null}
							title={p.submitBlock ?? "Submit sketch (⌘↵)"}
							onClick={() => (p.submitBlock ? p.onSubmitBlocked(p.submitBlock) : p.onSubmit())}
							className={cn(
								"lh-touch ml-1 inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-opacity hover:bg-primary/90",
								p.submitBlock !== null && "opacity-50",
							)}
						>
							<SendIcon className="size-4" />
							<span className="max-[480px]:hidden">Submit</span>
						</button>
					)}
				</div>

				{panel && !hidden && (
					<div data-ink-hole="" data-testid={`sketch-panel-${panel}`} className={cn(card, "flex flex-col gap-1.5")}>
						{panel === "pen" && (
							<>
								<PanelSection title="Ink">
									{SKETCH_COLORS.map((c) => (
										<button
											key={c.value}
											type="button"
											data-testid={`sketch-color-${c.name.toLowerCase()}`}
											aria-label={`${c.name} ink`}
											aria-pressed={p.tool === "pen" && p.pen.color === c.value}
											onClick={() => p.onPen({ ...p.pen, color: c.value })}
											className="lh-touch grid size-8 shrink-0 place-items-center rounded-full"
										>
											<span
												aria-hidden
												style={{ backgroundColor: displayInk(c.value, p.tone) }}
												className={cn("size-5 rounded-full border border-black/10", p.tool === "pen" && p.pen.color === c.value && "ring-2 ring-ring ring-offset-2 ring-offset-background")}
											/>
										</button>
									))}
								</PanelSection>
								<PanelSection title="Width">
									{SKETCH_WIDTHS.map((w) => (
										<button
											key={w.value}
											type="button"
											data-testid={`sketch-width-${w.name.toLowerCase()}`}
											aria-label={`${w.name} pen`}
											aria-pressed={p.tool === "pen" && p.pen.size === w.value}
											onClick={() => p.onPen({ ...p.pen, size: w.value })}
											className={cn("lh-touch grid size-8 shrink-0 place-items-center rounded-full", p.tool === "pen" && p.pen.size === w.value && "bg-accent")}
										>
											<span aria-hidden style={{ width: w.value + 4, height: w.value + 4 }} className="rounded-full bg-foreground" />
										</button>
									))}
								</PanelSection>
							</>
						)}
						{panel === "eraser" && (
							<>
								<PanelSection title="Mode">
									{(["pixel", "stroke"] as const).map((mode) => (
										<button
											key={mode}
											type="button"
											data-testid={`sketch-erase-${mode}`}
											aria-label={mode === "pixel" ? "Erase part of a stroke" : "Erase whole strokes"}
											aria-pressed={p.eraser.mode === mode}
											onClick={() => p.onEraser({ ...p.eraser, mode })}
											className={cn("lh-touch shrink-0 rounded-full px-3 text-xs font-medium", p.eraser.mode === mode ? "bg-accent" : "text-muted-foreground")}
										>
											{mode === "pixel" ? "Part" : "Stroke"}
										</button>
									))}
								</PanelSection>
								<PanelSection title="Size">
									{SKETCH_ERASER_SIZES.map((z) => (
										<button
											key={z.value}
											type="button"
											data-testid={`sketch-erase-size-${z.name.toLowerCase()}`}
											aria-label={`${z.name} eraser`}
											aria-pressed={p.eraser.radius === z.value}
											onClick={() => p.onEraser({ ...p.eraser, radius: z.value })}
											className={cn("lh-touch grid size-8 shrink-0 place-items-center rounded-full", p.eraser.radius === z.value && "bg-accent")}
										>
											<span aria-hidden style={{ width: z.value / 2 + 4, height: z.value / 2 + 4 }} className="rounded-full border border-foreground/60" />
										</button>
									))}
								</PanelSection>
							</>
						)}
						{panel === "more" && (
							<>
								<PanelSection title="Paper">
									{SKETCH_BACKGROUNDS.map((b) => (
										<button
											key={b}
											type="button"
											data-testid={`sketch-paper-${b}`}
											aria-label={`Paper: ${b}`}
											aria-pressed={p.background === b}
											onClick={() => p.onBackground(b)}
											className={cn("lh-touch shrink-0 rounded-full px-3 text-xs font-medium capitalize", p.background === b ? "bg-accent" : "text-muted-foreground")}
										>
											{b}
										</button>
									))}
								</PanelSection>
								<PanelSection title="Sheet">
									<button
										type="button"
										data-testid="sketch-sheet-tone"
										aria-label={`Sheet: ${p.tone}`}
										title={p.tone === "dark" ? "Switch to a light sheet" : "Switch to a dark sheet"}
										aria-pressed={p.tone === "dark"}
										onClick={p.onToggleTone}
										className={cn("lh-touch inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium", p.tone === "dark" && "bg-accent")}
									>
										{p.tone === "dark" ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
										{p.tone === "dark" ? "Dark" : "Light"}
									</button>
								</PanelSection>
<PanelSection title="Bar">
									<button
										type="button"
										data-testid="sketch-toolbar-collapse"
										aria-label="Hide the toolbar"
										onClick={() => {
											onPanel(null);
											p.onPrefs({ ...p.prefs, collapsed: true });
										}}
										className="lh-touch inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium hover:bg-accent"
									>
										<ChevronUpIcon className="size-4" />
										Hide the bar
									</button>
									<button
										type="button"
										role="switch"
										data-testid="sketch-autohide"
										aria-checked={p.prefs.autoHide}
										onClick={() => p.onPrefs({ ...p.prefs, autoHide: !p.prefs.autoHide })}
										className={cn("lh-touch shrink-0 rounded-full px-3 text-xs font-medium", p.prefs.autoHide ? "bg-accent" : "text-muted-foreground")}
									>
										Hide while drawing: {p.prefs.autoHide ? "on" : "off"}
									</button>
								</PanelSection>
								<PanelSection title="Page">
									<button
										type="button"
										data-testid="sketch-clear"
										aria-label="Clear"
										disabled={!p.canClear}
										onClick={() => {
											onPanel(null);
											p.onClear();
										}}
										className="lh-touch inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
									>
										<Trash2Icon className="size-4" />
										Clear
									</button>
									<SketchMic />
								</PanelSection>
							</>
						)}
					</div>
				)}

				{p.asking && (
					<div data-ink-hole="" className={card}>
						<ConfidenceButtons onPick={p.onConfidence} testidPrefix="sketch-confidence" className="min-w-0" />
					</div>
				)}

				{p.status && !p.asking && !panel && (
					<div
						role={p.status.kind === "error" ? "alert" : "status"}
						data-testid="sketch-status"
						className={cn(
							"pointer-events-none absolute top-full left-1/2 mt-2 w-max max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-full border bg-background/95 px-3.5 py-1 text-xs shadow-md backdrop-blur",
							p.status.kind === "error" ? "text-destructive" : p.status.kind === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
						)}
					>
						{p.status.text}
					</div>
				)}
			</div>
		</div>
	);
}

/** The mic: the app's own dictation toggle (⌘D), no new claim; the text lands in the dock's field exactly as with the key. */
function SketchMic() {
	const [live, setLive] = useState(isDictationActive());
	useEffect(() => {
		const t = window.setInterval(() => setLive(isDictationActive()), 250);
		return () => window.clearInterval(t);
	}, []);
	return (
		<button
			type="button"
			data-testid="sketch-mic"
			aria-label={live ? "Stop dictation" : "Start dictation"}
			aria-pressed={live}
			onClick={() => window.dispatchEvent(new CustomEvent("lh:kbd-toggle-dictation"))}
			className={cn("lh-touch inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium hover:bg-accent", live && "bg-destructive/10 text-destructive hover:bg-destructive/20")}
		>
			<MicIcon className="size-4" />
			{live ? "Stop dictation" : "Dictate"}
		</button>
	);
}
