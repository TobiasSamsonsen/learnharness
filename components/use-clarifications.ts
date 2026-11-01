"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Clarification } from "@/src/core";
import { clarifyErrorText } from "@/components/clarify-core";

export interface Clarifications {
	/** The pending question's earlier Q&A pairs, oldest first. */
	thread: Clarification[];
	/** A question is out; the tutor has not answered yet. */
	busy: boolean;
	error: string | null;
	/** Ask about the marked text; true once the answer is in the thread. */
	ask: (quote: string, question: string) => Promise<boolean>;
}

/**
 * The side thread of ONE pending question (owner design, 2026-11-01): loaded
 * from /api/chats/[id]/clarify when the question appears, extended by asking.
 * A different question (or none) resets it; a late reply for a question that
 * is gone is dropped.
 */
export function useClarifications(
	chatId: string,
	questionKey: string | null,
	fetchImpl: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Clarifications {
	const [thread, setThread] = useState<Clarification[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const keyRef = useRef(questionKey);
	keyRef.current = questionKey;

	useEffect(() => {
		setThread([]);
		setBusy(false);
		setError(null);
		if (!questionKey) return;
		let live = true;
		void fetchImpl(`/api/chats/${chatId}/clarify?key=${encodeURIComponent(questionKey)}`)
			.then(async (res) => (res.ok ? ((await res.json()) as { clarifications?: Clarification[] }) : null))
			.then((body) => {
				if (live && body?.clarifications) setThread(body.clarifications);
			})
			.catch(() => undefined); // an unloaded thread is just empty; asking still works
		return () => {
			live = false;
		};
		// fetchImpl is a stable seam, not a dependency
	}, [chatId, questionKey]);

	const ask = useCallback(
		async (quote: string, question: string): Promise<boolean> => {
			const key = keyRef.current;
			if (!key) return false;
			setBusy(true);
			setError(null);
			try {
				const res = await fetchImpl(`/api/chats/${chatId}/clarify`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key, quote, question }),
				});
				if (!res.ok) throw new Error(await clarifyErrorText(res));
				const body = (await res.json()) as { clarification: Clarification };
				if (keyRef.current !== key) return false; // the question moved on meanwhile
				setThread((t) => [...t, body.clarification]);
				return true;
			} catch (e) {
				if (keyRef.current === key) setError(e instanceof Error ? e.message : "The question could not be sent.");
				return false;
			} finally {
				if (keyRef.current === key) setBusy(false);
			}
		},
		[chatId],
	);

	return { thread, busy, error, ask };
}
