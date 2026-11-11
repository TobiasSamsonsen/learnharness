/**
 * The status-color law (theme wave, 2026-11-04): error / success / warning
 * chrome uses the theme tokens (text-error, bg-success/15, …) — never a
 * fixed Tailwind palette class, which would ignore the active theme.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const PALETTE = /\b(text|bg|border|fill|stroke|ring)-(red|green|amber)-[0-9]{3}/;
/** The same rule as the git grep, for a tree without .git: every file under components/ and app/. */
function scanForPaletteClasses(root: string): string {
	const hits: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); continue; }
			fs.readFileSync(full, "utf8").split(/\r?\n/).forEach((line, i) => { if (PALETTE.test(line)) hits.push(`${path.relative(root, full)}:${i + 1}:${line}`); });
		}
	};
	for (const dir of ["components", "app"]) walk(path.join(root, dir));
	return hits.join("\n");
}

describe("status colors are theme tokens", () => {
	it("no red/green/amber palette class is left under components/ or app/", () => {
		let out = "";
		try {
			out = execFileSync(
				"git",
				["grep", "--untracked", "-n", "-E", "\\b(text|bg|border|fill|stroke|ring)-(red|green|amber)-[0-9]{3}", "--", "components", "app"],
				{ cwd: new URL("..", import.meta.url), encoding: "utf8" },
			).trim();
		} catch (e) {
			// git grep exits 1 when nothing matches — the passing case. Outside a git checkout (ci:local's copy of the tree) it
			// exits 128: scan the files directly instead.
			const status = (e as { status?: number }).status;
			if (status === 128) out = scanForPaletteClasses(new URL("..", import.meta.url).pathname);
			else if (status !== 1) throw e;
		}
		assert.equal(out, "");
	});
});
