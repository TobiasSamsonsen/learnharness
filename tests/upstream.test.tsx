/**
 * The upstream release notice (fork addition, 2026-10-24): version logic,
 * the Claude prompt, the terminal environment, the status/dismiss cycle
 * against a stubbed GitHub, and the notice's render. No network: fetch is
 * replaced; LH_DATA_DIR isolates the settings record.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-upstream-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { compareVersions, parseVersion, upstreamUpdatePrompt, UPSTREAM_URL } = await import("../src/core/upstream.ts");
const { upstreamStatus, dismissUpstreamVersion, forkRepoPath, terminalEnv } = await import("../src/server/upstream.ts");
const { UpstreamNotice, showUpstreamNotice, canLaunchClaude } = await import("../components/upstream-banner.tsx");

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

/** GitHub's /releases/latest answering with `tag` (or failing with `status`). */
function stubGitHub(tag: string | null, status = 200) {
	globalThis.fetch = (async (url: string | URL) => {
		assert.match(String(url), /api\.github\.com\/repos\/amosblomqvist\/learnharness\/releases\/latest$/);
		if (!tag) return new Response("{}", { status });
		return Response.json({ tag_name: tag, html_url: `${UPSTREAM_URL}/releases/tag/${tag}`, published_at: "2026-10-30T00:00:00Z", name: tag });
	}) as typeof fetch;
}

const release = { version: "0.3.5", tag: "v0.3.5", url: `${UPSTREAM_URL}/releases/tag/v0.3.5`, publishedAt: null, name: null };

describe("versions", () => {
	it("parses x.y.z with or without v and compares numerically", () => {
		assert.deepEqual(parseVersion("v0.3.10"), [0, 3, 10]);
		assert.equal(parseVersion("0.3"), null);
		assert.ok(compareVersions("0.3.10", "0.3.9") > 0, "10 > 9 numerically, not as text");
		assert.ok(compareVersions("v0.4.0", "0.3.99") > 0);
		assert.equal(compareVersions("0.3.4", "v0.3.4"), 0);
		assert.equal(compareVersions("nightly", "0.3.4"), 0, "unparseable never claims an update");
	});
});

