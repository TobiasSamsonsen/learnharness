/**
 * Upstream release notices (fork addition, 2026-10-24). PURE, browser-safe.
 *
 * This build is a fork of amosblomqvist/learnharness. The fork keeps
 * upstream's version number as its own (package.json "version"), so the
 * version a build carries IS the upstream release it is based on — and a
 * merge of a newer upstream release brings that release's version bump
 * with it. "Is upstream ahead?" is therefore a plain version comparison
 * against upstream's latest PUBLISHED GitHub release (drafts and
 * prereleases excluded).
 *
 * When it is ahead, the app offers to start Claude Code in the fork's
 * checkout with the prompt below: merge the release, keep the fork's
 * features, run the gates, rebuild the installer.
 */

export const UPSTREAM_REPO = "amosblomqvist/learnharness";
export const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPO}`;

/** One upstream release as the notice needs it. */
export interface UpstreamRelease {
	/** "0.3.5" — the tag without its leading v. */
	version: string;
	tag: string;
	url: string;
	publishedAt: string | null;
	name: string | null;
}

/** GET /api/upstream. */
export interface UpstreamStatus {
	/** The upstream version this build is based on. */
	current: string;
	/** Upstream's latest published release; null when unknown (offline, rate-limited). */
	latest: UpstreamRelease | null;
	/** latest is newer than current. */
	updateAvailable: boolean;
	/** The user dismissed the notice for exactly this upstream version. */
	dismissed: boolean;
	/** The fork's git checkout this app was built from, when it still exists. */
	repoPath: string | null;
	/** The `claude` CLI is installed (the one-click path needs it). */
	claudeAvailable: boolean;
	/** The Claude Code prompt for this update (null when there is none). */
	prompt: string | null;
	/** Why the last check failed, if it did. */
	error?: string;
}

/** "v0.3.5" / "0.3.5" → [0, 3, 5]; null for anything that isn't x.y.z. */
export function parseVersion(version: string): [number, number, number] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Positive when a > b, negative when a < b, 0 when equal or unparseable. */
export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return 0;
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
	return 0;
}

/** The fork's own features, which an upstream merge must keep. */
export const FORK_FEATURES = [
	"the claude-code provider that runs agents on a Claude subscription (src/agent/claude-code.ts)",
	"lesson languages and the language directives (src/core/language.ts)",
	"local dictation with the Whisper worker (src/server/stt-local.ts, src/server/stt/worker.mjs)",
	"the upstream release notice (src/core/upstream.ts)",
	"the fork's own update feed (owner TobiasSamsonsen in electron-builder.yml)",
] as const;

/**
 * The Claude Code prompt that updates the fork to an upstream release.
 * It is handed to the CLI on a Windows command line, so it never contains
 * a double quote or a percent sign (sanitized at the end, belt and
 * braces). Pure.
 */
export function upstreamUpdatePrompt(release: UpstreamRelease, current: string, platform: string): string {
	const build =
		platform === "win32"
			? "rebuild the Windows installer with npm run desktop:dist:win"
			: "rebuild the desktop app as docs/desktop-release.md describes for this platform";
	const prompt = [
		`Update this LearnHarness fork from upstream ${current} to upstream release ${release.tag}.`,
		`Upstream is ${UPSTREAM_URL} - add it as the git remote named upstream if it is missing, and fetch its tags.`,
		`Create a branch from the current branch and merge the tag ${release.tag} into it.`,
		`Resolve conflicts so that upstream's changes come in and the fork keeps its own features: ${FORK_FEATURES.join("; ")}.`,
		`Keep package.json's version equal to upstream's (${release.version}): the app compares it with upstream's releases.`,
		`Then run npm ci, npm run typecheck, npm run lint and npm test, fix what the merge broke, and ${build}.`,
		`Release notes: ${release.url}`,
		`Finish with a short summary of what upstream changed and which conflicts you resolved, and ask me before pushing or merging into main.`,
	].join(" ");
	return prompt.replace(/"/g, "'").replace(/%/g, " percent");
}
