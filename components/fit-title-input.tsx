"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * The course title that never clips (owner, 2026-11-14): large, shrinking to fit its width down to a floor, and only
 * when it is still too long at the floor does it wrap, onto at most MAX_LINES lines (then it scrolls inside the box).
 * One field, so renaming works as before.
 */

/** The title's largest and smallest font size, in CSS px. */
export const TITLE_MAX_PX = 30;
export const TITLE_MIN_PX = 16;
/** The most lines the title wraps onto at the smallest size. */
export const TITLE_MAX_LINES = 3;

/**
 * The font size (px) at which a title fits one line: the text's width at `max` scaled to the room there is, kept
 * between `min` and `max`. Unknown widths give `max`. Pure.
 */
export function fitFontPx(widthAtMax: number, available: number, max = TITLE_MAX_PX, min = TITLE_MIN_PX): number {
	if (!(widthAtMax > 0) || !(available > 0)) return max;
	return Math.max(min, Math.min(max, Math.floor((max * available) / widthAtMax)));
}

export function FitTitleInput({ value, className, style, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const [px, setPx] = useState(TITLE_MAX_PX);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const fit = () => {
			const cs = getComputedStyle(el);
			const ctx = document.createElement("canvas").getContext("2d");
			if (ctx) {
				ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${TITLE_MAX_PX}px ${cs.fontFamily}`;
				const text = value !== "" ? value : (el.placeholder ?? "");
				const available = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - 2;
				setPx(fitFontPx(ctx.measureText(text).width, available));
			}
			// grow to the wrapped height (one line unless the title is too long even at the smallest size), capped
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(el);
		void document.fonts?.ready.then(fit);
		return () => observer.disconnect();
	}, [value, px]);

	return (
		<textarea
			ref={ref}
			rows={1}
			value={value}
			spellCheck={false}
			style={{ ...style, fontSize: px, maxHeight: `${TITLE_MAX_LINES * 1.25}em` }}
			className={className}
			{...rest}
		/>
	);
}
