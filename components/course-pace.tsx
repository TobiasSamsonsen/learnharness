"use client";

import { useState } from "react";
import { PACES, isPace, paceInfo, type Pace } from "@/src/core";

/**
 * A course's default pace (fork addition, 2026-11-09), beside its time note.
 * Sessions started from the course begin at this pace (a Learn start's dialog
 * can override it for that one session); "Global default" clears it, so the
 * course follows Settings. Saved on change.
 */
export function CoursePace({
	courseId,
	pace,
	globalPace,
	onSaved,
}: {
	courseId: string;
	pace: Pace | undefined;
	/** The global default's label hint; omit while unknown. */
	globalPace?: Pace;
	onSaved: () => void;
}) {
	const [error, setError] = useState<string | null>(null);

	const save = async (value: string) => {
		setError(null);
		try {
			const res = await fetch(`/api/courses/${courseId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pace: isPace(value) ? value : null }),
			});
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `pace rejected (${res.status})`);
				return;
			}
			onSaved();
		} catch {
			setError("Could not reach the server — try again.");
		}
	};

	return (
		<label className="mb-3 flex flex-col gap-1 text-xs text-muted-foreground" data-testid="course-pace">
			Pace — how fast this course's lessons go. A Learn start can still pick its own.
			<select
				data-testid="course-pace-select"
				aria-label="course default pace"
				value={pace ?? ""}
				onChange={(e) => void save(e.target.value)}
				className="rounded-md border bg-background px-2 py-1.5 text-sm text-foreground outline-none"
			>
				<option value="">{`Global default${globalPace ? ` (${paceInfo(globalPace).label})` : ""}`}</option>
				{PACES.map((p) => (
					<option key={p.id} value={p.id}>
						{p.label}
					</option>
				))}
			</select>
			{error && <span role="alert" className="text-destructive">{error}</span>}
		</label>
	);
}
