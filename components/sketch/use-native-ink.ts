"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { decodeShellLine, encodeInkOp, eraseHits, type NativeInkOp, type NativeInkRect, type NativeInkTool, type SketchStroke } from "@/src/core";
import { SKETCH_ERASER_RADIUS } from "@/components/sketch/sketch-canvas";
import { useViewGestures } from "@/components/sketch/use-view-gestures";
import { eraserWorldRadius, fitInk, HOME_VIEW, panBy, roundView, thinPath, zoomAbout, type SketchView } from "@/components/sketch/view-transform";

/**
 * The native ink surface, web side (Android plan M10, docs/android/m10-plan.md). In the Android shell
 * `window.lhAndroid` exists (a WebMessageListener); with the "Native ink" setting on, the sketch view hands the
 * drawing to it: the shell shows an androidx.ink layer UNDER the (then transparent) page, and this hook keeps the two
 * in step. The web store stays the single owner of the strokes (owner decision B): the shell reports finished strokes
 * and eraser gestures, the web applies them through the same `addStroke` / `erase` the web canvas uses (so undo, redo,
 * clear, persistence, the kept page and the payload are unchanged), and pushes the finished set back when it changes
 * any other way. Wire format: src/core/ink-bridge.ts.
 *
 * Since M13c the canvas is infinite and zoomable, and the web owns the VIEW the same way: the shell reports two-finger
 * gestures (`gesture`), this hook turns them (and the wheel, a mouse drag and the zoom buttons) into the new view and
 * sends it back (`view`); the shell draws through it and reports points already in world coordinates.
 */

