"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	DEFAULT_LESSON_LANGUAGE,
	LESSON_LANGUAGES,
	lessonLanguageInfo,
	resolveLessonLanguage,
	type ChatSettings,
	type GeneralSettings,
	type LessonLanguage,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { CONTROL_CLASS, type ControlVariant } from "@/components/control-variant";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";

/**
 * The lesson-language pill (fork addition, 2026-10-24) — the stats bar's
 * sibling of ModelControl, with the same dual binding:
 *
 *   chat mode (chatId)  the lesson's OWN language (ChatSettings.language,
 *                       absent = English). A pick rewrites the lesson's
 *                       record — replace-whole, so the model fields ride
 *                       along — and takes effect from the next turn.
 *   draft mode          the DEFAULT language (general.language), exactly
 *                       as the draft's model pills edit the strong slot:
 *                       the server stamps a new lesson from it at birth.
 *
 * Both writes announce themselves ("lesson" / "general") so the model
 * control and the dictation hook re-read.
 */
export function LanguageControl({ chatId, variant = "pill" }: { chatId?: string; variant?: ControlVariant }) {
	const [session, setSession] = useState<ChatSettings | undefined>(undefined);
	const [general, setGeneral] = useState<GeneralSettings | undefined>(undefined);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const read = useCallback(() => {
		if (chatId) {
			fetch(`/api/chats/${chatId}`)
				.then((r) => r.json() as Promise<{ settings?: ChatSettings }>)
				.then((b) => setSession(b.settings ?? {}))
				.catch(() => {});
		}
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings: { general?: GeneralSettings } | null }>)
			.then((b) => setGeneral(b.settings?.general ?? {}))
			.catch(() => {});
	}, [chatId]);
	useEffect(read, [read]);
	useSettingsSaved((section) => {
		if (section === "general" || section === "lesson" || section === "models") read();
	});

	const current: LessonLanguage = chatId
		? resolveLessonLanguage(session)
		: (general?.language ?? DEFAULT_LESSON_LANGUAGE);

	// Same dismissal contract as the model menu: outside pointerdown or Esc.
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

	const pick = async (language: LessonLanguage) => {
		setError(null);
		try {
			const res = chatId
				? await fetch(`/api/chats/${chatId}/settings`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ ...session, language }),
					})
				: await fetch("/api/settings/general", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ ...general, language }),
					});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? `language rejected (${res.status})`);
				return;
			}
			if (chatId) setSession({ ...session, language });
			else setGeneral({ ...general, language });
			setOpen(false);
			notifySettingsSaved(chatId ? "lesson" : "general");
		} catch {
			setError("Could not reach the server — try again.");
		}
	};

	return (
		<div ref={containerRef} className="relative flex items-center" data-testid="language-control">
			<Hint label={chatId ? "Lesson language" : "Language for new lessons"} side="bottom">
				<button
					type="button"
					data-testid="stats-language"
					aria-label={`Lesson language: ${lessonLanguageInfo(current).label}`}
					aria-expanded={open}
					onClick={() => {
						setOpen((o) => !o);
						setError(null);
					}}
					className={CONTROL_CLASS[variant]}
				>
					<span className="text-card-foreground">{lessonLanguageInfo(current).short}</span>
					<span aria-hidden className="text-xs text-muted-foreground">▾</span>
				</button>
			</Hint>
			{open && (
				<MenuShell
					anchorRef={containerRef}
					testid="language-menu"
					preferredSide="up"
					menuClass="flex w-48 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{error && <div className="mb-1.5 text-destructive">{error}</div>}
					{LESSON_LANGUAGES.map((l) => (
						<button
							key={l.id}
							type="button"
							data-testid={`language-option-${l.id}`}
							onClick={() => void pick(l.id)}
							className={`flex items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted ${
								l.id === current ? "text-foreground" : "text-muted-foreground"
							}`}
						>
							<span>{l.label}</span>
							{l.id === current && <span aria-hidden>✓</span>}
						</button>
					))}
					<div className="mt-1 border-t px-2 pt-1.5 text-[11px] text-muted-foreground/70">
						{chatId ? "This lesson's language — teaching and dictation" : "Default for new lessons"}
					</div>
				</MenuShell>
			)}
		</div>
	);
}
