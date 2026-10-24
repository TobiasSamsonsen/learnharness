"use client";

/**
 * The upstream release notice (fork addition, 2026-10-24): a small card,
 * bottom-right beside the auto-update banner, shown when upstream
 * (amosblomqvist/learnharness) has published a release newer than the
 * version this fork is based on. Server truth: GET /api/upstream
 * (src/server/upstream.ts — cached, so re-reading is cheap).
 *
 *   Update with Claude Code  opens a terminal running Claude Code in the
 *                            fork's checkout with the merge prompt (only
 *                            when that folder and the CLI exist here).
 *   Copy prompt              the same prompt to paste anywhere.
 *   Release notes            upstream's release page (real browser).
 *   ✕                        hides it until the NEXT upstream release.
 */

import { useCallback, useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import type { UpstreamStatus } from "@/src/core";

/** Re-read cadence; the server checks GitHub at most every 6 hours. */
const POLL_MS = 60 * 60_000;

/** Show the notice? Pure — exported for pins. */
export function showUpstreamNotice(status: UpstreamStatus | null): boolean {
	return !!status?.updateAvailable && !status.dismissed && !!status.latest;
}

/** Can the one-click path run on this machine? Pure. */
export function canLaunchClaude(status: UpstreamStatus): boolean {
	return !!status.repoPath && status.claudeAvailable;
}

export function UpstreamNotice({
	status,
	onDismiss,
	onLaunch,
}: {
	status: UpstreamStatus;
	onDismiss: () => void;
	onLaunch: () => Promise<string | null>;
}) {
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [showPrompt, setShowPrompt] = useState(false);
	const latest = status.latest!;

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(status.prompt ?? "");
			setNote("Prompt copied — paste it into Claude Code in your fork's folder.");
		} catch {
			setShowPrompt(true); // no clipboard access: select it by hand
		}
	};

	return (
		<div
			data-testid="upstream-banner"
			className="pointer-events-auto w-[22rem] rounded-lg border border-border bg-popover px-4 py-3 text-sm shadow-lg"
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<span className="font-medium">LearnHarness {latest.tag} is out upstream</span>
					<span className="text-muted-foreground"> — this fork is on {status.current}.</span>
				</div>
				<button
					type="button"
					aria-label="Dismiss until the next upstream release"
					data-testid="upstream-dismiss"
					onClick={onDismiss}
					className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">
				Claude Code can merge it into your fork, keep the fork&apos;s features, run the tests and rebuild the app.
			</p>
			<div className="mt-2.5 flex flex-wrap items-center gap-2">
				{canLaunchClaude(status) && (
					<button
						type="button"
						data-testid="upstream-launch"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							const error = await onLaunch();
							setBusy(false);
							setNote(error ?? "Claude Code opened in a terminal — continue there.");
						}}
						className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80 disabled:opacity-50"
					>
						Update with Claude Code
					</button>
				)}
				<button
					type="button"
					data-testid="upstream-copy"
					onClick={() => void copy()}
					className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent/50"
				>
					Copy prompt
				</button>
				<a
					href={latest.url}
					target="_blank"
					rel="noreferrer"
					className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					Release notes ↗
				</a>
			</div>
			{note && (
				<p className="mt-2 text-xs text-muted-foreground" data-testid="upstream-note">
					{note}
				</p>
			)}
			{showPrompt && (
				<textarea
					readOnly
					value={status.prompt ?? ""}
					onFocus={(e) => e.currentTarget.select()}
					className="mt-2 h-28 w-full resize-none rounded-sm border border-border bg-background p-1.5 font-mono text-[11px]"
				/>
			)}
		</div>
	);
}

/** The mounted notice: reads the status, polls, wires the actions. */
export default function UpstreamBanner() {
	const [status, setStatus] = useState<UpstreamStatus | null>(null);
	const read = useCallback(() => {
		fetch("/api/upstream")
			.then((r) => (r.ok ? (r.json() as Promise<UpstreamStatus>) : null))
			.then((s) => s && setStatus(s))
			.catch(() => {});
	}, []);
	useEffect(() => {
		read();
		const id = setInterval(read, POLL_MS);
		return () => clearInterval(id);
	}, [read]);

	if (!status || !showUpstreamNotice(status)) return null;
	return (
		<UpstreamNotice
			status={status}
			onDismiss={() => {
				const version = status.latest!.version;
				setStatus({ ...status, dismissed: true });
				void fetch("/api/upstream", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ dismissedUpstreamVersion: version }),
				}).catch(() => {});
			}}
			onLaunch={async () => {
				try {
					const res = await fetch("/api/upstream/claude", { method: "POST" });
					const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
					return res.ok && body.ok ? null : (body.error ?? `could not start Claude Code (${res.status})`);
				} catch {
					return "could not reach the app's server";
				}
			}}
		/>
	);
}
