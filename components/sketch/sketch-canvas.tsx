"use client";

import { useEffect, useRef } from "react";
import { SKETCH_INK, sketchStrokePath, type SketchStroke } from "@/src/core";

/**
 * The web canvas (Android plan M1): a plain white page the learner draws
 * on with a pen, mouse or finger. Strokes are vector data — flat
 * [x, y, pressure] in canvas CSS pixels — drawn as perfect-freehand
 * outlines with the SAME path function the server render uses
 * (core/sketch.ts sketchStrokePath), so what the learner sees is what the
 * model sees.
 *
 * Pen-only once a pen is seen (palm rejection for stylus users): after the
 * first pen stroke, touch input is ignored. Coalesced events give every
 * sample the hardware delivered (subscripts and integrals need them).
 */

/** Base stroke diameter, CSS pixels. */
export const SKETCH_PEN_SIZE = 4;

export function SketchCanvas({
	strokes,
	onStroke,
}: {
	strokes: readonly SketchStroke[];
	/** A finished stroke (pointer up). */
	onStroke: (stroke: SketchStroke) => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const live = useRef<{ pointerId: number; points: number[] } | null>(null);
	const penSeen = useRef(false);
	// Path2D per finished stroke — redraws stay cheap on a busy page.
	const paths = useRef(new WeakMap<SketchStroke, Path2D>());
	const strokesRef = useRef(strokes);
	strokesRef.current = strokes;

	const draw = () => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
		for (const s of strokesRef.current) {
			let p = paths.current.get(s);
			if (!p) {
				p = new Path2D(sketchStrokePath(s));
				paths.current.set(s, p);
			}
			ctx.fillStyle = s.color ?? SKETCH_INK;
			ctx.fill(p);
		}
		if (live.current && live.current.points.length >= 3) {
			ctx.fillStyle = SKETCH_INK;
			ctx.fill(new Path2D(sketchStrokePath({ size: SKETCH_PEN_SIZE, points: live.current.points })));
		}
	};

	// Size the backing store to the element (and the screen's density).
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const fit = () => {
			const dpr = window.devicePixelRatio || 1;
			const { width, height } = canvas.getBoundingClientRect();
			canvas.width = Math.max(1, Math.round(width * dpr));
			canvas.height = Math.max(1, Math.round(height * dpr));
			draw();
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(canvas);
		return () => observer.disconnect();
	}, []); // draw reads refs only

	useEffect(draw, [strokes]);

	const accepts = (e: React.PointerEvent) => {
		if (e.pointerType === "pen") penSeen.current = true;
		return !(penSeen.current && e.pointerType === "touch");
	};

	const sample = (e: PointerEvent, out: number[]) => {
		const rect = canvasRef.current!.getBoundingClientRect();
		// Mice and fingers report no real pressure: a steady middle value.
		const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
		out.push(Math.round((e.clientX - rect.left) * 10) / 10, Math.round((e.clientY - rect.top) * 10) / 10, Math.round(pressure * 100) / 100);
	};

	return (
		<canvas
			ref={canvasRef}
			data-testid="sketch-canvas"
			className="block size-full touch-none cursor-crosshair"
			onPointerDown={(e) => {
				if (e.button !== 0 || !accepts(e) || live.current) return;
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				const points: number[] = [];
				sample(e.nativeEvent, points);
				live.current = { pointerId: e.pointerId, points };
				draw();
			}}
			onPointerMove={(e) => {
				if (!live.current || live.current.pointerId !== e.pointerId) return;
				const native = e.nativeEvent;
				const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
				for (const ev of events.length > 0 ? events : [native]) sample(ev, live.current.points);
				draw();
			}}
			onPointerUp={(e) => {
				if (!live.current || live.current.pointerId !== e.pointerId) return;
				const { points } = live.current;
				live.current = null;
				onStroke({ size: SKETCH_PEN_SIZE, points });
			}}
			onPointerCancel={(e) => {
				// The OS took the pointer (a palm, a gesture): drop the stroke.
				if (!live.current || live.current.pointerId !== e.pointerId) return;
				live.current = null;
				draw();
			}}
		/>
	);
}
