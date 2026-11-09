"use client";

import { DEFAULT_PACE, PACES, isPace, paceInfo, type GeneralSettings } from "@/src/core";
import { SettingsGroup, SettingsRow, ThinSelect } from "@/components/settings/controls";

/**
 * Settings → General: the default lesson pace (fork addition, 2026-11-09,
 * core/pace.ts): stamped onto every new session. A course can set its own
 * (course page), and a course Learn start asks per lesson. The new-session
 * screen's setup panel edits the same value.
 */
export function PaceSection({
	general,
	onChange,
}: {
	general: GeneralSettings | undefined;
	/** Writes the WHOLE general section (replace-whole). */
	onChange: (next: GeneralSettings) => void;
}) {
	const current = general?.pace ?? DEFAULT_PACE;
	return (
		<SettingsGroup label="Pace" testid="group-pace">
			<SettingsRow
				label="Default pace"
				hint={`${paceInfo(current).blurb}. New sessions start here; a course can set its own, and each session can change its own`}
				testid="row-default-pace"
			>
				<ThinSelect
					value={current}
					ariaLabel="default pace"
					testid="select-default-pace"
					onChange={(v) => {
						if (isPace(v)) onChange({ ...general, pace: v });
					}}
				>
					{PACES.map((p) => (
						<option key={p.id} value={p.id}>
							{p.label}
						</option>
					))}
				</ThinSelect>
			</SettingsRow>
		</SettingsGroup>
	);
}