/** The shell's side of `window.lhAndroid` (a WebMessageListener's JS object). */
export interface LhAndroidBridge {
	postMessage(message: string): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** The shell's bridge, or null (a plain browser, an older shell). */
export function nativeInkBridge(): LhAndroidBridge | null {
	if (typeof window === "undefined") return null;
	const bridge = (window as unknown as { lhAndroid?: Partial<LhAndroidBridge> }).lhAndroid;
	return bridge && typeof bridge.postMessage === "function" && typeof bridge.addEventListener === "function" ? (bridge as LhAndroidBridge) : null;
}

export const NATIVE_INK_KEY = "lh:native-ink";

/** The "Native ink" setting (per browser). ON by default in the Android shell (owner, 2026-10-27, after the
 *  hands-on test: the line stays under the stylus); off only when the learner turned it off. It only matters where
 *  the shell's bridge exists, so a plain browser is unaffected. */
export function nativeInkEnabled(): boolean {
	try {
		return localStorage.getItem(NATIVE_INK_KEY) !== "off";
	} catch {
		return true;
	}
}

export function setNativeInkEnabled(on: boolean): void {
	try {
		localStorage.setItem(NATIVE_INK_KEY, on ? "on" : "off");
	} catch {
		/* private mode: the switch just does not stick */
	}
}

export interface NativeInkOptions {
	inkKey: string;
	/** The canvas wrapper: the native layer sits exactly on its rectangle. */
	wrapperRef: RefObject<HTMLElement | null>;
	strokes: readonly SketchStroke[];
	kept: readonly SketchStroke[] | undefined;
	tool: NativeInkTool;
	/** The pen's colour and width: the shell draws and reports the next strokes with it. */
	pen?: { color: string; size: number };
	/** The sheet's tone: the shell draws its paper and ink in the tone's colours. */
	tone?: "light" | "dark";
	/** The eraser's mode and radius, on screen (the shell only reports the gesture's points). */
	eraser?: { mode: "pixel" | "stroke"; radius: number };
	onStroke: (stroke: SketchStroke) => void;
	onErase: (indices: number[]) => void;
	/** A pixel-eraser gesture: its path, flat [x, y, …], and the eraser's radius, both in world units. */
	onCut?: (path: number[], radius: number) => void;
}

export interface NativeInk {
	/** The native layer is in charge of drawing. */
	active: boolean;
	/** Why the shell could not show it (the web canvas is used instead), if it said. */
	fallback: string | null;
	/** A transparent surface over the canvas: the wheel, a mouse drag and two fingers land here (the shell draws under it). */
	surfaceRef: RefObject<HTMLDivElement | null>;
	/** The zoom, in percent, for the zoom buttons. */
	zoomPct: number;
	/** The view now (for what the page draws over the shell's ink, like the paper). */
	view: SketchView;
	zoomBy: (factor: number) => void;
	/** Back to the ink: the home view when it fits, else a view that shows all of it. */
	resetView: () => void;
}

const rectOf = (el: Element): NativeInkRect => {
	const r = el.getBoundingClientRect();
	return { x: r.x, y: r.y, w: r.width, h: r.height };
};

export function useNativeInk(options: NativeInkOptions): NativeInk {
	// decided once per sketch view: the setting, and a shell that has the bridge
	const [bridge] = useState<LhAndroidBridge | null>(() => (nativeInkEnabled() ? nativeInkBridge() : null));
	const [fallback, setFallback] = useState<string | null>(null);
	const active = bridge !== null && fallback === null;
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const latest = useRef(options);
	latest.current = options;
	const sentStrokes = useRef<readonly SketchStroke[]>([]);
	const ingested = useRef<SketchStroke | null>(null);
	const sendRef = useRef<(op: NativeInkOp) => void>(() => {});
	const view = useRef<SketchView>(HOME_VIEW);
	const size = useRef({ w: 0, h: 0 });
	const fitted = useRef(false);
	const [zoomPct, setZoomPct] = useState(100);
	const [viewState, setViewState] = useState<SketchView>(HOME_VIEW);

	/** Adopt a view (as the shell will hold it) and tell the shell. */
	const applyView = (next: SketchView) => {
		const v = roundView(next);
		view.current = v;
		setZoomPct(Math.round(v.zoom * 100));
		setViewState(v);
		sendRef.current({ op: "view", ...v });
	};
	const fitAll = () => {
		const o = latest.current;
		return fitInk([...(o.kept ?? []), ...o.strokes].map((s) => s.points), size.current.w, size.current.h);
	};
	useViewGestures(surfaceRef, () => view.current, applyView, active);

	const { inkKey, wrapperRef } = options;
	useEffect(() => {
		if (!bridge || fallback !== null) return;
		const wrapper = wrapperRef.current;
		if (!wrapper) return;
		const lines = new Map<string, string>();
		const send = (op: NativeInkOp) => {
			// a repeated geometry line (a resize that changed nothing the shell cares about) is not sent twice;
			// stroke sets are never deduplicated: an undo can return to an earlier set the shell no longer shows
			const line = encodeInkOp(op);
			if (op.op === "open" || op.op === "holes" || op.op === "view" || op.op === "tool") {
				if (lines.get(op.op) === line) return;
				lines.set(op.op, line);
			}
			try {
				bridge.postMessage(line);
			} catch {
				/* the shell is gone: the page keeps working */
			}
		};
		sendRef.current = send;
		sentStrokes.current = [];
		document.documentElement.classList.add("lh-native-ink");

		const reportRect = () => {
			const rect = rectOf(wrapper);
			size.current = { w: rect.w, h: rect.h };
			send({ op: "open", inkKey, rect });
		};
		// holes anywhere in the view: the floating box and the zoom buttons sit inside the wrapper, the top bar's option panels over it
		const scope = wrapper.parentElement ?? wrapper;
		const reportHoles = () => send({ op: "holes", rects: [...scope.querySelectorAll("[data-ink-hole]")].map(rectOf) });
		const reportAll = () => {
			reportRect();
			reportHoles();
		};
		reportAll();
		// the first time, open on the ink (the home view when it fits)
		if (!fitted.current && size.current.w > 0 && size.current.h > 0) {
			fitted.current = true;
			view.current = roundView(fitAll());
			setZoomPct(Math.round(view.current.zoom * 100));
			setViewState(view.current);
		}
		send({ op: "view", ...view.current });
		if (latest.current.pen) send({ op: "brush", ...latest.current.pen });
		if (latest.current.tone) send({ op: "sheet", tone: latest.current.tone });

		const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(reportAll) : null;
		resize?.observe(wrapper);
		window.addEventListener("resize", reportAll);
		window.visualViewport?.addEventListener("resize", reportAll);
		// the floating box moves and collapses through style/class changes under the wrapper
		const mutations = typeof MutationObserver !== "undefined" ? new MutationObserver(reportHoles) : null;
		mutations?.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });

		const onMessage = (event: { data: unknown }) => {
			const shell = decodeShellLine(String(event.data));
			if (!shell) return;
			const o = latest.current;
			switch (shell.kind) {
				case "stroke":
					ingested.current = shell.stroke;
					o.onStroke(shell.stroke);
					break;
				case "erase": {
					// the radius is chosen on screen; the points arrive in world units
					const radius = eraserWorldRadius(o.eraser?.radius ?? SKETCH_ERASER_RADIUS, view.current.zoom);
					if (o.eraser?.mode === "pixel" && o.onCut) {
						o.onCut(thinPath(shell.points, radius / 4), radius);
						break;
					}
					const hits = eraseHits(o.strokes, shell.points, radius);
					if (hits.length > 0) o.onErase(hits);
					break;
				}
				case "gesture":
					// two fingers: zoom about where they were, then follow their midpoint
					applyView(panBy(zoomAbout(view.current, shell.scale, shell.fx - shell.dx, shell.fy - shell.dy), shell.dx, shell.dy));
					break;
				case "fallback":
					setFallback(shell.reason);
					break;
				case "penseen":
					break; // the shell already switched to "touch goes to the page"
			}
		};
		bridge.addEventListener("message", onMessage);

		return () => {
			bridge.removeEventListener("message", onMessage);
			resize?.disconnect();
			mutations?.disconnect();
			window.removeEventListener("resize", reportAll);
			window.visualViewport?.removeEventListener("resize", reportAll);
			send({ op: "close" });
			document.documentElement.classList.remove("lh-native-ink");
			sendRef.current = () => {};
		};
	}, [bridge, fallback, inkKey, wrapperRef]);

	// the strokes: an append of the stroke the shell just reported is only acknowledged; any other change is pushed whole
	const { strokes, kept, tool } = options;
	useEffect(() => {
		if (!active) return;
		const prev = sentStrokes.current;
		const appended =
			strokes.length === prev.length + 1 && prev.every((s, i) => strokes[i] === s) && strokes[strokes.length - 1] === ingested.current;
		sendRef.current(appended ? { op: "ack" } : { op: "strokes", strokes });
		if (appended) ingested.current = null; // used once: a redo of the same stroke must be pushed whole
		sentStrokes.current = strokes;
	}, [active, strokes]);
	useEffect(() => {
		if (active) sendRef.current({ op: "kept", strokes: kept ?? [] });
	}, [active, kept]);
	useEffect(() => {
		if (active) sendRef.current({ op: "tool", tool });
	}, [active, tool]);
	const sheetTone = options.tone;
	useEffect(() => {
		if (active && sheetTone) sendRef.current({ op: "sheet", tone: sheetTone });
	}, [active, sheetTone]);
	const penColor = options.pen?.color;
	const penSize = options.pen?.size;
	useEffect(() => {
		if (active && penColor !== undefined && penSize !== undefined) sendRef.current({ op: "brush", color: penColor, size: penSize });
	}, [active, penColor, penSize]);

	return {
		active,
		fallback,
		surfaceRef,
		zoomPct,
		view: viewState,
		zoomBy: (factor) => applyView(zoomAbout(view.current, factor, size.current.w / 2, size.current.h / 2)),
		resetView: () => applyView(fitAll()),
	};
}
