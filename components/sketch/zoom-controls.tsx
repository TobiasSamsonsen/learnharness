"use client";

import { useRef } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { usePalmGuard } from "@/components/sketch/palm-guard";

/** The zoom buttons' step. */
export const ZOOM_STEP = 1.25;

/**
 * Zoom out, the zoom shown (pressing it goes back to the ink), zoom in — the
 * touch and mouse way to zoom the infinite canvas (M13c), shared by the web
 * canvas and the native-ink surface. It floats over the canvas' TOP right corner, under the floating bar (M16: nothing at the bottom edge, where a
 * resting palm lands) and only its buttons take pointers.
 */
export function ZoomControls({ zoomPct, onZoom, onReset }: { zoomPct: number; onZoom: (factor: number) => void; onReset: () => void }) {
const ref = useRef<HTMLDivElement | null>(null);
usePalmGuard(ref); // a palm resting near the pen must not zoom
return (
<div ref={ref} data-ink-hole="" className="pointer-events-none absolute top-[4.25rem] right-2 flex items-center gap-0.5 rounded-md border bg-background/90 p-0.5 text-xs shadow-sm">
			<button type="button" data-testid="sketch-zoom-out" aria-label="Zoom out" onClick={() => onZoom(1 / ZOOM_STEP)} className="lh-touch pointer-events-auto grid size-8 place-items-center rounded">
				<MinusIcon className="size-4" />
			</button>
			<button type="button" data-testid="sketch-zoom-reset" aria-label="Reset zoom" onClick={onReset} className="lh-touch pointer-events-auto h-8 min-w-12 rounded px-1 tabular-nums">
				{zoomPct}%
			</button>
			<button type="button" data-testid="sketch-zoom-in" aria-label="Zoom in" onClick={() => onZoom(ZOOM_STEP)} className="lh-touch pointer-events-auto grid size-8 place-items-center rounded">
				<PlusIcon className="size-4" />
			</button>
		</div>
	);
}
