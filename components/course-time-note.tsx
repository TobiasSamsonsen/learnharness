"use client";

import { useEffect, useState } from "react";
import { PACE_NOTE_MAX } from "@/src/core";

/**
 * A course's time note (fork addition, 2026-11-01): "exam Thursday, 4
 * concepts". Every session of the course reads it each turn as data about the
 * learner, so an edit reaches the sessions already running. Committed on blur,
 * like the title; blank clears it.
 */
export function CourseTimeNote({ courseId, note, onSaved }: { courseId: string; note: string | undefined; onSaved: () => void }) {
	const [value, setValue] = useState(note ?? "");
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setValue(note ?? ""), [note]);

	const commit = async () => {
		if (value.trim() === (note ?? "")) return;
		setError(null);
		try {
			const res = await fetch(`/api/courses/${courseId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ note: value }),
			});
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `note rejected (${res.status})`);
				return;
			}
			onSaved();
		} catch {
			setError("Could not reach the server — try again.");
		}
	};

	return (
		<label className="mb-4 flex flex-col gap-1 text-xs text-muted-foreground" data-testid="course-time-note">
			Time note — when is the test, and what does it cover? The teacher paces the lessons by it.
			<textarea
				data-testid="course-time-note-input"
				value={value}
				maxLength={PACE_NOTE_MAX}
				rows={2}
				placeholder="e.g. exam Thursday, 4 concepts"
				onChange={(e) => setValue(e.target.value)}
				onBlur={() => void commit()}
				className="resize-none rounded-md border bg-background px-2 py-1.5 text-sm text-foreground outline-none"
			/>
			{error && <span role="alert" className="text-destructive">{error}</span>}
		</label>
	);
}
