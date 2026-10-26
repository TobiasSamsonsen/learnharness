"use client";

import { useEffect, useState } from "react";
import type { SketchRef } from "@/src/core";

/**
 * A sent sketch in the transcript (Android plan M1): page 1 as a small
 * image (the stored SVG); a click opens it full-size in a new tab (owner,
 * M1), and every further page gets its own link. The optimistic card
 * renders while the POST is still storing the pages, so a failed load
 * retries a few times before it gives up.
 */

const RETRIES = 5;
const RETRY_MS = 800;

export function SketchThumbnail({ chatId, sketch }: { chatId: string; sketch: SketchRef }) {
	const pageUrl = (page: number) => `/api/chats/${encodeURIComponent(chatId)}/sketches/${sketch.id}/${page}`;
	const [attempt, setAttempt] = useState(0);
	const [failed, setFailed] = useState(false);
	const [retryAt, setRetryAt] = useState<number | null>(null);
	useEffect(() => {
		if (retryAt === null) return;
		const t = window.setTimeout(() => {
			setRetryAt(null);
			setAttempt((n) => n + 1);
		}, RETRY_MS);
		return () => window.clearTimeout(t);
	}, [retryAt]);

	const first = sketch.pages[0];
	return (
		<div data-testid="sketch-thumbnail" className="my-2 flex flex-wrap items-end gap-2">
			<a
				href={pageUrl(0)}
				target="_blank"
				rel="noreferrer"
				className="block overflow-hidden rounded-md border bg-white"
				title="Open the sketch full-size"
			>
				{failed ? (
					<span className="block px-3 py-2 text-xs text-muted-foreground">Sketch unavailable</span>
				) : (
					// eslint-disable-next-line @next/next/no-img-element -- a stored SVG, not an optimizable asset
					<img
						key={attempt}
						src={attempt === 0 ? pageUrl(0) : `${pageUrl(0)}?retry=${attempt}`}
						alt="Your sketch"
						width={first?.width}
						height={first?.height}
						onError={() => (attempt < RETRIES ? setRetryAt(Date.now()) : setFailed(true))}
						className="block h-auto max-h-48 w-auto max-w-full"
					/>
				)}
			</a>
			{sketch.pages.slice(1).map((_, i) => (
				<a
					key={i + 1}
					href={pageUrl(i + 1)}
					target="_blank"
					rel="noreferrer"
					className="text-xs text-muted-foreground underline-offset-2 hover:underline"
				>
					page {i + 2}
				</a>
			))}
		</div>
	);
}
