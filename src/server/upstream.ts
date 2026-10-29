import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import {
	UPSTREAM_REPO,
	compareVersions,
	upstreamUpdatePrompt,
	type UpstreamRelease,
	type UpstreamStatus,
} from "../core/upstream.ts";
import { settingsStore } from "../store/settings.ts";
import { getClaudeBinary } from "../agent/claude-code/binary.ts";

/**
 * The upstream release notice's server half (fork addition, 2026-10-24) —
 * see src/core/upstream.ts for the model.
 *
 *   - checks GitHub's public API anonymously (60 requests/hour per IP —
 *     one check per CHECK_TTL_MS is far below it); a failure is cached
 *     briefly and reported, never thrown;
 *   - knows the fork's checkout: the folder that built this app
 *     (fork-build.json, written by scripts/build-server.mjs), or the
 *     repo itself when running from source;
 *   - starts Claude Code in that folder, in a visible terminal, with the
 *     update prompt.
 *
 * LH_UPSTREAM_CHECK=0 disables the check; LH_FORK_BASE_VERSION overrides
 * the base version (testing); LH_FORK_REPO pins the checkout.
 */

const CHECK_TTL_MS = 6 * 60 * 60_000;
const FAILURE_TTL_MS = 30 * 60_000;

interface CheckCache {
	at: number;
	latest: UpstreamRelease | null;
	error?: string;
}
const KEY = Symbol.for("lh.upstreamCheck");
function cache(): { value: CheckCache | null } {
	const g = globalThis as Record<symbol, { value: CheckCache | null } | undefined>;
	g[KEY] ??= { value: null };
	return g[KEY];
}

/** The upstream version this build is based on. */
export function forkBaseVersion(): string {
	return process.env.LH_FORK_BASE_VERSION || packageMetadata.version;
}

/** The fork's git checkout, when it can still be found on this machine. */
export function forkRepoPath(): string | null {
	const isRepo = (dir: string | undefined | null) => !!dir && fs.existsSync(path.join(dir, ".git"));
	if (isRepo(process.env.LH_FORK_REPO)) return process.env.LH_FORK_REPO!;
	try {
		const baked = JSON.parse(fs.readFileSync(path.join(PATHS.root, "fork-build.json"), "utf8")) as { repoPath?: string };
		if (isRepo(baked.repoPath)) return baked.repoPath!;
	} catch {
		/* not a packaged build, or built outside a checkout */
	}
	return isRepo(PATHS.root) ? PATHS.root : null;
}

async function fetchLatestRelease(): Promise<UpstreamRelease> {
	const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`, {
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": `learnharness-fork/${packageMetadata.version}`,
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
	const body = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string; name?: string };
	if (!body.tag_name) throw new Error("GitHub's latest release has no tag");
	return {
		version: body.tag_name.replace(/^v/, ""),
		tag: body.tag_name,
		url: body.html_url ?? `https://github.com/${UPSTREAM_REPO}/releases/tag/${body.tag_name}`,
		publishedAt: body.published_at ?? null,
		name: body.name ?? null,
	};
}

async function latestRelease(refresh: boolean): Promise<CheckCache> {
	const c = cache();
	const fresh = c.value && Date.now() - c.value.at < (c.value.error ? FAILURE_TTL_MS : CHECK_TTL_MS);
	if (c.value && fresh && !refresh) return c.value;
	try {
		c.value = { at: Date.now(), latest: await fetchLatestRelease() };
	} catch (err) {
		// keep the last known release through a failed re-check
		c.value = { at: Date.now(), latest: c.value?.latest ?? null, error: err instanceof Error ? err.message : String(err) };
	}
	return c.value;
}