describe("the Claude prompt", () => {
	it("names the release, the remote, the fork's features and the gates", () => {
		const p = upstreamUpdatePrompt(release, "0.3.4", "win32");
		assert.match(p, /from upstream 0\.3\.4 to upstream release v0\.3\.5/);
		assert.match(p, /github\.com\/amosblomqvist\/learnharness/);
		assert.match(p, /claude-code provider/);
		assert.match(p, /lesson languages/);
		assert.match(p, /local dictation/);
		assert.match(p, /npm test/);
		assert.match(p, /npm run desktop:dist:win/);
		assert.match(p, /ask me before pushing/);
		assert.doesNotMatch(upstreamUpdatePrompt(release, "0.3.4", "darwin"), /desktop:dist:win/);
	});

	it("never carries a double quote or a percent sign (it rides a cmd.exe line)", () => {
		const p = upstreamUpdatePrompt({ ...release, url: 'https://x/"100%"' }, "0.3.4", "win32");
		assert.doesNotMatch(p, /["%]/);
	});
});

describe("the terminal environment", () => {
	it("drops the app server's own variables and keys, keeps the user's", () => {
		const env = terminalEnv({
			PATH: "p",
			USERPROFILE: "u",
			NODE_ENV: "production",
			ELECTRON_RUN_AS_NODE: "1",
			PORT: "3000",
			LH_DATA_DIR: "d",
			ANTHROPIC_API_KEY: "k",
			__NEXT_PRIVATE_X: "x",
			CLAUDECODE: "1",
		} as unknown as NodeJS.ProcessEnv);
		assert.deepEqual(env, { PATH: "p", USERPROFILE: "u" });
	});
});

describe("status and dismissal", () => {
	it("a newer upstream release is an update; the prompt rides along", async () => {
		process.env.LH_FORK_BASE_VERSION = "0.3.4";
		stubGitHub("v0.3.5");
		const s = await upstreamStatus({ refresh: true });
		assert.equal(s.current, "0.3.4");
		assert.equal(s.latest?.version, "0.3.5");
		assert.equal(s.updateAvailable, true);
		assert.equal(s.dismissed, false);
		assert.match(s.prompt ?? "", /v0\.3\.5/);
		assert.equal(showUpstreamNotice(s), true);
	});

	it("dismissing hides exactly that release; the next one shows again", async () => {
		dismissUpstreamVersion("0.3.5");
		assert.equal((await upstreamStatus()).dismissed, true, "cached check, dismissed");
		stubGitHub("v0.3.6");
		const next = await upstreamStatus({ refresh: true });
		assert.equal(next.dismissed, false);
		assert.equal(showUpstreamNotice(next), true);
	});

	it("the same or an older upstream version is not an update", async () => {
		stubGitHub("v0.3.4");
		const s = await upstreamStatus({ refresh: true });
		assert.equal(s.updateAvailable, false);
		assert.equal(s.prompt, null);
		assert.equal(showUpstreamNotice(s), false);
	});

	it("a failed check reports, never throws, and keeps the last known release", async () => {
		stubGitHub(null, 403);
		const s = await upstreamStatus({ refresh: true });
		assert.match(s.error ?? "", /GitHub answered 403/);
		assert.equal(s.latest?.version, "0.3.4", "the last known release survives");
	});

	it("LH_UPSTREAM_CHECK=0 turns the check off", async () => {
		process.env.LH_UPSTREAM_CHECK = "0";
		try {
			globalThis.fetch = (() => assert.fail("no network when disabled")) as typeof fetch;
			const s = await upstreamStatus({ refresh: true });
			assert.equal(s.latest, null);
			assert.equal(s.updateAvailable, false);
		} finally {
			delete process.env.LH_UPSTREAM_CHECK;
		}
	});

	it("the fork's checkout: an LH_FORK_REPO pin with a .git folder", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fork-repo-"));
		fs.mkdirSync(path.join(repo, ".git"));
		process.env.LH_FORK_REPO = repo;
		try {
			assert.equal(forkRepoPath(), repo);
		} finally {
			delete process.env.LH_FORK_REPO;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("the notice — render", () => {
	const status: import("../src/core/upstream.ts").UpstreamStatus = {
		current: "0.3.4",
		latest: release,
		updateAvailable: true,
		dismissed: false,
		repoPath: "C:\\src\\learnharness",
		claudeAvailable: true,
		prompt: "PROMPT",
	};
	const render = (s: import("../src/core/upstream.ts").UpstreamStatus) =>
		renderToStaticMarkup(<UpstreamNotice status={s} onDismiss={() => {}} onLaunch={async () => null} />);

	it("offers Claude Code, the prompt, the notes and a dismiss", () => {
		const html = render(status);
		assert.match(html, /LearnHarness v0\.3\.5 is out upstream/);
		assert.match(html, /this fork is on 0\.3\.4/);
		assert.match(html, /data-testid="upstream-launch"/);
		assert.match(html, /data-testid="upstream-copy"/);
		assert.match(html, /href="https:\/\/github\.com\/amosblomqvist\/learnharness\/releases\/tag\/v0\.3\.5"/);
		assert.match(html, /data-testid="upstream-dismiss"/);
	});

	it("without the fork's folder or the CLI, only the prompt is offered", () => {
		assert.equal(canLaunchClaude({ ...status, repoPath: null }), false);
		assert.equal(canLaunchClaude({ ...status, claudeAvailable: false }), false);
		const html = render({ ...status, repoPath: null });
		assert.doesNotMatch(html, /upstream-launch/);
		assert.match(html, /upstream-copy/);
	});
});
