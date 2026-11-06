"use client";

import { useEffect, useRef, type RefObject } from "react";
import { PinchTracker } from "@/components/sketch/pinch-gate";
import { panBy, pinchStep, zoomAbout, type SketchView } from "@/components/sketch/view-transform";

/**
 * The view gestures of an element that draws nothing itself (M13c): the native-ink surface, where the shell's layer
 * draws UNDER a transparent page. The wheel pans, Ctrl+wheel (a trackpad pinch) zooms about the cursor, the middle mouse
 * button drags the page, and two fingers pan and pinch. One finger does nothing (a palm beside the pen must not drag
 * the page), and neither does a palm: the pinch needs exactly two settled, fingertip-sized touches (pinch-gate.ts).
 * The web canvas follows the same rules through the same PinchTracker (sketch-canvas.tsx), where it also draws.
 *
 * `get` / `set` read and write the view; coordinates are relative to the element's top-left.
 */
export function useViewGestures(ref: RefObject<HTMLElement | null>, get: () => SketchView, set: (view: SketchView) => void, enabled: boolean): void {
	const latest = useRef({ get, set });
	latest.current = { get, set };
	useEffect(() => {
		const el = ref.current;
		if (!el || !enabled) return;
		const gate = new PinchTracker();
		let drag: { id: number; x: number; y: number } | null = null;
		const local = (e: PointerEvent) => {
			const r = el.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
			const { get, set } = latest.current;
			if (e.ctrlKey) {
				const r = el.getBoundingClientRect();
				set(zoomAbout(get(), Math.exp(-e.deltaY * unit * 0.01), e.clientX - r.left, e.clientY - r.top));
			} else {
				set(panBy(get(), -e.deltaX * unit, -e.deltaY * unit));
			}
		};
		const onDown = (e: PointerEvent) => {
			if (e.pointerType === "touch") {
				const p = local(e);
				gate.down(e.pointerId, p.x, p.y, e.width, e.height, performance.now()); // the pinch begins on a later move, once the touches pass the palm gate
				el.setPointerCapture?.(e.pointerId);
			} else if (e.pointerType === "mouse" && e.button === 1) {
				e.preventDefault();
				el.setPointerCapture?.(e.pointerId);
				drag = { id: e.pointerId, ...local(e) };
			}
		};
		const onMove = (e: PointerEvent) => {
			const { get, set } = latest.current;
			if (drag && drag.id === e.pointerId) {
				const p = local(e);
				set(panBy(get(), p.x - drag.x, p.y - drag.y));
				drag = { id: e.pointerId, ...p };
			} else {
				const p = local(e);
				const frame = gate.move(e.pointerId, p.x, p.y, e.width, e.height, performance.now());
				if (frame?.prev) set(pinchStep(get(), frame.prev, frame.next)); // the first ready move only sets the baseline: no jump
			}
		};
		const onUp = (e: PointerEvent) => {
			gate.up(e.pointerId); // whatever is left starts a fresh baseline
			if (drag?.id === e.pointerId) drag = null;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		el.addEventListener("pointerdown", onDown);
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
		el.addEventListener("pointercancel", onUp);
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("pointerdown", onDown);
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
			el.removeEventListener("pointercancel", onUp);
		};
	}, [ref, enabled]);
}