/** GET /api/upstream. */
export async function upstreamStatus({ refresh = false } = {}): Promise<UpstreamStatus> {
	const current = forkBaseVersion();
	const repoPath = forkRepoPath();
	const claudeAvailable = getClaudeBinary() !== null;
	if (process.env.LH_UPSTREAM_CHECK === "0") {
		return { current, latest: null, updateAvailable: false, dismissed: false, repoPath, claudeAvailable, prompt: null };
	}
	const { latest, error } = await latestRelease(refresh);
	const updateAvailable = !!latest && compareVersions(latest.version, current) > 0;
	const dismissed = !!latest && settingsStore.readSettings()?.notices?.dismissedUpstreamVersion === latest.version;
	return {
		current,
		latest,
		updateAvailable,
		dismissed,
		repoPath,
		claudeAvailable,
		prompt: updateAvailable && latest ? upstreamUpdatePrompt(latest, current, process.platform) : null,
		...(error ? { error } : {}),
	};
}

/** Remember the dismissal for exactly this upstream version. */
export function dismissUpstreamVersion(version: string): void {
	const record = settingsStore.readSettings() ?? { version: 1 };
	settingsStore.writeSettings({ ...record, notices: { ...record.notices, dismissedUpstreamVersion: version } });
}

/** The terminal's environment: the user's own, without what the app's
 *  server process carries for itself — NODE_ENV=production would make the
 *  merge's npm ci skip devDependencies; ELECTRON_RUN_AS_NODE breaks any
 *  Electron launched from the terminal; the app's Anthropic key would
 *  bill Claude Code to the API instead of the subscription. */
export function terminalEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) {
		if (/^(NODE_ENV|ELECTRON_RUN_AS_NODE|PORT|HOSTNAME|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/.test(k)) continue;
		if (/^(LH_|__NEXT|NEXT_|ANTHROPIC_)/.test(k)) continue;
		out[k] = v;
	}
	return out;
}

/** POST /api/upstream/claude: open a terminal running Claude Code in the
 *  fork's checkout with the update prompt. */
export async function launchClaudeUpdate(): Promise<{ ok: true } | { ok: false; error: string }> {
	const status = await upstreamStatus();
	if (!status.updateAvailable || !status.prompt || !status.latest) return { ok: false, error: "no upstream update to apply" };
	if (!status.repoPath) return { ok: false, error: "the fork's folder is unknown on this machine — copy the prompt instead" };
	const claude = getClaudeBinary();
	if (!claude) return { ok: false, error: "the claude CLI is not installed — copy the prompt instead" };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-upstream-"));
	// Cast: the project types NODE_ENV as always present; this env drops
	// it on purpose (see terminalEnv).
	const env = terminalEnv(process.env) as NodeJS.ProcessEnv;
	const title = `LearnHarness: update fork to ${status.latest.tag}`;
	try {
		if (process.platform === "win32") {
			// a .cmd script: no prompt text ever crosses a nested cmd /k quote
			const script = path.join(dir, "update-fork.cmd");
			fs.writeFileSync(
				script,
				["@echo off", `title ${title}`, `cd /d "${status.repoPath}"`, `"${claude}" "${status.prompt}"`, ""].join("\r\n"),
			);
			spawn("cmd.exe", ["/c", "start", '""', "cmd.exe", "/k", script], {
				env,
				detached: true,
				stdio: "ignore",
				windowsVerbatimArguments: true,
			}).unref();
		} else {
			const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
			const script = path.join(dir, process.platform === "darwin" ? "update-fork.command" : "update-fork.sh");
			fs.writeFileSync(script, `#!/bin/bash\ncd ${q(status.repoPath)}\nexec ${q(claude)} ${q(status.prompt)}\n`, { mode: 0o755 });
			const [cmd, args] =
				process.platform === "darwin" ? ["open", ["-a", "Terminal", script]] : ["x-terminal-emulator", ["-e", "bash", script]];
			const child = spawn(cmd, args, { env, detached: true, stdio: "ignore" });
			await new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.once("spawn", () => resolve());
			});
			child.unref();
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: `could not open a terminal: ${err instanceof Error ? err.message : String(err)}` };
	}
}
