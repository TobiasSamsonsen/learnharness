/**
 * smoke-headless.mjs — boot the standalone server the way the Android start
 * script does (Android plan M6) and prove the headless hardening: token
 * cookie auth on pages and API, the Host/Origin checks, the public health
 * probe, the pairing redirect, and one full chat turn through the real
 * claude-code provider against the fake CLI (tests/fixtures/claude-code) — found on PATH like a real `claude`, and
 * switched on through the Settings route like the owner's opt-in.
 *
 * Companion to smoke-server.mjs (the Electron-payload gate, which stays
 * untouched): that one runs open, this one runs in token mode. Run after
 * `next build` + `node scripts/build-server.mjs`; the linux-arm64 workflow
 * does exactly that. The child is ALWAYS killed before exit.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const SERVER = path.join(STANDALONE, "server.js");
const FAKE = path.join(ROOT, "tests", "fixtures", "claude-code", "fake-claude.mjs");
const BOOT_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 60_000;
const TOKEN = "smoke-" + "0123456789abcdef".repeat(4);
const SCENARIO = path.join(ROOT, "tests", "fixtures", "claude-code", "text.jsonl");
const REPLY = "hello there"; // what text.jsonl streams

if (!fs.existsSync(SERVER)) {
	console.error("[smoke-headless] .next/standalone/server.js missing — run next build and scripts/build-server.mjs first.");
	process.exit(1);
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function check(cond, message) {
	if (!cond) throw new Error(message);
	console.log(`[smoke-headless] ok: ${message}`);
}

/** A `claude` on PATH for the provider to find: a shim that runs the fake CLI with this Node. */
function fakeClaudeBin(dir) {
	if (process.platform === "win32") {
		const file = path.join(dir, "claude.cmd");
		fs.writeFileSync(file, `@"${process.execPath}" "${FAKE}" %*\r\n`);
		return file;
	}
	const file = path.join(dir, "claude");
	fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
	return file;
}

