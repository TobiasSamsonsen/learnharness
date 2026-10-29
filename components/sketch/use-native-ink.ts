"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { decodeShellLine, encodeInkOp, eraseHits, type NativeInkOp, type NativeInkRect, type NativeInkTool, type SketchStroke } from "@/src/core";
import { SKETCH_ERASER_RADIUS } from "@/components/sketch/sketch-canvas";
import { thinPath } from "@/components/sketch/view-transform";

/**
 * The native ink surface, web side (Android plan M10, docs/android/m10-plan.md). In the Android shell
 * `window.lhAndroid` exists (a WebMessageListener); with the "Native ink" setting on, the sketch view hands the
 * drawing to it: the shell shows an androidx.ink layer UNDER the (then transparent) page, and this hook keeps the two
 * in step. The web store stays the single owner of the strokes (owner decision B): the shell reports finished strokes
 * and eraser gestures, the web applies them through the same `addStroke` / `erase` the web canvas uses (so undo, redo,
 * clear, persistence, the kept page and the payload are unchanged), and pushes the finished set back when it changes
 * any other way. Wire format: src/core/ink-bridge.ts.
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
	/** The eraser's mode and radius (the shell only reports the gesture's points). */
	eraser?: { mode: "pixel" | "stroke"; radius: number };
	onStroke: (stroke: SketchStroke) => void;
	onErase: (indices: number[]) => void;
	/** A pixel-eraser gesture: its path, flat [x, y, …]. */
	onCut?: (path: number[], radius: number) => void;
}

export interface NativeInk {
	/** The native layer is in charge of drawing. */
	active: boolean;
	/** Why the shell could not show it (the web canvas is used instead), if it said. */
	fallback: string | null;
	/** The transparent scroller the page scrolls in (the shell draws under it). */
	scrollerRef: RefObject<HTMLDivElement | null>;
	onScroll: () => void;
	/** The canvas' height in CSS px (for the page's height). */
	viewHeight: number;
}

const rectOf = (el: Element): NativeInkRect => {
	const r = el.getBoundingClientRect();
	return { x: r.x, y: r.y, w: r.width, h: r.height };
};

export function useNativeInk(options: NativeInkOptions): NativeInk {
	// decided once per sketch view: the setting, and a shell that has the bridge
	const [bridge] = useState<LhAndroidBridge | null>(() => (nativeInkEnabled() ? nativeInkBridge() : null));
	const [fallback, setFallback] = useState<string | null>(null);
	const [viewHeight, setViewHeight] = useState(0);
	const active = bridge !== null && fallback === null;
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const latest = useRef(options);
	latest.current = options;
	const sentStrokes = useRef<readonly SketchStroke[]>([]);
	const ingested = useRef<SketchStroke | null>(null);
	const sendRef = useRef<(op: NativeInkOp) => void>(() => {});
	const frame = useRef(0);

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
			if (op.op === "open" || op.op === "holes" || op.op === "scroll" || op.op === "tool") {
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
			setViewHeight(rect.h);
			send({ op: "open", inkKey, rect });
		};
		const reportHoles = () => send({ op: "holes", rects: [...wrapper.querySelectorAll("[data-ink-hole]")].map(rectOf) });
		const reportAll = () => {
			reportRect();
			reportHoles();
		};
		reportAll();
		send({ op: "scroll", y: scrollerRef.current?.scrollTop ?? 0 });
		if (latest.current.pen) send({ op: "brush", ...latest.current.pen });

		const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(reportAll) : null;
		resize?.observe(wrapper);
		window.addEventListener("resize", reportAll);
		window.visualViewport?.addEventListener("resize", reportAll);
		// the floating box moves and collapses through style/class changes under the wrapper
		const mutations = typeof MutationObserver !== "undefined" ? new MutationObserver(reportHoles) : null;
		mutations?.observe(wrapper, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });

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
					if (o.eraser?.mode === "pixel" && o.onCut) {
						o.onCut(thinPath(shell.points, o.eraser.radius / 4), o.eraser.radius);
						break;
					}
					const hits = eraseHits(o.strokes, shell.points, o.eraser?.radius ?? SKETCH_ERASER_RADIUS);
					if (hits.length > 0) o.onErase(hits);
					break;
				}
				case "pan":
					if (scrollerRef.current) scrollerRef.current.scrollTop += shell.dy;
					break;
				case "fallback":
					setFallback(shell.reason);
					break;
				case "penseen":
					break; // the shell already switched to "touch scrolls"
			}
		};
		bridge.addEventListener("message", onMessage);

		return () => {
			bridge.removeEventListener("message", onMessage);
			resize?.disconnect();
			mutations?.disconnect();
			window.removeEventListener("resize", reportAll);
			window.visualViewport?.removeEventListener("resize", reportAll);
			cancelAnimationFrame(frame.current);
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
	const penColor = options.pen?.color;
	const penSize = options.pen?.size;
	useEffect(() => {
		if (active && penColor !== undefined && penSize !== undefined) sendRef.current({ op: "brush", color: penColor, size: penSize });
	}, [active, penColor, penSize]);

	const onScroll = () => {
		cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => sendRef.current({ op: "scroll", y: scrollerRef.current?.scrollTop ?? 0 }));
	};

	return { active, fallback, scrollerRef, onScroll, viewHeight };
}
