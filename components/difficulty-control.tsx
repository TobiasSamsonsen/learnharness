"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DIFFICULTIES, difficultyInfo, resolveDifficulty, type ChatSettings, type Difficulty } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { useBackLayer } from "./back-layers.ts";
import { Hint } from "@/components/ui/hint";
import { CONTROL_CLASS, type ControlVariant } from "@/components/control-variant";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";

/**
 * The difficulty pill (fork addition, 2026-11-07) — the pace pill's sibling on
 * the composer's edge, for a RUNNING PRACTICE session only (the mirror of
 * PaceControl, which hides for practice):
 *
 *   a pick rewrites the session's record (replace-whole, so the other fields
 *   ride along) and takes effect from the next problem.
 *
 * Difficulty sizes the practice agent's problems; teaching sessions are not
 * sized by it, so the pill hides for them.
 */
type SessionView = { settings?: ChatSettings; kind?: string };

export function DifficultyControl({ chatId, variant = "edge" }: { chatId: string; variant?: ControlVariant }) {
	const [view, setView] = useState<SessionView | undefined>(undefined);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const read = useCallback(() => {
		fetch(`/api/chats/${chatId}`)
			.then((r) => r.json() as Promise<SessionView>)
			.then((b) => setView({ settings: b.settings ?? {}, kind: b.kind }))
			.catch(() => {});
	}, [chatId]);
	useEffect(read, [read]);
	useSettingsSaved((section) => {
		if (section === "lesson" || section === "models") read();
	});

	useBackLayer(open, () => setOpen(false));
	// Same dismissal contract as the pace menu: outside pointerdown or Esc.
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const t = e.target as Element;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (containerRef.current && !containerRef.current.contains(t)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	if (view?.kind !== "practice") return null;
	const current = resolveDifficulty(view?.settings);

	const save = async (next: ChatSettings): Promise<boolean> => {
		setError(null);
		try {
			const res = await fetch(`/api/chats/${chatId}/settings`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(next),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? `difficulty rejected (${res.status})`);
				return false;
			}
			setView({ ...view, settings: next });
			notifySettingsSaved("lesson");
			return true;
		} catch {
			setError("Could not reach the server — try again.");
			return false;
		}
	};

	const pick = async (difficulty: Difficulty) => {
		if (await save({ ...view?.settings, difficulty })) setOpen(false);
	};

	return (
		<div ref={containerRef} className="relative flex items-center" data-testid="difficulty-control">
			<Hint label="Difficulty — how much each problem asks of you" side="bottom">
				<button
					type="button"
					data-testid="stats-difficulty"
					aria-label={`Difficulty: ${difficultyInfo(current).label}`}
					aria-expanded={open}
					onClick={() => {
						setOpen((o) => !o);
						setError(null);
					}}
					className={CONTROL_CLASS[variant]}
				>
					<span className="text-card-foreground">{difficultyInfo(current).short}</span>
					<span aria-hidden className="text-xs text-muted-foreground">▾</span>
				</button>
			</Hint>
			{open && (
				<MenuShell
					anchorRef={containerRef}
					testid="difficulty-menu"
					preferredSide="up"
					menuClass="flex w-72 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{error && <div className="mb-1.5 text-destructive">{error}</div>}
					{DIFFICULTIES.map((d) => (
						<button
							key={d.id}
							type="button"
							data-testid={`difficulty-option-${d.id}`}
							onClick={() => void pick(d.id)}
							className={`flex items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted ${
								d.id === current ? "text-foreground" : "text-muted-foreground"
							}`}
						>
							<span className="flex flex-col">
								<span>{d.label}</span>
								<span className="text-[11px] text-muted-foreground/70">{d.blurb}</span>
							</span>
							{d.id === current && <span aria-hidden>✓</span>}
						</button>
					))}
					<div className="px-2 pt-1 text-[11px] text-muted-foreground/70">This practice session only — takes effect on the next problem</div>
				</MenuShell>
			)}
		</div>
	);
}
