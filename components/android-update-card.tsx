"use client";

/**
 * The fork's own update card in the Android app (owner, 2026-10-29; docs/android/m15-plan.md): the same card as the upstream
 * release notice (components/upstream-banner.tsx), bottom-right, in place of the shell's old fullscreen "Update available"
 * screen. The shell checks the release in the background and answers `update probe` with `update available` (UpdateWire.kt).
 *
 *   Update    the shell stops the server, downloads and unpacks the new build (its own progress screen, Wi-Fi only) and
 *             restarts; the page reloads when it is back.
 *   Not now   hidden until the next cold start of the app (the shell remembers, so a page reload does not bring it back).
 *
 * Renders nothing outside the Android shell.
 */

import { useEffect, useState } from "react";

/** The fork's running log of what changed (owner, 2026-10-29): there are no per-release notes. */
export const ANDROID_RELEASE_NOTES_URL = "https://github.com/TobiasSamsonsen/learnharness/blob/main/docs/android/STATUS.md";

/** The lines of UpdateWire.kt. */
export const UPDATE_LINES = { probe: "update probe", available: "update available", start: "update start", later: "update later" } as const;

interface UpdateBridge {
	postMessage(line: string): void;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

function updateBridge(): UpdateBridge | null {
	if (typeof window === "undefined") return null;
	const b = (window as unknown as { lhAndroid?: Partial<UpdateBridge> }).lhAndroid;
	return b && typeof b.postMessage === "function" && typeof b.addEventListener === "function" && typeof b.removeEventListener === "function" ? (b as UpdateBridge) : null;
}

export function AndroidUpdateNotice({ onNotNow, onUpdate }: { onNotNow: () => void; onUpdate: () => void }) {
	return (
		<div
			data-testid="android-update-card"
			className="pointer-events-auto w-[22rem] max-w-full rounded-lg border border-border bg-popover px-4 py-3 text-sm shadow-lg"
		>
			<span className="font-medium">A new version of LearnHarness is ready</span>
			<p className="mt-1 text-xs text-muted-foreground">It downloads over Wi-Fi and the app restarts when it is done.</p>
			<div className="mt-2.5 flex flex-wrap items-center gap-2">
				<button
					type="button"
					data-testid="android-update-start"
					onClick={onUpdate}
					className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
				>
					Update
				</button>
				<button
					type="button"
					data-testid="android-update-later"
					onClick={onNotNow}
					className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent/50"
				>
					Not now
				</button>
				<a
					href={ANDROID_RELEASE_NOTES_URL}
					target="_blank"
					rel="noreferrer"
					className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					Release notes ↗
				</a>
			</div>
		</div>
	);
}

/** The mounted card: asks the shell once, shows itself when the shell says an update is ready. */
export default function AndroidUpdateCard() {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		const bridge = updateBridge();
		if (!bridge) return;
		const onMessage = (event: MessageEvent) => {
			if (event.data === UPDATE_LINES.available) setReady(true);
		};
		bridge.addEventListener("message", onMessage);
		bridge.postMessage(UPDATE_LINES.probe);
		return () => bridge.removeEventListener("message", onMessage);
	}, []);

	if (!ready) return null;
	return (
		<AndroidUpdateNotice
			onNotNow={() => {
				setReady(false);
				updateBridge()?.postMessage(UPDATE_LINES.later);
			}}
			onUpdate={() => {
				setReady(false);
				updateBridge()?.postMessage(UPDATE_LINES.start);
			}}
		/>
	);
}
