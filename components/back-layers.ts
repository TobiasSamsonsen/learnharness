import { useEffect, useRef } from "react";

/**
 * The "back" stack (Android shell, M8). Every surfaced layer that closes on
 * Esc (a drawer, the sketch view, a dialog, a popover) registers a close
 * handler while it is open; the topmost one answers a back press. A native
 * shell has no keyboard, and a synthetic Esc could reach dictation-cancel or
 * the abort dialog, so it dispatches `lh:back` instead and reads
 * `detail.handled`: true = a layer closed (the shell does nothing more),
 * false = nothing was open (the shell goes back in history, then exits).
 * Nothing here changes how Esc works.
 */
const stack: Array<() => void> = [];

/** Register a layer; returns its unregister. The newest layer is the topmost. */
export function registerBackLayer(close: () => void): () => void {
	stack.push(close);
	return () => {
		const i = stack.lastIndexOf(close);
		if (i >= 0) stack.splice(i, 1);
	};
}

/** Close the topmost layer; false when none is open. */
export function handleBack(): boolean {
	const top = stack[stack.length - 1];
	if (!top) return false;
	top();
	return true;
}

/** Register `close` as a back layer for as long as `open` is true. */
export function useBackLayer(open: boolean, close: () => void): void {
	// the latest `close` is called, so an inline handler never re-registers
	// the layer (and never moves it below a newer one)
	const latest = useRef(close);
	latest.current = close;
	useEffect(() => {
		if (!open) return;
		return registerBackLayer(() => latest.current());
	}, [open]);
}

if (typeof window !== "undefined") {
	window.addEventListener("lh:back", (e) => {
		const detail = (e as CustomEvent<{ handled?: boolean }>).detail;
		if (detail && handleBack()) detail.handled = true;
	});
}
