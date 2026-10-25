import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunOutcome } from "../core/answer-check.ts";

/**
 * Run a short Python snippet for the answer-key check (core/answer-check.ts).
 * The learner's own Python: LH_PYTHON, else the first of python3 / python /
 * py -3 that answers `--version` with Python 3 (the Windows Store stub
 * never does). No Python → null, and the check falls back to the second
 * model alone.
 *
 * Each run gets a fresh temp directory as cwd, isolated mode (-I: no
 * environment, user site or script dir on sys.path), stdin closed, a
 * minimal environment (Agg so a plt.show() never opens a window), a
 * 5-second kill and a 64 KB output cap.
 */

const TIMEOUT_MS = 5000;
const OUTPUT_CAP = 64 * 1024;

interface Interpreter {
	cmd: string;
	args: string[];
}

let found: Promise<Interpreter | null> | null = null;

function answersVersion(cmd: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		let out = "";
		let child;
		try {
			child = spawn(cmd, [...args, "--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			resolve(false);
		}, 3000);
		child.stdout.on("data", (d) => (out += String(d)));
		child.stderr.on("data", (d) => (out += String(d)));
		child.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 && /^Python 3\./.test(out.trim()));
		});
	});
}

/** The interpreter, found once per process. */
export function findPython(): Promise<Interpreter | null> {
	found ??= (async () => {
		const candidates: Interpreter[] = [];
		if (process.env.LH_PYTHON) candidates.push({ cmd: process.env.LH_PYTHON, args: [] });
		candidates.push({ cmd: "python3", args: [] }, { cmd: "python", args: [] });
		if (process.platform === "win32") candidates.push({ cmd: "py", args: ["-3"] });
		for (const c of candidates) if (await answersVersion(c.cmd, c.args)) return c;
		return null;
	})();
	return found;
}

/** Run one snippet. null = no Python on this machine. */
export async function runPython(code: string, signal?: AbortSignal): Promise<RunOutcome | null> {
	const py = await findPython();
	if (!py) return null;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-py-"));
	const file = path.join(dir, "snippet.py");
	fs.writeFileSync(file, code, "utf8");
	// Cast: the project types NODE_ENV as always present; this env drops
	// it (and everything else) on purpose.
	const env: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		PYTHONIOENCODING: "utf-8",
		PYTHONUTF8: "1",
		MPLBACKEND: "Agg",
		...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
	};
	try {
		return await new Promise<RunOutcome>((resolve) => {
			const child = spawn(py.cmd, [...py.args, "-I", file], { cwd: dir, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const kill = () => child.kill("SIGKILL");
			const timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, TIMEOUT_MS);
			signal?.addEventListener("abort", kill, { once: true });
			child.stdout.on("data", (d) => {
				if (stdout.length < OUTPUT_CAP) stdout += String(d);
			});
			child.stderr.on("data", (d) => {
				if (stderr.length < OUTPUT_CAP) stderr += String(d);
			});
			child.on("error", (err) => {
				clearTimeout(timer);
				resolve({ ok: false, stdout, stderr: stderr || err.message, timedOut });
			});
			child.on("close", (exitCode) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", kill);
				resolve({ ok: exitCode === 0 && !timedOut, stdout, stderr, timedOut });
			});
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
