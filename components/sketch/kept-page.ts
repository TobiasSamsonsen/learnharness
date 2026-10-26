import { useEffect, useState } from "react";
import { parseSketchPayload, type SketchRef } from "@/src/core";
import { inflightSketch, readKept, useKept, writeKept, type KeptPage } from "@/components/sketch/ink-memory";

/**
 * The kept page of a practice problem (Android plan M3): the strokes the
 * server already holds for the problem's newest sketch. In memory they are
 * already there (this session's submits); after a reload they are fetched
 * from the server once.
 */

export type KeptStatus = "ready" | "loading" | "failed";

export function useKeptPage(chatId: string, key: string, ref: Pick<SketchRef, "id"> | null): { kept: KeptPage | null; status: KeptStatus } {
	const kept = useKept(key);
	const id = ref?.id ?? null;
	// Which sketch the last fetch settled, and how.
	const [settled, setSettled] = useState<{ id: string; ok: boolean } | null>(null);
	const have = id === null || kept?.id === id || inflightSketch(key) === id;
	useEffect(() => {
		if (id === null || readKept(key)?.id === id || inflightSketch(key) === id) return;
		let live = true;
		fetch(`/api/chats/${encodeURIComponent(chatId)}/sketches/${id}/strokes`)
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
			.then((strokes: unknown) => {
				const payload = parseSketchPayload({ id, producer: "web-canvas", strokes });
				writeKept(key, { id, strokes: payload.strokes });
				if (live) setSettled({ id, ok: true });
			})
			.catch(() => {
				// A stale page must not become the base of the next one.
				if (readKept(key)?.id !== id) writeKept(key, null);
				if (live) setSettled({ id, ok: false });
			});
		return () => {
			live = false;
		};
	}, [chatId, key, id]);
	const status: KeptStatus = have ? "ready" : settled?.id === id ? (settled.ok ? "ready" : "failed") : "loading";
	return { kept, status };
}
