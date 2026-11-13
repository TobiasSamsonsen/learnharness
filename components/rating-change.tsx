"use client";

import { useCallback, useEffect, useState } from "react";
import type { RatingChange } from "@/src/core";
import { useNotifyHub } from "@/components/server-events";

/**
 * What a concluded problem did to its skills (owner, 2026-11-13): "Product rule: understanding 3.1 → 4.2 · review in
 * 5 days" under the conclude card. One request per chat serves every card of the session (the server folds all the
 * evidence once); the cards ask again when a turn settles, since the problem is only in the record by then.
 */

type SkillChange = RatingChange["skills"][number];

/** "Product rule: understanding 3.1 → 4.2 · review in 5 days". Pure. */
export function ratingLine(skill: SkillChange, now: number): string {
	const review = reviewIn(skill.reviewAt, now);
	if (skill.before === skill.after) {
		return skill.after === 0 ? `${skill.name}: not learned yet` : `${skill.name}: understanding stays ${skill.after}${review ? ` · ${review}` : ""}`;
	}
	return `${skill.name}: understanding ${skill.before} → ${skill.after}${review ? ` · ${review}` : ""}`;
}

function reviewIn(reviewAt: string | null, now: number): string | null {
	if (reviewAt === null) return null;
	const days = Math.ceil((Date.parse(reviewAt) - now) / 86_400_000);
	if (days <= 0) return "review due now";
	return days === 1 ? "review tomorrow" : `review in ${days} days`;
}

const requests = new Map<string, { at: number; promise: Promise<RatingChange[] | null> }>();
/** Cards of one chat share a request; a forced refresh within a second reuses the one just made. */
function load(chatId: string, force: boolean): Promise<RatingChange[] | null> {
	const held = requests.get(chatId);
	if (held && (!force || Date.now() - held.at < 1000)) return held.promise;
	const promise = fetch(`/api/chats/${encodeURIComponent(chatId)}/rating-changes`, { cache: "no-store" })
		.then((r) => (r.ok ? (r.json() as Promise<{ changes: RatingChange[] }>) : null))
		.then((body) => body?.changes ?? null)
		.catch(() => null);
	requests.set(chatId, { at: Date.now(), promise });
	return promise;
}

/** The change this conclude call made, once the record holds it; null before that, and when it cannot be read. */
export function useRatingChange(chatId: string | undefined, callId: string): RatingChange | null {
	const [change, setChange] = useState<RatingChange | null>(null);
	const refresh = useCallback(
		(force: boolean) => {
			if (!chatId) return;
			void load(chatId, force).then((list) => setChange(list?.find((c) => c.callId === callId) ?? null));
		},
		[chatId, callId],
	);
	useEffect(() => refresh(false), [refresh]);
	// the cards also render without an events provider (isolated tests), so the subscription is optional
	const hub = useNotifyHub();
	useEffect(() => {
		if (!hub) return;
		// "record-changed" too: Grade again rewrites a conclude result outside a turn
		const offs = [hub.subscribe("turn-settled", () => refresh(true)), hub.subscribe("record-changed", (p) => p.chatId === chatId && refresh(true))];
		return () => offs.forEach((off) => off());
	}, [hub, refresh, chatId]);
	return change;
}

export function RatingChangeNote({ chatId, callId }: { chatId: string | undefined; callId: string }) {
	const change = useRatingChange(chatId, callId);
	if (!change || change.skills.length === 0) return null;
	const now = Date.now();
	return (
		<div data-testid="rating-change" className="mt-3 space-y-0.5 text-xs text-muted-foreground">
			{change.skills.map((s) => (
				<div key={s.id}>{ratingLine(s, now)}</div>
			))}
		</div>
	);
}
