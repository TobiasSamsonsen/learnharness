"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { paperCovers, paperCss, paperTransform, PAPER_PAD, type SketchBackground } from "@/components/sketch/sketch-background";
import type { SketchView } from "@/components/sketch/view-transform";

/** How long the view must be still before the paper is drawn again for it (sharp at the exact view). */
const SETTLE_MS = 140;

/**
 * The paper under the native ink (the shell draws under a transparent page, so the page draws the paper). It is drawn for a "base" view
 * on an element that overhangs the canvas by a quarter of its size on every side; while the view pans or zooms, the element is only
 * moved and scaled with a compositor transform (no raster, no React render), and the paper is drawn again for the new view once the
 * view is still, or sooner when it has left the element or the zoom has moved far (sketch-background.ts, `paperCovers`). Before this,
 * every pan or zoom event re-rastered the CSS gradients at a new size (measured 2026-11-07: about a third of a core on the GPU thread).
 */
export function NativePaper({
	kind,
	tone,
	size,
	viewRef,
	onView,
}: {
	kind: SketchBackground;
	tone: "light" | "dark";
	/** The paper's spacing step (PAPER_SIZES entry). */
	size: number;
	viewRef: RefObject<SketchView>;
	onView: (listener: (view: SketchView) => void) => () => void;
}) {
	const el = useRef<HTMLDivElement>(null);
	const box = useRef({ w: 0, h: 0 });
	const [base, setBase] = useState<SketchView>(() => viewRef.current);
	const baseRef = useRef(base);
	baseRef.current = base;
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const place = (v: SketchView) => {
		const node = el.current;
		if (!node) return;
		const t = paperTransform(baseRef.current, v, box.current.w * PAPER_PAD, box.current.h * PAPER_PAD);
		node.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
	};

	// the canvas' size (the element's parent), for the overhang: at mount and when it changes
	useLayoutEffect(() => {
		const parent = el.current?.parentElement;
		if (!parent) return;
		const measure = () => {
			const r = parent.getBoundingClientRect();
			if (r.width === box.current.w && r.height === box.current.h) return;
			box.current = { w: r.width, h: r.height };
			setBase(viewRef.current); // the overhang changed: draw the paper again
		};
		measure();
		const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
		observer?.observe(parent);
		return () => observer?.disconnect();
	}, [viewRef]);

	// the paper was drawn again (or the canvas resized): the element sits at the view now
	useLayoutEffect(() => {
		place(viewRef.current);
	}, [base, kind, tone, size, viewRef]);

	useEffect(() => {
		const off = onView((v) => {
			const { w, h } = box.current;
			if (!paperCovers(baseRef.current, v, w * PAPER_PAD, h * PAPER_PAD, w, h)) {
				clearTimeout(timer.current);
				setBase(v);
				return;
			}
			place(v);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setBase(viewRef.current), SETTLE_MS);
		});
		return () => {
			off();
			clearTimeout(timer.current);
		};
	}, [onView, viewRef]);

	const padX = box.current.w * PAPER_PAD;
	const padY = box.current.h * PAPER_PAD;
	// the clip keeps the overhang (which is what a pan moves over) from painting outside the canvas
	return (
		<div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
			<div
				ref={el}
				data-testid="sketch-native-paper"
				style={{
					...(kind === "none" ? {} : paperCss(kind, base, tone, size, padX, padY)),
					inset: `${-PAPER_PAD * 100}%`,
					transformOrigin: "0 0",
					willChange: "transform",
				}}
				className="pointer-events-none absolute"
			/>
		</div>
	);
}
