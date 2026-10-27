"use client";

import { useEffect, useState } from "react";
import { nativeInkBridge, nativeInkEnabled, setNativeInkEnabled } from "@/components/sketch/use-native-ink";
import { SettingsRow, Toggle } from "./controls.tsx";

/**
 * "Native ink" (Android plan M10, owner 2026-10-27: opt in first, default off): only in the Android shell, where
 * the page can reach `window.lhAndroid`. The sketch view reads the setting when it opens; per browser, not synced.
 */
export function NativeInkRow() {
	const [available, setAvailable] = useState(false);
	const [on, setOn] = useState(false);
	useEffect(() => {
		setAvailable(nativeInkBridge() !== null);
		setOn(nativeInkEnabled());
	}, []);
	if (!available) return null;
	return (
		<SettingsRow label="Native ink" hint="Sketches use the Android ink engine: the line stays under the stylus. Takes effect the next time a sketch opens." testid="row-native-ink">
			<Toggle
				checked={on}
				label="native ink"
				onChange={(next) => {
					setNativeInkEnabled(next);
					setOn(next);
				}}
			/>
		</SettingsRow>
	);
}
