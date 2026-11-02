"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClarifyAnchor, ClarifyThread } from "@/src/core";
import { clarifyErrorText } from "@/components/clarify-core";

/** What a question is about: a follow-up on a thread, or the first question on freshly marked text. */
export type ClarifyTarget = { threadId: string } | { anchor: ClarifyAnchor; quote: string };

/** The key a pending question is tracked under: the thread's id, or this for a thread that does not exist yet. */
export const DRAFT_KEY = "draft";

export interface ClarifyThreads {
	/** Every margin thread of the session, oldest first. */
	threads: ClarifyThread[];
	/** The thread (or DRAFT_KEY) whose question is out; the tutor has not answered yet. */
	busyKey: string | null;
	/** The last failure, with the thread (or DRAFT_KEY) it belongs to. */
	error: { key: string; message: string } | null;
	/** Ask the tutor; the thread (with the new answer last) once it is in, or null on failure. */
	ask: (target: ClarifyTarget, question: string) => Promise<ClarifyThread | null>;
}

/**
 * The margin threads of ONE session (owner design, 2026-11-02): loaded from /api/chats/[id]/clarify when the session opens,
 * extended by asking. A thread persists in the record, so the bubbles are there again after a reload.
 */
export function useClarifyThreads(
	chatId: string,
	fetchImpl: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): ClarifyThreads {
	const [threads, setThreads] = useState<ClarifyThread[]>([]);
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [error, setError] = useState<ClarifyThreads["error"]>(null);
	const chatRef = useRef(chatId);
	chatRef.current = chatId;

	useEffect(() => {
		setThreads([]);
		setBusyKey(null);
		setError(null);
		let live = true;
		void fetchImpl(`/api/chats/${chatId}/clarify`)
			.then(async (res) => (res.ok ? ((await res.json()) as { threads?: ClarifyThread[] }) : null))
			.then((body) => {
				if (live && body?.threads) setThreads(body.threads);
			})
			.catch(() => undefined); // an unloaded list is just empty; asking still works
		return () => {
			live = false;
		};
		// fetchImpl is a stable seam, not a dependency
	}, [chatId]);

	const ask = useCallback(
		async (target: ClarifyTarget, question: string): Promise<ClarifyThread | null> => {
			const chat = chatRef.current;
			const key = "threadId" in target ? target.threadId : DRAFT_KEY;
			setBusyKey(key);
			setError(null);
			try {
				const res = await fetchImpl(`/api/chats/${chat}/clarify`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ question, ...target }),
				});
				if (!res.ok) throw new Error(await clarifyErrorText(res));
				const body = (await res.json()) as { thread?: ClarifyThread };
				const thread = body.thread;
				if (!thread) throw new Error("The tutor's answer was not saved.");
				if (chatRef.current !== chat) return null; // another session meanwhile
				setThreads((all) => (all.some((t) => t.id === thread.id) ? all.map((t) => (t.id === thread.id ? thread : t)) : [...all, thread]));
				return thread;
			} catch (e) {
				if (chatRef.current === chat) setError({ key, message: e instanceof Error ? e.message : "The question could not be sent." });
				return null;
			} finally {
				if (chatRef.current === chat) setBusyKey(null);
			}
		},
		[],
	);

	return { threads, busyKey, error, ask };
}
