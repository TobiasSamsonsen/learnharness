import type { ReplacePreview, SyncStatus, UserSettings } from "../../src/core/index.ts";

/**
 * The Sync settings screen's requests (fork addition, 2026-11-02), apart from
 * the component so they are tested without a DOM. Each answers `null` (or a
 * value) on success and an error sentence on failure; none throws.
 */

export const SYNC_TOKEN_ID = "LH_GITHUB_SYNC_TOKEN";

async function problem(res: Response, fallback: string): Promise<string> {
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	return body.error ?? `${fallback} (${res.status})`;
}

async function send(method: string, url: string, body: unknown, fallback: string): Promise<string | null> {
	try {
		const res = await fetch(url, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return res.ok ? null : await problem(res, fallback);
	} catch {
		return fallback;
	}
}

/** The sync status and the repo saved on this device. Either is null when it could not be read. */
export async function loadSyncState(): Promise<{ status: SyncStatus | null; repo: string | null }> {
	const [s, r] = await Promise.all([
		fetch("/api/sync", { cache: "no-store" }).catch(() => null),
		fetch("/api/settings", { cache: "no-store" }).catch(() => null),
	]);
	const status = s?.ok ? ((await s.json().catch(() => null)) as SyncStatus | null) : null;
	let repo: string | null = null;
	if (r?.ok) {
		const body = (await r.json().catch(() => null)) as { settings: UserSettings | null } | null;
		repo = body ? (body.settings?.sync?.repo ?? "") : null;
	}
	return { status, repo };
}

/** Save the repo (empty turns sync off). */
export const saveSyncRepo = (repo: string): Promise<string | null> => send("PUT", "/api/settings/sync", { repo }, "Could not save the repository");

/** Store the token in the key store. It is never read back. */
export const saveSyncToken = (value: string): Promise<string | null> => send("PUT", `/api/keys/${SYNC_TOKEN_ID}`, { value }, "Could not save the token");

export const removeSyncToken = (): Promise<string | null> => send("DELETE", `/api/keys/${SYNC_TOKEN_ID}`, undefined, "Could not remove the token");

/** What replacing this device with the repo would change (changes nothing). */
export async function previewReplace(): Promise<{ preview: ReplacePreview | null; error: string | null }> {
	try {
		const res = await fetch("/api/sync/replace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun: true }) });
		if (!res.ok) return { preview: null, error: await problem(res, "Could not check the repo") };
		const body = (await res.json()) as { preview: ReplacePreview | null; error: { message: string } | null };
		return { preview: body.preview, error: body.error?.message ?? null };
	} catch {
		return { preview: null, error: "Could not check the repo" };
	}
}

/** Replace this device's synced data with the repo's. Resolves when it has finished; a refusal comes back in the status' error. */
export async function replaceFromRepo(): Promise<{ status: SyncStatus | null; error: string | null }> {
	try {
		const res = await fetch("/api/sync/replace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
		if (!res.ok) return { status: null, error: await problem(res, "Replace failed") };
		return { status: (await res.json()) as SyncStatus, error: null };
	} catch {
		return { status: null, error: "Replace failed" };
	}
}

/** Run a round now; resolves when it has finished. */
export async function runSyncRound(): Promise<{ status: SyncStatus | null; error: string | null }> {
	try {
		const res = await fetch("/api/sync/run", { method: "POST" });
		if (!res.ok) return { status: null, error: await problem(res, "Sync failed") };
		return { status: (await res.json()) as SyncStatus, error: null };
	} catch {
		return { status: null, error: "Sync failed" };
	}
}
