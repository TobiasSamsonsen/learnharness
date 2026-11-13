"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { LessonResult } from "@/src/core";
import { RichText } from "@/components/rich-text";
import { useNotifyHub } from "@/components/server-events";

/**
 * The card under a finished course lesson (owner, 2026-11-13): the skill, its understanding and when it comes up for
 * review, the teacher's summary (what the learner showed and what to practice), and the next steps: practice the skill,
 * the next skill in the course's order, or back to the course. Read from GET /api/chats/[id]/lesson-result when the
 * finish divider mounts; nothing is stored for it (the summary is the finish_lesson call's, in the transcript).
 */

const BTN = "rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

/** "review in 5 days", "review tomorrow", "due for review now". Pure. */
export function reviewInLabel(reviewAt: string | null, now: number): string | null {
	if (reviewAt === null) return null;
	const days = Math.ceil((Date.parse(reviewAt) - now) / 86_400_000);
	if (days <= 0) return "due for review now";
	return days === 1 ? "review tomorrow" : `review in ${days} days`;
}

/** The card's body, separate from the fetch so it renders in tests. */
export function LessonResultView({
	result,
	now,
	busy = false,
	onPractice,
	onNext,
	onCourse,
}: {
	result: LessonResult;
	now: number;
	busy?: boolean;
	onPractice: () => void;
	onNext: () => void;
	onCourse: () => void;
}) {
	const review = reviewInLabel(result.reviewAt, now);
	return (
		<div data-testid="lesson-result" className="my-3 rounded-xl border bg-card p-4">
			<div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<span>Lesson result</span>
				<span>{result.learned ? "learned" : "not learned yet"}</span>
			</div>
			<div className="font-medium">{result.skill.name}</div>
			<div className="text-xs text-muted-foreground" data-testid="lesson-result-understanding">
				Understanding {result.understanding}/10{review ? ` · ${review}` : ""}
			</div>
			{result.summary && (
				<div className="mt-2 text-sm text-foreground/80" data-testid="lesson-result-summary">
					<RichText prose>{result.summary}</RichText>
				</div>
			)}
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<button type="button" className={BTN} disabled={busy} data-testid="lesson-result-practice" onClick={onPractice}>
					Practice this skill
				</button>
				{result.next && (
					<button type="button" className={BTN} disabled={busy} data-testid="lesson-result-next" onClick={onNext}>
						Next: {result.next.name}
					</button>
				)}
				<button type="button" className={BTN} disabled={busy} data-testid="lesson-result-course" onClick={onCourse}>
					Back to the course
				</button>
			</div>
		</div>
	);
}

export function LessonResultCard({ chatId }: { chatId: string }) {
	const router = useRouter();
	const [result, setResult] = useState<LessonResult | null>(null);
	const [busy, setBusy] = useState(false);

	// The divider mounts mid-turn, before the finish is in the record: ask again when the turn settles (and when the
	// record changes outside a turn).
	const load = useCallback(() => {
		fetch(`/api/chats/${encodeURIComponent(chatId)}/lesson-result`, { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<LessonResult>) : null))
			.then((body) => {
				if (body) setResult(body);
			})
			.catch(() => {});
	}, [chatId]);
	useEffect(() => load(), [load]);
	const hub = useNotifyHub();
	useEffect(() => {
		if (!hub) return;
		const offs = [hub.subscribe("turn-settled", () => load()), hub.subscribe("record-changed", (p) => p.chatId === chatId && load())];
		return () => offs.forEach((off) => off());
	}, [hub, load, chatId]);

	if (!result) return null;
	const practice = async () => {
		if (busy) return;
		setBusy(true);
		try {
			const res = await fetch(`/api/courses/${encodeURIComponent(result.courseId)}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "practice", skillId: result.skill.id }) });
			if (!res.ok) {
				router.push(`/course/${result.courseId}`);
				return;
			}
			const { id, prompt } = (await res.json()) as { id: string; prompt: string };
			router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
		} catch {
			router.push(`/course/${result.courseId}`);
		} finally {
			setBusy(false);
		}
	};
	return (
		<LessonResultView
			result={result}
			now={Date.now()}
			busy={busy}
			onPractice={() => void practice()}
			onNext={() => router.push(`/course/${result.courseId}?learn=${encodeURIComponent(result.next!.id)}`)}
			onCourse={() => router.push(`/course/${result.courseId}`)}
		/>
	);
}
