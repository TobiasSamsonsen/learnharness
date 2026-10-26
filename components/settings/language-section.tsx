"use client";

import { useCallback, useEffect, useState } from "react";
import {
	DEFAULT_DICTATION_ENGINE,
	DEFAULT_LESSON_LANGUAGE,
	LESSON_LANGUAGES,
	isDictationEngine,
	isLessonLanguage,
	lessonLanguageInfo,
	type GeneralSettings,
	type LocalSttStatus,
} from "@/src/core";
import { SettingsGroup, SettingsRow, ThinSelect } from "@/components/settings/controls";

/**
 * Settings → General: language + dictation (fork addition, 2026-10-24).
 *
 *   Default lesson language  stamped onto every new lesson (each lesson
 *                            then owns its own — the stats-bar pill).
 *   Dictation engine         local (on-device Whisper, default) or
 *                            Deepgram (cloud, needs its key).
 *   Local speech models      one row per language: downloaded or not,
 *                            a Download button, live progress.
 */

/** A model row's status line. Pure — exported for pins. */
export function localModelLine(status: LocalSttStatus): string {
	// where the last dictation ran (owner, 2026-10-25): the GPU model, or
	// the small CPU fallback when the GPU path could not run, or the CPU
	// model by choice (LH_STT_DEVICE=cpu)
	const where = status.ranOn === "gpu" ? " · GPU" : status.ranOn === "cpu" ? " · CPU" : status.ranOn === "cpu-fallback" ? " · GPU unavailable, using the small CPU model" : "";
	return modelState(status) + where;
}

function modelState(status: LocalSttStatus): string {
	switch (status.state) {
		case "absent":
			return `not downloaded · ${status.sizeMb} MB`;
		case "downloading":
			return `downloading${status.progress !== undefined ? ` ${Math.round(status.progress * 100)}%` : "…"}`;
		case "loading":
			return "loading…";
		case "cached":
			return "downloaded";
		case "ready":
			return "ready";
		case "error":
			return `failed${status.error ? ` — ${status.error}` : ""}`;
	}
}

export function LanguageSection({
	general,
	onChange,
}: {
	general: GeneralSettings | undefined;
	/** Writes the WHOLE general section (replace-whole). */
	onChange: (next: GeneralSettings) => void;
}) {
	const [models, setModels] = useState<LocalSttStatus[] | null>(null);
	const read = useCallback(() => {
		fetch("/api/stt/local")
			.then((r) => r.json() as Promise<{ models?: LocalSttStatus[] }>)
			.then((b) => setModels(b.models ?? []))
			.catch(() => setModels([]));
	}, []);
	useEffect(read, [read]);
	// Poll only while something is moving (a download or a load).
	const busy = models?.some((m) => m.state === "downloading" || m.state === "loading") ?? false;
	useEffect(() => {
		if (!busy) return;
		const id = setInterval(read, 1000);
		return () => clearInterval(id);
	}, [busy, read]);

	const download = (language: LocalSttStatus["language"]) => {
		void fetch("/api/stt/local/prepare", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ language }),
		}).then(() => setTimeout(read, 300));
	};

	const engine = general?.dictationEngine ?? DEFAULT_DICTATION_ENGINE;
	return (
		<>
			<SettingsGroup label="Language" testid="group-language">
				<SettingsRow
					label="Default lesson language"
					hint="New lessons start in this language; each lesson can change its own from the bar under the composer"
					testid="row-default-language"
				>
					<ThinSelect
						value={general?.language ?? DEFAULT_LESSON_LANGUAGE}
						ariaLabel="default lesson language"
						testid="select-default-language"
						onChange={(v) => {
							if (isLessonLanguage(v)) onChange({ ...general, language: v });
						}}
					>
						{LESSON_LANGUAGES.map((l) => (
							<option key={l.id} value={l.id}>
								{l.label}
							</option>
						))}
					</ThinSelect>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Dictation" testid="group-dictation">
				<SettingsRow
					label="Dictation engine"
					hint={
						engine === "local"
							? "On this device: free, offline after the first download, audio never leaves the machine"
							: "Deepgram's cloud: needs a Deepgram key under Keys"
					}
					testid="row-dictation-engine"
				>
					<ThinSelect
						value={engine}
						ariaLabel="dictation engine"
						testid="select-dictation-engine"
						onChange={(v) => {
							if (isDictationEngine(v)) onChange({ ...general, dictationEngine: v });
						}}
					>
						<option value="local">Local</option>
						<option value="deepgram">Deepgram (cloud)</option>
					</ThinSelect>
				</SettingsRow>
				{engine === "local" &&
					(models ?? []).map((m) => (
						<SettingsRow
							key={m.language}
							label={`${lessonLanguageInfo(m.language).label} speech model`}
							hint={m.repo}
							testid={`row-stt-model-${m.language}`}
						>
							<span className="flex items-center gap-2">
								<span className="font-mono text-[11px] text-muted-foreground" data-testid={`stt-model-${m.language}-status`}>
									{localModelLine(m)}
								</span>
								{(m.state === "absent" || m.state === "error") && (
									<button
										type="button"
										onClick={() => download(m.language)}
										data-testid={`stt-model-${m.language}-download`}
										className="text-xs text-foreground underline-offset-2 hover:underline"
									>
										Download
									</button>
								)}
							</span>
						</SettingsRow>
					))}
			</SettingsGroup>
		</>
	);
}
