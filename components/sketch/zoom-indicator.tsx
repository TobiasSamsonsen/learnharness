"use client";

/**
 * The zoom, shown as a plain number at the bottom of the canvas (owner, 2026-10-29: "just keep the number, without anything
 * to press; pinch to zoom is enough"). It takes no touches at all, so a resting palm cannot hit it; it is shared by the web
 * canvas and the native-ink surface. The zoom itself is a pinch, the wheel, or Ctrl + wheel.
 */
export function ZoomIndicator({ zoomPct }: { zoomPct: number }) {
	return (
		<div
			aria-hidden
			data-testid="sketch-zoom-level"
			className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-background/70 px-2.5 py-0.5 text-xs text-muted-foreground tabular-nums"
		>
			{zoomPct}%
		</div>
	);
}
