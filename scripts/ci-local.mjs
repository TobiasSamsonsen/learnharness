/**
 * ci-local.mjs — `npm run ci:local`: run what CI runs, on Linux, before pushing (fork addition, 2026-11-03).
 *
 * CI is Ubuntu 24.04 + Node 26; the project is developed on Windows, where some tests behave differently, so a green local
 * `npm test` there does not mean a green CI. This runs scripts/ci-local.sh: directly on Linux and macOS, inside WSL on Windows.
 *
 *   LH_CI_WSL=<distro>   the WSL distro to use on Windows (default Ubuntu-24.04)
 *   LH_CI_REF, LH_CI_DIR, LH_CI_WORKTREE   passed through to the script (see its header)
 *
 * One-time WSL setup on Windows: docs/development.md, "Run CI locally before pushing".
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "ci-local.sh");

function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
	if (result.error) {
		console.error(`[ci:local] could not run ${command}: ${result.error.message}`);
		process.exit(2);
	}
	process.exit(result.status ?? 1);
}

if (process.platform !== "win32") {
	run("bash", [SCRIPT, ROOT]);
}

const distro = process.env.LH_CI_WSL || "Ubuntu-24.04";
const probe = spawnSync("wsl", ["-d", distro, "--exec", "true"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
	console.error(`[ci:local] the WSL distro "${distro}" is not available.`);
	console.error("          Set it up once (docs/development.md, \"Run CI locally before pushing\"), or set LH_CI_WSL to another Ubuntu 24.04 distro with Node 26.");
	process.exit(2);
}
// wslpath turns the Windows paths into Linux ones; the repo is passed as $1 so no quoting is needed
const forward = ["LH_CI_REF", "LH_CI_DIR", "LH_CI_WORKTREE"].filter((k) => process.env[k]).map((k) => `${k}=${JSON.stringify(process.env[k])}`).join(" ");
// --exec: no shell in between (wsl.exe would otherwise re-join the arguments and lose the quoting)
run("wsl", [
	"-d", distro, "--exec",
	"bash", "-c", `${forward} bash "$(wslpath -u "$1")/scripts/ci-local.sh" "$(wslpath -u "$1")"`, "_", ROOT,
]);