async function main() {
	const port = await freePort();
	const host = `127.0.0.1:${port}`;
	const base = `http://${host}`;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-headless-"));
	const authFile = path.join(home, "auth.json");
	fs.writeFileSync(authFile, "{}\n", "utf-8");
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin);
	fakeClaudeBin(bin);

	const tail = [];
	const keep = (buf) => {
		for (const line of buf.toString().split("\n")) tail.push(line);
		while (tail.length > 60) tail.shift();
	};
	const child = spawn(process.execPath, [SERVER], {
		cwd: STANDALONE,
		env: {
			...probeEnv(process.env, home),
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			LH_AUTH_FILE: authFile,
			LH_UPSTREAM_CHECK: "0",
			PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
			FAKE_CLAUDE_SCENARIO: SCENARIO,
			LH_CLAUDE_CODE_MAX_SESSIONS: "2",
			// after probeEnv: it strips every *TOKEN* variable
			LH_ACCESS_TOKEN: TOKEN,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let exited = false;
	child.stdout.on("data", keep);
	child.stderr.on("data", keep);
	child.on("exit", () => {
		exited = true;
	});
	const kill = () =>
		new Promise((resolve) => {
			if (exited) return resolve();
			child.once("exit", () => resolve());
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!exited) {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}
				resolve();
			}, 3000);
		});

	/** fetch that never follows redirects and always names its Host. */
	const hit = (url, init = {}) => fetch(base + url, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init, headers: { ...init.headers } });

	let failed = null;
	try {
		// boot: /api/health is public, so it answers before pairing
		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		let health = null;
		while (Date.now() < deadline) {
			if (exited) throw new Error("server exited before answering");
			try {
				const res = await hit("/api/health");
				if (res.status === 200) {
					health = await res.json();
					break;
				}
			} catch {
				/* not up yet */
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		if (!health) throw new Error("server never answered /api/health");
		check(health.ok === true && health.tokenMode === true && typeof health.version === "string", `GET /api/health is public: ${JSON.stringify(health)}`);
		check(Object.keys(health).length === 3, "health exposes nothing beyond ok, version, tokenMode");

		// unpaired
		const page = await hit("/");
		check(page.status === 403 && /text\/html/.test(page.headers.get("content-type") ?? ""), "GET / without the cookie → 403 page");
		check(!(await page.text()).includes("chat"), "the 403 page renders no app data");
		check((await hit("/api/chats")).status === 403, "GET /api/chats without the cookie → 403");
		check((await hit("/api/chats", { method: "POST", headers: { origin: base } })).status === 403, "POST /api/chats without the cookie → 403");
		check((await hit(`/?lh_token=wrong`)).status === 403, "a wrong pairing token → 403");

		// Host check (a DNS-rebinding page reaches us under another name)
		const rebind = await new Promise((resolve) => {
			const r = http.request({ host: "127.0.0.1", port, path: "/api/health", headers: { Host: "evil.example" } }, (res) => {
				res.resume();
				resolve(res.statusCode);
			});
			r.on("error", () => resolve(0));
			r.end();
		});
		check(rebind === 403, "a foreign Host header → 403, even on /api/health");

		// pairing
		const pair = await hit(`/?lh_token=${TOKEN}`);
		check(pair.status === 303 && ["/", `${base}/`].includes(pair.headers.get("location") ?? ""), `the pairing URL redirects to / without the token (status ${pair.status}, location ${pair.headers.get("location")})`);
		const setCookie = pair.headers.get("set-cookie") ?? "";
		check(/HttpOnly/i.test(setCookie) && /SameSite=strict/i.test(setCookie), "the cookie is HttpOnly and SameSite=Strict");
		const cookie = setCookie.split(";")[0];
		const paired = { cookie };
		const jsonPaired = { ...paired, "content-type": "application/json", origin: base };

		check((await hit("/", { headers: paired })).status === 200, "GET / with the cookie → 200");
		check((await hit("/api/models", { headers: paired })).status === 200, "GET /api/models with the cookie → 200");

		// CSRF
		const noOrigin = await hit("/api/chats", { method: "POST", headers: { ...paired, "content-type": "application/json" }, body: "{}" });
		check(noOrigin.status === 403, "a write without Origin → 403");
		const foreign = await hit("/api/chats", { method: "POST", headers: { ...jsonPaired, origin: "http://evil.example" }, body: "{}" });
		check(foreign.status === 403, "a cross-origin write → 403");

		// one full turn through the claude-code provider against the fake CLI (opt-in first, as in Settings)
		const optIn = await hit("/api/settings/claudeCode", { method: "PUT", headers: jsonPaired, body: JSON.stringify({ enabled: true }) });
		check(optIn.status === 200, `Claude Code is switched on (status ${optIn.status})`);
		const created = await hit("/api/chats", { method: "POST", headers: jsonPaired, body: JSON.stringify({ title: "smoke" }) });
		check(created.status === 200, "POST /api/chats with cookie + Origin → 200");
		const { id } = await created.json();
		const set = await hit(`/api/chats/${id}/settings`, {
			method: "PUT",
			headers: jsonPaired,
			body: JSON.stringify({ model: { provider: "claude-code", id: "sonnet" } }),
		});
		check(set.status === 200, `the chat's model is claude-code (status ${set.status})`);
		const turn = await hit("/api/chat", { method: "POST", headers: jsonPaired, body: JSON.stringify({ chatId: id, input: { type: "text", text: "hello" } }) });
		check(turn.status === 200, `POST /api/chat accepted the turn (status ${turn.status})`);
		const stream = await hit(`/api/chats/${id}/stream`, { headers: paired, signal: AbortSignal.timeout(TURN_TIMEOUT_MS) });
		check(stream.status === 200, "the turn stream attaches");
		const sse = await stream.text();
		check(sse.includes("[DONE]"), "the turn settles ([DONE])");
		const record = await (await hit(`/api/chats/${id}`, { headers: paired })).text();
		check(record.includes(REPLY), "the record holds the fake CLI's reply");
	} catch (err) {
		failed = err;
	} finally {
		await kill();
		try {
			fs.rmSync(home, { recursive: true, force: true });
		} catch {
			/* best effort — under os.tmpdir() */
		}
	}

	if (failed) {
		console.error(`[smoke-headless] FAIL: ${failed.message}`);
		console.error("--- server log tail " + "-".repeat(20));
		for (const line of tail.slice(-40)) if (line.trim()) console.error(`    ${line}`);
		process.exit(1);
	}
	console.log("[smoke-headless] passed — token mode, Host/Origin checks and a fake-CLI chat turn all hold.");
}

main().catch((err) => {
	console.error(`[smoke-headless] FAIL: ${err.message}`);
	process.exit(1);
});
