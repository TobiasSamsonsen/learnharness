"use client";

import { useRef } from "react";
import { RULER_THICKNESS, snapAngle, type Ruler } from "@/components/sketch/straight-line";
import { toScreen, toWorld, type SketchView } from "@/components/sketch/view-transform";

/**
 * The ruler (M16c, docs/android/m16-plan.md): a bar on the canvas to draw along. Drag the body to move it, drag an end to
 * turn and resize it (the angle snaps to 0, 45 and 90 degrees within 2.5). It lives in world coordinates, so it follows a
 * pan or a zoom; it is a drawing aid only and is never sent. A stroke drawn beside its edge is straightened onto it
 * (sketch-view.tsx, straight-line.ts rulerSnap). The body and the ends are touch holes for the native ink layer.
 */

const END_SNAP_DEG = 2.5;

export function SketchRuler({ ruler, view, onChange }: { ruler: Ruler; view: SketchView; onChange: (next: Ruler) => void }) {
	const box = useRef<HTMLDivElement | null>(null);
	const drag = useRef<{ kind: "body" | "a" | "b"; id: number; x: number; y: number } | null>(null);
	const a = toScreen(view, ruler.a.x, ruler.a.y);
	const b = toScreen(view, ruler.b.x, ruler.b.y);
	const length = Math.hypot(b.x - a.x, b.y - a.y);
	const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
	const shown = Math.round(((deg % 180) + 180) % 180) % 180;
	const upsideDown = Math.abs(deg) > 90;

	const start = (kind: "body" | "a" | "b") => (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		e.currentTarget.setPointerCapture(e.pointerId);
		drag.current = { kind, id: e.pointerId, x: e.clientX, y: e.clientY };
	};
	const move = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d || d.id !== e.pointerId) return;
		if (d.kind === "body") {
			const dx = (e.clientX - d.x) / view.zoom;
			const dy = (e.clientY - d.y) / view.zoom;
			d.x = e.clientX;
			d.y = e.clientY;
			onChange({ a: { x: ruler.a.x + dx, y: ruler.a.y + dy }, b: { x: ruler.b.x + dx, y: ruler.b.y + dy } });
			return;
		}
		// an end follows the pointer exactly (so the angle snap never sticks); the other end stays
		const rect = box.current?.getBoundingClientRect();
		const target = toWorld(view, e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0));
		const fixed = d.kind === "a" ? ruler.b : ruler.a;
		const end = snapAngle(fixed, target, END_SNAP_DEG);
		onChange(d.kind === "a" ? { a: end, b: ruler.b } : { a: ruler.a, b: end });
	};
	const end = (e: React.PointerEvent) => {
		if (drag.current?.id === e.pointerId) drag.current = null;
	};
	const handle = (kind: "a" | "b", at: { x: number; y: number }) => (
		<div
			data-ink-hole=""
			data-testid={`sketch-ruler-end-${kind}`}
			onPointerDown={start(kind)}
			onPointerMove={move}
			onPointerUp={end}
			onPointerCancel={end}
			style={{ left: at.x - 22, top: at.y - 22, touchAction: "none" }}
			className="pointer-events-auto absolute grid size-11 cursor-grab place-items-center"
		>
			<span aria-hidden className="size-5 rounded-full border-2 border-foreground/50 bg-background shadow" />
		</div>
	);

	return (
		<div ref={box} data-testid="sketch-ruler" className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
			<div
				data-ink-hole=""
				data-testid="sketch-ruler-body"
				onPointerDown={start("body")}
				onPointerMove={move}
				onPointerUp={end}
				onPointerCancel={end}
				style={{ left: a.x, top: a.y - RULER_THICKNESS / 2, width: length, height: RULER_THICKNESS, transform: `rotate(${deg}deg)`, transformOrigin: "0 50%", touchAction: "none" }}
				className="pointer-events-auto absolute cursor-move rounded-md border border-black/25 bg-amber-200/70 text-black/70 shadow-md"
			>
				<div aria-hidden className="absolute inset-x-0 top-0 h-2 opacity-60 [background:repeating-linear-gradient(90deg,currentColor_0_1px,transparent_1px_10px)]" />
				<span aria-hidden data-testid="sketch-ruler-angle" className="absolute inset-0 grid place-items-center text-[11px] font-medium" style={upsideDown ? { transform: "rotate(180deg)" } : undefined}>
					{shown}°
				</span>
			</div>
			{handle("a", a)}
			{handle("b", b)}
		</div>
	);
}
