"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { MessageResponse } from "@/components/ai-elements/message";
import { blockScrollTarget, isLandedText, isLongBlock, revealStagger, REVEAL_MS, wordCount } from "./landed-block.ts";

/**
 * True once the chat has mounted its first render. A text part that mounts
 * after that, already long, landed all at once (the plan, a teaching text):
 * it fades in word by word and, if taller than the screen, is scrolled so its
 * first line sits near the top. Parts present at first render never animate
 * or scroll (reload, opening an old lesson).
 */
export const SettledContext = createContext<{ current: boolean }>({ current: false });

export function LandedText({ children }: { children: string }) {
	const settled = useContext(SettledContext);
	// Decided once, at mount: the same text part keeps its component across the id swap at turn end.
	const [landed] = useState(() => settled.current && isLandedText(children));
	const [animating, setAnimating] = useState(landed);
	useEffect(() => {
		if (!landed) return;
		const timer = setTimeout(() => setAnimating(false), REVEAL_MS + 600);
		return () => clearTimeout(timer);
	}, [landed]);

	const { scrollRef, stopScroll } = useStickToBottomContext();
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (!landed || typeof ResizeObserver === "undefined") return;
		const el = ref.current;
		const scroller = scrollRef.current;
		if (!el || !scroller) return;
		let done = false;
		let frame = 0;
		const decide = () => {
			if (done || el.offsetHeight === 0) return;
			done = true;
			observer.disconnect();
			// After layout settles one frame, so the block's real top and the content height are final.
			frame = requestAnimationFrame(() => {
				if (!isLongBlock(el.offsetHeight, scroller.clientHeight)) return;
				stopScroll(); // release the follow-the-bottom lock: this block is read from its start
				const blockTop = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
				scroller.scrollTo({
					top: blockScrollTarget({ blockTop, viewportHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight }),
					behavior: "smooth",
				});
			});
		};
		const observer = new ResizeObserver(decide);
		observer.observe(el);
		decide();
		const giveUp = setTimeout(() => {
			done = true;
			observer.disconnect();
		}, 600);
		return () => {
			done = true;
			observer.disconnect();
			clearTimeout(giveUp);
			cancelAnimationFrame(frame);
		};
	}, [landed, scrollRef, stopScroll]);

	return (
		<div ref={ref}>
			<MessageResponse
				{...(landed
					? { animated: { animation: "fadeIn", duration: 220, sep: "word", stagger: revealStagger(wordCount(children)) }, isAnimating: animating }
					: {})}
			>
				{children}
			</MessageResponse>
		</div>
	);
}
