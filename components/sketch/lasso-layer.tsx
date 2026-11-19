"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CopyIcon, ClipboardPasteIcon, Trash2Icon } from "lucide-react";
import { SKETCH_COLORS, SKETCH_WIDTHS } from "@/components/sketch/pen-settings";
import { displayInk, type SheetTone } from "@/components/sketch/sketch-sheet";
import { useViewGestures } from "@/components/sketch/use-view-gestures";
import { toScreen, toWorld, type ViewApi } from "@/components/sketch/view-transform";
import { boundsOf, compose, IDENTITY, isIdentity, lassoSelect, rotateAbout, scaleAbout, sketchStrokePath, translation, type Affine, type SketchStroke } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The lasso (owner plan, 2026-11-19): a layer over the canvas, in the web canvas and over the native ink alike. A loop around ink
 * selects it; the selection then moves (drag inside), scales (a corner) and turns (the top handle), and its bar copies, pastes,
 * deletes and restyles it. The selected strokes are drawn HERE (the canvas, or the shell, is handed the rest: sketch-view.tsx), so a
 * drag costs nothing but an SVG transform; only when it ends does the page record one operation. The layer is a touch hole
 * (data-ink-hole): the shell's pen never reaches it otherwise, and it takes the view gestures (pan, pinch, wheel) itself.
 */

const HANDLE = 22; // hit radius of a handle, px
const MIN_LOOP_PX = 12; // a loop shorter than this is a tap: it clears the selection

type Live =
	| { kind: "loop"; id: number; pts: number[] }
	| { kind: "move"; id: number; from: { x: number; y: number }; m: Affine }
	| { kind: "scale"; id: number; anchor: { x: number; y: number }; start: number; m: Affine }
	| { kind: "rotate"; id: number; center: { x: number; y: number }; start: number; m: Affine };

export interface LassoLayerProps {
	/** The page's working strokes (the selected ones are among them). */
	strokes: readonly SketchStroke[];
	selected: ReadonlySet<SketchStroke>;
	onSelect: (next: ReadonlySet<SketchStroke>) => void;
	/** The selection was moved, scaled or turned: the matrix, in world units. */
	onTransform: (m: Affine) => void;
	onRestyle: (style: { color?: string; size?: number }) => void;
	onDelete: () => void;
	onCopy: () => void;
	onPaste: () => void;
	canPaste: boolean;
	tone: SheetTone;
	viewApi: () => ViewApi | null;
}

const pathCache = new WeakMap<SketchStroke, string>();
const pathOf = (s: SketchStroke): string => {
	let p = pathCache.get(s);
	if (p === undefined) pathCache.set(s, (p = sketchStrokePath(s)));
	return p;
};

