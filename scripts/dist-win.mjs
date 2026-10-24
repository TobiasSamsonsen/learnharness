/**
 * dist-win.mjs — build the Windows installer locally (fork addition,
 * 2026-10-24): `npm run desktop:dist:win`, run ON Windows.
 *
 * The same pipeline the release workflow's windows-2025 job runs (see
 * docs/desktop-release.md), in plain Node so it works from cmd.exe and
 * PowerShell as well as Git Bash:
 *
 *   1. clean dist/ and the previous standalone tree
 *   2. make sure Electron's binary is present (installs that skipped the
 *      download, e.g. ELECTRON_SKIP_BINARY_DOWNLOAD=1, lack it)
 *   3. next build → 4. smoke-provider-runtime.mjs (the fresh trace)
 *   5. build-server.mjs → 6. smoke-server.mjs --electron
 *   7. electron-builder --win --x64 --publish never
 *   8. smoke-provider-runtime.mjs on dist/win-unpacked, under host Node
 *      and under the packaged LearnHarness.exe
 *
 * The result is the unsigned per-user NSIS installer
 * dist/LearnHarness-<version>-x64-setup.exe. Never cross-build: the
 * standalone server carries the build machine's native binaries.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

if (process.platform !== "win32") {
	console.error("[dist-win] run this on Windows — the server payload carries this machine's native binaries.");
	process.exit(1);
}

function run(label, command, args) {
	console.log(`\n[dist-win] ${label}: ${command} ${args.join(" ")}`);
	// shell: npx/electron-builder are .cmd shims on Windows
	const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: true });
	if (result.status !== 0) {
		console.error(`[dist-win] ${label} failed (exit ${result.status ?? result.signal}).`);
		process.exit(result.status ?? 1);
	}
}

for (const dir of ["dist", path.join(".next", "standalone")]) {
	fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
}

if (!fs.existsSync(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"))) {
	run("fetch the Electron binary", "node", [path.join("node_modules", "electron", "install.js")]);
}

run("build", "npx", ["next", "build"]);
// Check the fresh trace before any static copying/curation.
run("initialize providers offline (fresh trace)", "node", [path.join("scripts", "smoke-provider-runtime.mjs")]);
run("curate the server payload", "node", [path.join("scripts", "build-server.mjs")]);
run("smoke-boot the server in Electron's Node", "node", [path.join("scripts", "smoke-server.mjs"), "--electron"]);
run("package", "npx", ["electron-builder", "--win", "--x64", "--publish", "never"]);

const unpacked = path.join("dist", "win-unpacked");
const payload = path.join(unpacked, "resources", "server", "standalone");
run("initialize packaged providers offline (host Node)", "node", [path.join("scripts", "smoke-provider-runtime.mjs"), "--standalone", payload]);
run("initialize packaged providers offline (packaged Electron Node)", "node", [path.join("scripts", "smoke-provider-runtime.mjs"), "--standalone", payload, "--runtime", path.join(unpacked, "LearnHarness.exe")]);

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const installer = path.join(ROOT, "dist", `LearnHarness-${version}-x64-setup.exe`);
if (!fs.existsSync(installer)) {
	console.error(`[dist-win] expected installer missing: ${installer}`);
	process.exit(1);
}
console.log(`\n[dist-win] installer ready: ${installer}`);
