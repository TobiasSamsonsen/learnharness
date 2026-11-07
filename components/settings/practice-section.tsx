"use client";

import { DEFAULT_DIFFICULTY, DIFFICULTIES, difficultyInfo, isDifficulty, type GeneralSettings } from "@/src/core";
import { SettingsGroup, SettingsRow, ThinSelect } from "@/components/settings/controls";

/**
 * Settings → General: the default problem difficulty (fork addition,
 * 2026-11-07, core/difficulty.ts): stamped onto every new practice session
 * (practice, review, context check); each session then owns its own, changed
 * from the pill under the composer.
 */
export function PracticeSection({
	general,
	onChange,
}: {
	general: GeneralSettings | undefined;
	/** Writes the WHOLE general section (replace-whole). */
	onChange: (next: GeneralSettings) => void;
}) {
	const current = general?.difficulty ?? DEFAULT_DIFFICULTY;
	return (
		<SettingsGroup label="Practice" testid="group-practice">
			<SettingsRow
				label="Default problem difficulty"
				hint={`${difficultyInfo(current).blurb}. New practice and review sessions start here; each session can change its own from the bar under the composer`}
				testid="row-default-difficulty"
			>
				<ThinSelect
					value={current}
					ariaLabel="default problem difficulty"
					testid="select-default-difficulty"
					onChange={(v) => {
						if (isDifficulty(v)) onChange({ ...general, difficulty: v });
					}}
				>
					{DIFFICULTIES.map((d) => (
						<option key={d.id} value={d.id}>
							{d.label}
						</option>
					))}
				</ThinSelect>
			</SettingsRow>
		</SettingsGroup>
	);
}
