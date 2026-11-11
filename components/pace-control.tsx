"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PACES, PACE_NOTE_MAX, paceInfo, resolvePace, type ChatSettings, type Pace } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { usePopoverDismiss } from "./popover-dismiss.ts";
import { Hint } from "@/components/ui/hint";
import { CONTROL_CLASS, type ControlVariant } from "@/components/control-variant";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";

/**
 * The pace pill (fork addition, 2026-11-01) — the language pill's sibling on
 * the composer's edge, for a RUNNING session only (the new-session screen has
 * its own setup panel):
 *
 *   a pick rewrites the session's record (replace-whole, so the model and
 *   language fields ride along) and takes effect from the next turn.
 *
 * The time note lives here for a plain session, and on the COURSE page for a
 * course session (a test usually covers several concepts), where this menu
 * only points at it. Practice sessions are not paced, so the pill hides.
 */
type SessionView = { settings?: ChatSettings; kind?: string; course?: unknown };

export function PaceControl({ chatId, variant = "edge" }: { chatId: string; variant?: ControlVariant }) {
	const [view, setView] = useState<SessionView | undefined>(undefined);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);

	const read = useCallback(() => {
		fetch(`/api/chats/${chatId}`)
			.then((r) => r.json() as Promise<SessionView>)
			.then((b) => {
				setView({ settings: b.settings ?? {}, kind: b.kind, course: b.course });
				setNote(b.settings?.paceNote ?? "");
			})
			.catch(() => {});
	}, [chatId]);
	useEffect(read, [read]);
	useSettingsSaved((section) => {
		if (section === "lesson" || section === "models") read();
	});

	// Outside pointerdown, Esc and the Android back close it through the shared popup layer (interaction-layers.tsx).
	usePopoverDismiss(containerRef, open, () => setOpen(false));

	if (view?.kind === "practice") return null;
	const current = resolvePace(view?.settings);
	const hasCourse = view?.course !== undefined && view?.course !== null;

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
				setError(body.error ?? `pace rejected (${res.status})`);
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

	const pick = async (pace: Pace) => {
		if (await save({ ...view?.settings, pace })) setOpen(false);
	};
	const saveNote = async () => {
		const { paceNote: _old, ...rest } = view?.settings ?? {};
		const trimmed = note.trim();
		if (await save({ ...rest, ...(trimmed ? { paceNote: trimmed } : {}) })) setOpen(false);
	};

	return (
		<div ref={containerRef} className="relative flex items-center" data-testid="pace-control">
			<Hint label="Pace — how fast to move through the material" side="bottom">
				<button
					type="button"
					data-testid="stats-pace"
					aria-label={`Pace: ${paceInfo(current).label}`}
					aria-expanded={open}
					onClick={() => {
						setOpen((o) => !o);
						setError(null);
					}}
					className={CONTROL_CLASS[variant]}
				>
					<span className="text-card-foreground">{paceInfo(current).short}</span>
					<span aria-hidden className="text-xs text-muted-foreground">▾</span>
				</button>
			</Hint>
			{open && (
				<MenuShell
					anchorRef={containerRef}
					testid="pace-menu"
					preferredSide="up"
					menuClass="flex w-72 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{error && <div className="mb-1.5 text-destructive">{error}</div>}
					{PACES.map((p) => (
						<button
							key={p.id}
							type="button"
							data-testid={`pace-option-${p.id}`}
							onClick={() => void pick(p.id)}
							className={`flex items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted ${
								p.id === current ? "text-foreground" : "text-muted-foreground"
							}`}
						>
							<span className="flex flex-col">
								<span>{p.label}</span>
								<span className="text-[11px] text-muted-foreground/70">{p.blurb}</span>
							</span>
							{p.id === current && <span aria-hidden>✓</span>}
						</button>
					))}
					<div className="mt-1 border-t px-2 pt-1.5">
						{hasCourse ? (
							<p data-testid="pace-note-course" className="text-[11px] text-muted-foreground/70">
								The time note for this lesson is set on the course page.
							</p>
						) : (
							<label className="flex flex-col gap-1 text-[11px] text-muted-foreground/70">
								Time note (optional)
								<textarea
									data-testid="pace-note"
									value={note}
									maxLength={PACE_NOTE_MAX}
									rows={2}
									placeholder="e.g. exam Thursday, 4 concepts"
									onChange={(e) => setNote(e.target.value)}
									className="resize-none rounded-md border bg-background px-2 py-1 text-xs text-foreground outline-none"
								/>
								<button
									type="button"
									data-testid="pace-note-save"
									onClick={() => void saveNote()}
									className="self-end rounded-md border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
								>
									Save note
								</button>
							</label>
						)}
					</div>
					<div className="px-2 pt-1 text-[11px] text-muted-foreground/70">This lesson only — takes effect on the next turn</div>
				</MenuShell>
			)}
		</div>
	);
}
