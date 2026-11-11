"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { replacePreviewLines, syncNotes, syncStatusLine, type ReplacePreview, type SyncStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "./controls";
import { loadSyncState, previewReplace, removeSyncToken, replaceFromRepo, runSyncRound, saveSyncRepo, saveSyncToken } from "./sync-client.ts";

/**
 * Settings → Sync (fork addition, 2026-11-02): keep chats, courses, sketches
 * and the graph in step across devices through a private GitHub repo. The
 * repo name is a per-device setting (settings.json `sync.repo`), the token
 * goes to the key store (LH_GITHUB_SYNC_TOKEN) and is never read back. Clear
 * the repo, or remove the token, to turn sync off. The server does the work
 * (src/server/sync-service.ts); this screen sets it up and shows how it went.
 */

const FIELD =
	"h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const LINK = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";

export function SyncSection() {
	const [status, setStatus] = useState<SyncStatus | null>(null);
	const [savedRepo, setSavedRepo] = useState<string | null>(null);
	const [repo, setRepo] = useState("");
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** The confirmation for "replace this device with the repo": null when closed. */
	const [confirm, setConfirm] = useState<ReplacePreview | null>(null);
	const [replacing, setReplacing] = useState(false);
	const loaded = useRef(false);

	const load = useCallback(async () => {
		const { status: next, repo: saved } = await loadSyncState();
		if (next) setStatus(next);
		else setError("Could not load the sync status.");
		if (saved !== null) {
			setSavedRepo(saved);
			if (!loaded.current) setRepo(saved);
			loaded.current = true;
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// While a round runs (started here, by the loop, or on another tab), look again every 2 seconds.
	useEffect(() => {
		if (!status?.running) return;
		const id = setInterval(() => void load(), 2000);
		return () => clearInterval(id);
	}, [status?.running, load]);

	/** Run one of the save/remove requests with the busy flag and error line around it. */
	async function act(request: () => Promise<string | null>, after?: () => void): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const failed = await request();
			if (failed) return setError(failed);
			after?.();
			await load();
		} finally {
			setBusy(false);
		}
	}

	const saveRepo = () =>
		act(() => saveSyncRepo(repo), () => {
			notifySettingsSaved("sync");
			loaded.current = false; // adopt the normalised value the server stored
		});
	const saveToken = () =>
		act(() => saveSyncToken(token), () => {
			setToken(""); // the token is not kept on screen
			notifySettingsSaved("keys");
		});
	const removeToken = () => act(removeSyncToken, () => notifySettingsSaved("keys"));

	async function syncNow(): Promise<void> {
		setError(null);
		setStatus((s) => (s ? { ...s, running: true } : s));
		const { status: next, error: failed } = await runSyncRound();
		if (next) setStatus(next);
		else {
			setError(failed);
			await load();
		}
	}

	/** Ask the server what replacing would change, then show it for confirmation. Changes nothing yet. */
	async function openReplace(): Promise<void> {
		setError(null);
		setReplacing(true);
		const { preview, error: failed } = await previewReplace();
		setReplacing(false);
		if (preview) setConfirm(preview);
		else setError(failed ?? "Could not check the repo");
	}

	async function doReplace(): Promise<void> {
		setError(null);
		setReplacing(true);
		const { status: next, error: failed } = await replaceFromRepo();
		setReplacing(false);
		setConfirm(null);
		if (next) setStatus(next);
		else {
			setError(failed);
			await load();
		}
	}

	const repoChanged = repo.trim() !== (savedRepo ?? "");
	const notes = syncNotes(status);

	return (
		<div className="flex flex-col gap-3" data-testid="sync-section">
			<p className="text-xs leading-relaxed text-muted-foreground">
				Keeps your chats, courses, sketches and knowledge graph in step across devices through a <strong className="font-medium">private</strong> GitHub
				repository you create. Make an empty private repo, then a fine-grained token limited to that repo with Contents set to read and write.{" "}
				<a
					href="https://github.com/settings/personal-access-tokens/new"
					target="_blank"
					rel="noreferrer"
					className="underline underline-offset-2 hover:text-foreground"
				>
					Create a token ↗
				</a>
			</p>

			<SettingsRow label="Repository" hint="owner/repo" testid="sync-repo-row">
				<span className="flex min-w-0 flex-1 items-center justify-end gap-2">
					<input
						type="text"
						value={repo}
						onChange={(e) => setRepo(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && repoChanged) void saveRepo();
						}}
						placeholder="you/learnharness-sync"
						aria-label="Sync repository"
						data-testid="sync-repo-input"
						disabled={busy}
						spellCheck={false}
						autoCapitalize="off"
						className={FIELD}
					/>
					<button type="button" onClick={() => void saveRepo()} disabled={busy || !repoChanged} data-testid="sync-repo-save" className={LINK}>
						Save
					</button>
				</span>
			</SettingsRow>

			<SettingsRow label="Token" hint={status?.hasToken ? "A token is saved on this device" : "Not saved yet"} testid="sync-token-row">
				<span className="flex min-w-0 flex-1 items-center justify-end gap-2">
					<input
						type="password"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && token.trim()) void saveToken();
						}}
						placeholder={status?.hasToken ? "Paste a new token to replace it…" : "Paste token…"}
						aria-label="GitHub token"
						data-testid="sync-token-input"
						disabled={busy}
						autoComplete="off"
						className={FIELD}
					/>
					<button type="button" onClick={() => void saveToken()} disabled={busy || !token.trim()} data-testid="sync-token-save" className={LINK}>
						Save
					</button>
					{status?.hasToken && (
						<button
							type="button"
							onClick={() => void removeToken()}
							disabled={busy}
							data-testid="sync-token-remove"
							className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-error hover:underline"
						>
							Remove
						</button>
					)}
				</span>
			</SettingsRow>

			{error && (
				<p role="alert" data-testid="sync-error" className="text-xs text-error">
					{error}
				</p>
			)}

			<div className="flex flex-wrap items-center gap-3">
				<Button
					type="button"
					size="xs"
					variant="outline"
					className="lh-hit cursor-pointer disabled:cursor-not-allowed"
					disabled={busy || !status?.configured || status.running}
					onClick={() => void syncNow()}
					data-testid="sync-run"
				>
					Sync now
				</Button>
				<button
					type="button"
					onClick={() => void openReplace()}
					disabled={busy || replacing || !status?.configured || status.running || confirm !== null}
					data-testid="sync-replace-open"
					className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-error hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
				>
					Replace this device with the repo…
				</button>
				<span role="status" data-testid="sync-status" className={`text-xs ${status?.error ? "text-error" : "text-muted-foreground"}`}>
					{syncStatusLine(status)}
				</span>
			</div>
			{confirm && (
				<div role="alertdialog" aria-label="Replace this device with the repo" data-testid="sync-replace-confirm" className="flex flex-col gap-2 rounded-sm border border-error/40 p-3">
					<p className="text-xs font-medium text-foreground">Replace this device with the repo?</p>
					<p className="text-xs leading-relaxed text-muted-foreground">This device will end up with exactly what the repo has. Nothing is sent to the repo.</p>
					<p data-testid="sync-replace-remove" className="text-xs leading-relaxed text-foreground">{replacePreviewLines(confirm).remove}</p>
					<p data-testid="sync-replace-write" className="text-xs leading-relaxed text-muted-foreground">{replacePreviewLines(confirm).write}</p>
					<p className="text-xs leading-relaxed text-muted-foreground">
						A copy of everything replaced or removed is kept first, in the app&apos;s data folder under sync/. Settings that belong to this device, your token and original source files are not touched.
					</p>
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={() => void doReplace()}
							disabled={replacing}
							data-testid="sync-replace-confirm-run"
							className="shrink-0 text-xs text-error underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
						>
							{replacing ? "Replacing…" : "Replace this device"}
						</button>
						<button
							type="button"
							onClick={() => setConfirm(null)}
							disabled={replacing}
							data-testid="sync-replace-cancel"
							className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
						>
							Cancel
						</button>
					</div>
				</div>
			)}
			{notes.map((line) => (
				<p key={line} className="text-xs leading-relaxed text-muted-foreground">
					{line}
				</p>
			))}
			<p className="text-xs leading-relaxed text-muted-foreground/70">
				Syncs on start, every few minutes, and a little after you stop working. Settings that belong to this device (custom provider, Claude Code, dictation,
				appearance) and original source files stay here. Chats are stored readable in the repo.
			</p>
		</div>
	);
}