export function LassoLayer(p: LassoLayerProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [live, setLive] = useState<Live | null>(null);
	const liveRef = useRef<Live | null>(null);
	const penSeen = useRef(false);
	const pointers = useRef(new Set<number>());
	const [, redraw] = useReducer((n: number) => n + 1, 0);
	const latest = useRef(p);
	latest.current = p;
	const start = (next: Live | null) => {
		liveRef.current = next;
		setLive(next);
	};

	// follow the view (pan, zoom) without a render of the whole sketch view
	useEffect(() => p.viewApi()?.subscribe(redraw), [p]);
	useViewGestures(rootRef, () => p.viewApi()!.get(), (v) => p.viewApi()?.set(v), true);

	const view = p.viewApi()?.get() ?? { zoom: 1, x: 0, y: 0 };
	const chosen = useMemo(() => p.strokes.filter((s) => p.selected.has(s)), [p.strokes, p.selected]);
	const bounds = useMemo(() => boundsOf(chosen), [chosen]);
	const paths = useMemo(() => chosen.map(pathOf), [chosen]);

	const m = live && live.kind !== "loop" ? live.m : IDENTITY;
	const screen = (x: number, y: number) => toScreen(view, x, y);
	// the selection's frame: the bounds' corners through the live matrix, on screen
	const frame = (() => {
		if (!bounds) return null;
		const pad = 6 / view.zoom;
		const corners = [
			[bounds.x0 - pad, bounds.y0 - pad],
			[bounds.x1 + pad, bounds.y0 - pad],
			[bounds.x1 + pad, bounds.y1 + pad],
			[bounds.x0 - pad, bounds.y1 + pad],
		].map(([x, y]) => {
			const wx = m.a * x! + m.c * y! + m.e, wy = m.b * x! + m.d * y! + m.f;
			return screen(wx, wy);
		});
		const mid = { x: (corners[0]!.x + corners[1]!.x) / 2, y: (corners[0]!.y + corners[1]!.y) / 2 };
		const center = { x: (corners[0]!.x + corners[2]!.x) / 2, y: (corners[0]!.y + corners[2]!.y) / 2 };
		// the rotate handle sits 34 px out from the top edge's middle, away from the centre
		const dx = mid.x - center.x, dy = mid.y - center.y, len = Math.hypot(dx, dy) || 1;
		const rot = { x: mid.x + (dx / len) * 34, y: mid.y + (dy / len) * 34 };
		return { corners, mid, center, rot };
	})();

	const local = (e: React.PointerEvent) => {
		const r = rootRef.current!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};

	const onPointerDown = (e: React.PointerEvent) => {
		pointers.current.add(e.pointerId);
		if (e.pointerType === "pen") penSeen.current = true;
		// a second finger turns a one-finger loop into a pan or pinch: the gesture hook has them
		if (pointers.current.size > 1) {
			start(null);
			return;
		}
		if (e.pointerType === "touch" && penSeen.current) return; // a palm beside the pen
		if (e.pointerType === "mouse" && e.button !== 0) return;
		const pt = local(e);
		rootRef.current!.setPointerCapture(e.pointerId);
		const api = p.viewApi();
		if (!api) return;
		const v = api.get();
		if (frame && bounds) {
			const near = (a: { x: number; y: number }) => Math.hypot(a.x - pt.x, a.y - pt.y) <= HANDLE;
			if (near(frame.rot)) {
				const c = frame.center;
				start({ kind: "rotate", id: e.pointerId, center: toWorld(v, c.x, c.y), start: Math.atan2(pt.y - c.y, pt.x - c.x), m: IDENTITY });
				return;
			}
			const hit = frame.corners.findIndex(near);
			if (hit >= 0) {
				const opposite = frame.corners[(hit + 2) % 4]!;
				start({ kind: "scale", id: e.pointerId, anchor: toWorld(v, opposite.x, opposite.y), start: Math.hypot(pt.x - opposite.x, pt.y - opposite.y) || 1, m: IDENTITY });
				return;
			}
			if (insideQuad(pt, frame.corners)) {
				start({ kind: "move", id: e.pointerId, from: pt, m: IDENTITY });
				return;
			}
		}
		start({ kind: "loop", id: e.pointerId, pts: [pt.x, pt.y] });
	};

	const onPointerMove = (e: React.PointerEvent) => {
		const cur = liveRef.current;
		if (!cur || cur.id !== e.pointerId) return;
		const pt = local(e);
		const v = p.viewApi()?.get();
		if (!v) return;
		if (cur.kind === "loop") {
			start({ ...cur, pts: [...cur.pts, pt.x, pt.y] });
		} else if (cur.kind === "move") {
			start({ ...cur, m: translation((pt.x - cur.from.x) / v.zoom, (pt.y - cur.from.y) / v.zoom) });
		} else if (cur.kind === "scale") {
			const a = toScreen(v, cur.anchor.x, cur.anchor.y);
			const k = Math.min(20, Math.max(0.05, (Math.hypot(pt.x - a.x, pt.y - a.y) || 1) / cur.start));
			start({ ...cur, m: scaleAbout(cur.anchor.x, cur.anchor.y, k) });
		} else {
			const c = toScreen(v, cur.center.x, cur.center.y);
			start({ ...cur, m: rotateAbout(cur.center.x, cur.center.y, Math.atan2(pt.y - c.y, pt.x - c.x) - cur.start) });
		}
	};

	const finish = (e: React.PointerEvent, cancelled: boolean) => {
		pointers.current.delete(e.pointerId);
		const cur = liveRef.current;
		if (!cur || cur.id !== e.pointerId) return;
		start(null);
		if (cancelled) return;
		const props = latest.current;
		const v = props.viewApi()?.get();
		if (!v) return;
		if (cur.kind === "loop") {
			// a tap (or a tiny scribble) clears the selection; a loop selects what it surrounds
			let length = 0;
			for (let k = 2; k + 1 < cur.pts.length; k += 2) length += Math.hypot(cur.pts[k]! - cur.pts[k - 2]!, cur.pts[k + 1]! - cur.pts[k - 1]!);
			if (length < MIN_LOOP_PX) {
				if (props.selected.size > 0) props.onSelect(new Set());
				return;
			}
			const world: number[] = [];
			for (let k = 0; k + 1 < cur.pts.length; k += 2) {
				const w = toWorld(v, cur.pts[k]!, cur.pts[k + 1]!);
				world.push(w.x, w.y);
			}
			const hits = lassoSelect(props.strokes, world);
			props.onSelect(new Set(hits.map((i) => props.strokes[i]!)));
		} else if (!isIdentity(cur.m)) {
			props.onTransform(cur.m);
		}
	};

	const dragging = live !== null && live.kind !== "loop";
	const barAt = frame ? { x: Math.min(...frame.corners.map((c) => c.x)), y: Math.min(...frame.corners.map((c) => c.y), frame.rot.y) } : null;

	return (
		<div
			ref={rootRef}
			data-ink-hole=""
			data-testid="lasso-layer"
			className="absolute inset-0 z-10 cursor-crosshair"
			style={{ touchAction: "none" }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={(e) => finish(e, false)}
			onPointerCancel={(e) => finish(e, true)}
		>
			<svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
				{chosen.length > 0 && (
					<g data-testid="lasso-selection" transform={svgMatrix(view, m)}>
						{chosen.map((s, i) => (
							<path key={i} d={paths[i]} fill={displayInk(s.color, p.tone)} />
						))}
					</g>
				)}
				{frame && (
					<g>
						<polygon data-testid="lasso-frame" points={frame.corners.map((c) => `${c.x},${c.y}`).join(" ")} fill="rgba(37,99,235,0.06)" stroke="#2563eb" strokeWidth={1.5} strokeDasharray="6 4" />
						{!dragging || live?.kind === "scale" ? frame.corners.map((c, i) => <circle key={i} cx={c.x} cy={c.y} r={7} fill="#fff" stroke="#2563eb" strokeWidth={2} />) : null}
						<line x1={frame.mid.x} y1={frame.mid.y} x2={frame.rot.x} y2={frame.rot.y} stroke="#2563eb" strokeWidth={1.5} />
						<circle data-testid="lasso-rotate" cx={frame.rot.x} cy={frame.rot.y} r={8} fill="#fff" stroke="#2563eb" strokeWidth={2} />
					</g>
				)}
				{live?.kind === "loop" && live.pts.length >= 4 && (
					<polyline data-testid="lasso-loop" points={pairs(live.pts)} fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" />
				)}
			</svg>
			{!dragging && live?.kind !== "loop" && barAt && chosen.length > 0 && (
				<SelectionBar x={barAt.x} y={barAt.y} onCopy={p.onCopy} onDelete={p.onDelete} onPaste={p.onPaste} canPaste={p.canPaste} onRestyle={p.onRestyle} />
			)}
			{chosen.length === 0 && p.canPaste && live === null && (
				<div data-ink-hole="" className="absolute inset-x-0 bottom-6 flex justify-center">
					<button type="button" data-testid="lasso-paste" onPointerDown={(e) => e.stopPropagation()} onClick={p.onPaste} className="lh-touch inline-flex items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1.5 text-xs shadow-lg hover:bg-muted">
						<ClipboardPasteIcon className="size-4" />
						Paste
					</button>
				</div>
			)}
		</div>
	);
}

const pairs = (pts: number[]): string => {
	const out: string[] = [];
	for (let k = 0; k + 1 < pts.length; k += 2) out.push(`${pts[k]},${pts[k + 1]}`);
	return out.join(" ");
};

/** The SVG transform for strokes in world units: the view (world to screen), after the live matrix. */
function svgMatrix(view: { zoom: number; x: number; y: number }, live: Affine): string {
	const v: Affine = { a: view.zoom, b: 0, c: 0, d: view.zoom, e: -view.x * view.zoom, f: -view.y * view.zoom };
	const t = compose(v, live);
	return `matrix(${t.a} ${t.b} ${t.c} ${t.d} ${t.e} ${t.f})`;
}

function insideQuad(pt: { x: number; y: number }, c: { x: number; y: number }[]): boolean {
	let inside = false;
	for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
		const a = c[i]!, b = c[j]!;
		if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside;
}

function SelectionBar({ x, y, onCopy, onDelete, onPaste, canPaste, onRestyle }: { x: number; y: number; onCopy: () => void; onDelete: () => void; onPaste: () => void; canPaste: boolean; onRestyle: (s: { color?: string; size?: number }) => void }) {
	const btn = "lh-touch grid size-8 place-items-center rounded-full hover:bg-muted";
	return (
		<div
			data-ink-hole=""
			data-testid="lasso-bar"
			style={{ left: Math.max(8, x), top: Math.max(8, y - 52) }}
			className="absolute z-20 flex items-center gap-0.5 rounded-full border bg-background/95 px-1.5 py-1 shadow-lg backdrop-blur"
			onPointerDown={(e) => e.stopPropagation()}
		>
			<button type="button" data-testid="lasso-copy" aria-label="Copy" title="Copy" onClick={onCopy} className={btn}>
				<CopyIcon className="size-4" />
			</button>
			{canPaste && (
				<button type="button" data-testid="lasso-paste-bar" aria-label="Paste" title="Paste" onClick={onPaste} className={btn}>
					<ClipboardPasteIcon className="size-4" />
				</button>
			)}
			<button type="button" data-testid="lasso-delete" aria-label="Delete" title="Delete" onClick={onDelete} className={btn}>
				<Trash2Icon className="size-4" />
			</button>
			<span aria-hidden className="mx-1 h-5 w-px bg-border" />
			{SKETCH_COLORS.map((c) => (
				<button key={c.value} type="button" data-testid="lasso-color" aria-label={`${c.name} ink`} title={c.name} onClick={() => onRestyle({ color: c.value })} className={btn}>
					<span style={{ backgroundColor: c.value }} className="size-4 rounded-full border border-black/20" />
				</button>
			))}
			<span aria-hidden className="mx-1 h-5 w-px bg-border" />
			{SKETCH_WIDTHS.map((w) => (
				<button key={w.value} type="button" data-testid="lasso-width" aria-label={`${w.name} line`} title={w.name} onClick={() => onRestyle({ size: w.value })} className={btn}>
					<span style={{ height: w.value, width: 16 }} className={cn("rounded-full bg-foreground")} />
				</button>
			))}
		</div>
	);
}
