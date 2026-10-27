/**
 * android/termux/lh (Android plan M7): the Termux control script, run under a
 * temp HOME with stub `proot-distro`, `curl`, `setsid` and `whisper-server`.
 * The real install (packages, Ubuntu, whisper build) is checked on a device;
 * here: the pure commands, the config, the pairing token, what start wires
 * into the guest (and that the token never reaches a command line or script),
 * stop, and that update refuses a bad checksum.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const fwd = (p: string) => p.replace(/\\/g, "/");
const LH_SOURCE = path.resolve(import.meta.dirname, "../android/termux/lh");
const hasBash = spawnSync("bash", ["-c", "echo ok"]).stdout?.toString().trim() === "ok";
const opts = { skip: hasBash ? false : "bash is not available" };

interface Box {
	root: string;
	home: string;
	prefix: string;
	lhHome: string;
	rootfs: string;
	bin: string;
	lh: string;
	run(args: string[], extraEnv?: Record<string, string>): { code: number; out: string; err: string };
}

function stub(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function makeBox(config?: string): Box {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-android-"));
	const home = path.join(root, "home");
	const prefix = path.join(root, "prefix");
	const lhHome = path.join(home, ".lh");
	const rootfs = path.join(prefix, "var/lib/proot-distro/containers/ubuntu/rootfs");
	const bin = path.join(root, "bin");
	for (const d of [home, bin, path.join(rootfs, "etc")]) fs.mkdirSync(d, { recursive: true });
	// run a COPY: `lh update` replaces the script it runs from
	const lh = path.join(root, "lh");
	fs.copyFileSync(LH_SOURCE, lh);
	stub(bin, "proot-distro", `echo "proot-distro $*" >> "$STUB_LOG"\n[ "$4" = "/opt/lh/start.sh" ] && exec sleep 60\nexit 0`);
	stub(bin, "setsid", `exec "$@"`);
	stub(bin, "termux-wake-lock", `echo wake-lock >> "$STUB_LOG"`);
	stub(bin, "termux-wake-unlock", `echo wake-unlock >> "$STUB_LOG"`);
	// health answers; the release files are served from the test's own state
	stub(
		bin,
		"curl",
		`[ -n "$LH_TEST_CURL_DELAY" ] && sleep "$LH_TEST_CURL_DELAY"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
case "$url" in
	*/api/health) echo '{"ok":true}' ;;
	*127.0.0.1:81*/inference) [ -n "$LH_TEST_INFER_FAIL" ] && exit 22; echo '{"text":""}' ;;
	*127.0.0.1:81*) echo whisper ;;
	*/version.txt) echo "9.9.9+abc1234" ;;
	*githubusercontent.com*) cat "$LH_TEST_LH" > "\${out:-/dev/stdout}" ;;
	*.sha256) echo "deadbeef  x" > "$out" ;;
	*.tar.zst) echo "not a tarball" > "$out" ;;
	*) exit 22 ;;
esac`,
	);
	fs.mkdirSync(lhHome, { recursive: true });
	if (config !== undefined) fs.writeFileSync(path.join(lhHome, "config"), config);
	const env = {
		...process.env,
		HOME: fwd(home),
		PREFIX: fwd(prefix),
		LH_HOME: fwd(lhHome),
		PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
		STUB_LOG: fwd(path.join(root, "stub.log")),
		LH_TEST_LH: fwd(LH_SOURCE),
	};
	return {
		root,
		home,
		prefix,
		lhHome,
		rootfs,
		bin,
		lh,
		run(args, extraEnv = {}) {
			const r = spawnSync("bash", [fwd(lh), ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000 });
			return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
		},
	};
}

/** The pieces `start` needs: a whisper-server, two models, an installed server. */
function installFakes(b: Box): void {
	const wbin = path.join(b.lhHome, "src/whisper.cpp/build/bin");
	fs.mkdirSync(wbin, { recursive: true });
	stub(wbin, "whisper-server", `echo "whisper-cpu $*" >> "$STUB_LOG"\nexec sleep 60`);
	fs.mkdirSync(path.join(b.lhHome, "models"), { recursive: true });
	fs.writeFileSync(path.join(b.lhHome, "models/nb.bin"), "x");
	fs.writeFileSync(path.join(b.lhHome, "models/en.bin"), "x");
	fs.mkdirSync(path.join(b.rootfs, "opt/lh/server"), { recursive: true });
	fs.writeFileSync(path.join(b.rootfs, "opt/lh/server/server.js"), "// stub");
}

/** A GPU (Vulkan) whisper-server next to the CPU one: it serves, or exits at once ("dies"). */
function installGpu(b: Box, behaviour: "ok" | "dies"): void {
	const vk = path.join(b.lhHome, "src/whisper.cpp/build-vk/bin");
	fs.mkdirSync(vk, { recursive: true });
	stub(vk, "whisper-server", `echo "whisper-gpu $*" >> "$STUB_LOG"\n${behaviour === "dies" ? "exit 1" : "exec sleep 60"}`);
}

/** The detached stub writes its log line a moment after `lh` returns: poll for it. */
function eventually(check: () => boolean, ms = 5_000): boolean {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
	}
	return check();
}

const stubLog = (b: Box): string => (fs.existsSync(path.join(b.root, "stub.log")) ? fs.readFileSync(path.join(b.root, "stub.log"), "utf8") : "");
/** `stop` insists the port is silent, and the stub curl answers health forever: swap it for one that refuses. */
function silenceCurl(b: Box): void {
	fs.writeFileSync(path.join(b.root, "bin/curl"), "#!/bin/bash\nexit 22\n", { mode: 0o755 });
}

test("lh: the script parses and is plain LF", opts, () => {
	assert.equal(spawnSync("bash", ["-n", fwd(LH_SOURCE)]).status, 0);
	assert.ok(!fs.readFileSync(LH_SOURCE, "utf8").includes("\r"), "CRLF would break the shebang in Termux");
});

test("lh: version, help, and an unknown command", opts, () => {
	const b = makeBox();
	assert.match(b.run(["version"]).out, /^lh \d+\.\d+\.\d+/);
	const help = b.run(["help"]).out;
	for (const c of ["install", "login", "start", "stop", "status", "pair", "update", "logs"]) assert.match(help, new RegExp(`\\b${c}\\b`), c);
	const bad = b.run(["frobnicate"]);
	assert.equal(bad.code, 2);
});

test("lh pair: one persistent token, mode 600; --rotate makes a new one", opts, () => {
	const b = makeBox();
	const first = b.run(["pair"]);
	const link = /http:\/\/127\.0\.0\.1:3000\/\?lh_token=([0-9a-f]{48})/.exec(first.out);
	assert.ok(link, first.out + first.err);
	const token = link[1] ?? "";
	assert.equal(fs.readFileSync(path.join(b.lhHome, "token"), "utf8").trim(), token);
	if (process.platform !== "win32") assert.equal(fs.statSync(path.join(b.lhHome, "token")).mode & 0o777, 0o600);
	assert.equal(b.run(["pair"]).out.includes(token), true, "same token on the second call");
	const rotated = b.run(["pair", "--rotate"]);
	const next = /lh_token=([0-9a-f]{48})/.exec(rotated.out);
	assert.ok(next && next[1] !== token, "a new token");
});

test("lh pair --print-token: only the token on stdout, the same one the link carries", opts, () => {
	const b = makeBox();
	const r = b.run(["pair", "--print-token"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out.trim(), /^[0-9a-f]{48}$/);
	assert.equal(r.out.trim().split("\n").length, 1, "nothing but the token");
	assert.equal(fs.readFileSync(path.join(b.lhHome, "token"), "utf8").trim(), r.out.trim());
	if (process.platform !== "win32") assert.equal(fs.statSync(path.join(b.lhHome, "token")).mode & 0o777, 0o600);
	assert.ok(b.run(["pair"]).out.includes(r.out.trim()), "the link carries the same token");
});

test("lh config: PORT is used, bad values are refused", opts, () => {
	const b = makeBox('PORT=3456\nSTT_LANGS="nb"\n');
	assert.match(b.run(["pair"]).out, /127\.0\.0\.1:3456\/\?lh_token=/);
	const bad = makeBox('STT_LANGS="fr"\n');
	const r = bad.run(["pair"]);
	assert.notEqual(r.code, 0);
	assert.match(r.err, /STT_LANGS/);
	const badPort = makeBox("PORT=abc\n").run(["pair"]);
	assert.notEqual(badPort.code, 0);
});

test("lh stop: a stale PID file is cleaned up, nothing else breaks", opts, () => {
	const b = makeBox("PORT=3456\n");
	fs.mkdirSync(path.join(b.lhHome, "run"), { recursive: true });
	fs.writeFileSync(path.join(b.lhHome, "run/server.pid"), "999999");
	// the stub curl answers /api/health, so use a port-free override: stop checks the port is silent
	fs.writeFileSync(path.join(b.root, "bin/curl"), "#!/bin/bash\nexit 22\n", { mode: 0o755 });
	const r = b.run(["stop"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /stopped/);
	assert.equal(fs.existsSync(path.join(b.lhHome, "run/server.pid")), false);
});

test("lh start: wires the guest, keeps the token off command lines and scripts, stop ends it", opts, () => {
	const b = makeBox("PORT=3456\nMAX_SESSIONS=2\n");
	installFakes(b);
	const started = b.run(["start"]);
	assert.equal(started.code, 0, started.out + started.err);
	try {
		const token = fs.readFileSync(path.join(b.lhHome, "token"), "utf8").trim();
		assert.ok(started.out.includes(`http://127.0.0.1:3456/?lh_token=${token}`), "prints the pairing link");

		const env = fs.readFileSync(path.join(b.rootfs, "opt/lh/env"), "utf8");
		assert.match(env, /export PORT=3456/);
		assert.match(env, /export LH_CLAUDE_CODE_MAX_SESSIONS=2/);
		assert.match(env, /export LH_WHISPER_URL_NB=http:\/\/127\.0\.0\.1:8178/);
		assert.match(env, /export LH_WHISPER_URL_EN=http:\/\/127\.0\.0\.1:8179/);
		assert.ok(!env.includes(token));

		assert.equal(fs.readFileSync(path.join(b.rootfs, "root/.lh/token"), "utf8").trim(), token, "token copied into the guest");
		const startSh = fs.readFileSync(path.join(b.rootfs, "opt/lh/start.sh"), "utf8");
		for (const need of ["LH_ACCESS_TOKEN", "LH_STT_ENGINE=whispercpp", "LH_STT_DEVICE=cpu", "LH_UPSTREAM_CHECK=0", "LH_DATA_DIR", "LH_AUTH_FILE", "LH_PYTHON=python3", "CHROME_PATH", "HOSTNAME=127.0.0.1", "/root/.lh/token"]) {
			assert.ok(startSh.includes(need), `start.sh sets ${need}`);
		}
		assert.ok(!startSh.includes(token));
		const log = fs.readFileSync(path.join(b.root, "stub.log"), "utf8");
		assert.ok(!log.includes(token), "the token is on no command line");
		assert.match(log, /proot-distro login ubuntu -- \/opt\/lh\/start\.sh/);
		assert.match(log, /wake-lock/);

		const status = b.run(["status"]).out;
		assert.match(status, /server: running/);
		assert.match(status, /whisper-nb: running/);
		assert.match(status, /whisper-en: stopped \(starts when asked for\)/, "the second language waits for a request");
		assert.match(status, /supervisor: running/);
		assert.match(env, /export LH_WHISPER_WANT_DIR=\/root\/\.lh\/want/);
		assert.ok(fs.existsSync(path.join(b.rootfs, "root/.lh/want")), "the request directory exists in the guest");
	} finally {
		// the health stub answers forever, so stop's "port is silent" check would fail; stop the processes by hand
		fs.writeFileSync(path.join(b.root, "bin/curl"), "#!/bin/bash\nexit 22\n", { mode: 0o755 });
		const stopped = b.run(["stop"]);
		assert.equal(stopped.code, 0, stopped.err);
	}
	assert.match(b.run(["status"]).out, /server: stopped/);
});

test("lh start: STT_LANGS limits which whisper servers run", opts, () => {
	const b = makeBox('PORT=3456\nSTT_LANGS="nb"\n');
	installFakes(b);
	const started = b.run(["start"]);
	assert.equal(started.code, 0, started.out + started.err);
	try {
		const env = fs.readFileSync(path.join(b.rootfs, "opt/lh/env"), "utf8");
		assert.match(env, /LH_WHISPER_URL_NB/);
		assert.ok(!env.includes("LH_WHISPER_URL_EN"));
		assert.ok(!env.includes("LH_WHISPER_WANT_DIR"), "nothing starts on demand");
		const status = b.run(["status"]).out;
		assert.match(status, /whisper-nb: running/);
		assert.match(status, /whisper-en: stopped/);
		assert.doesNotMatch(status, /supervisor/);
	} finally {
		fs.writeFileSync(path.join(b.root, "bin/curl"), "#!/bin/bash\nexit 22\n", { mode: 0o755 });
		b.run(["stop"]);
	}
});

test("lh update: a checksum that does not match is refused and the server is left alone", opts, () => {
	const b = makeBox("PORT=3456\n");
	installFakes(b);
	fs.writeFileSync(path.join(b.rootfs, "opt/lh/version.txt"), "1.0.0+old\n");
	const r = b.run(["update"]);
	assert.notEqual(r.code, 0);
	assert.match(r.err, /checksum mismatch/);
	assert.equal(fs.readFileSync(path.join(b.rootfs, "opt/lh/version.txt"), "utf8").trim(), "1.0.0+old");
	assert.ok(fs.existsSync(path.join(b.rootfs, "opt/lh/server/server.js")), "the installed server is untouched");
});

test("lh update: an up-to-date server is left alone, no restart", opts, () => {
	const b = makeBox("PORT=3456\n");
	installFakes(b);
	fs.writeFileSync(path.join(b.rootfs, "opt/lh/version.txt"), "9.9.9+abc1234\n"); // what the stub curl publishes
	const r = b.run(["update"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /up to date/);
	assert.ok(!/restarting/.test(r.out));
	const log = fs.existsSync(path.join(b.root, "stub.log")) ? fs.readFileSync(path.join(b.root, "stub.log"), "utf8") : "";
	assert.ok(!log.includes("/opt/lh/start.sh"), "the server was not started");
});

test("lh start: the CPU whisper-server gets -nf -ac 640, and the guest is told the piece sizes", opts, () => {
	const b = makeBox('PORT=3456\nSTT_EAGER="nb en"\n');
	installFakes(b);
	const started = b.run(["start"]);
	assert.equal(started.code, 0, started.out + started.err);
	try {
		const log = stubLog(b);
		assert.match(log, /whisper-cpu -m \S*nb\.bin --host 127\.0\.0\.1 --port 8178 -t 4 -nf -ac 640/);
		assert.match(log, /whisper-cpu -m \S*en\.bin --host 127\.0\.0\.1 --port 8179 -t 4 -nf -ac 640/);
		assert.ok(!log.includes("whisper-gpu"), "no GPU build installed");
		const env = fs.readFileSync(path.join(b.rootfs, "opt/lh/env"), "utf8");
		assert.match(env, /export LH_STT_PIECE_S=3-8/);
		assert.match(env, /export LH_WHISPER_MAX_S=12/);
		assert.match(b.run(["status"]).out, /whisper-nb: running \(pid \d+, [\d-]+ MB, cpu\)/);
	} finally {
		silenceCurl(b);
		b.run(["stop"]);
	}
});

test("lh start: a working GPU build is used (with the same flags), and status says so", opts, () => {
	const b = makeBox('PORT=3456\nSTT_EAGER="nb en"\n');
	installFakes(b);
	installGpu(b, "ok");
	const started = b.run(["start"]);
	assert.equal(started.code, 0, started.out + started.err);
	try {
		const log = stubLog(b);
		assert.match(log, /whisper-gpu -m \S*nb\.bin --host 127\.0\.0\.1 --port 8178 -t 4 -nf -ac 640/);
		assert.ok(!log.includes("whisper-cpu"), "the CPU build was not started");
		assert.match(b.run(["status"]).out, /whisper-en: running \(pid \d+, [\d-]+ MB, gpu\)/);
	} finally {
		silenceCurl(b);
		b.run(["stop"]);
	}
});

test("lh start: a GPU build that dies at start-up falls back to the CPU", opts, () => {
	const b = makeBox("PORT=3456\n");
	installFakes(b);
	installGpu(b, "dies");
	// a slow health answer: the dying stub has exited before it arrives (no race on a fast runner)
	const started = b.run(["start"], { LH_TEST_CURL_DELAY: "1" });
	assert.equal(started.code, 0, started.out + started.err);
	try {
		assert.match(started.out, /GPU backend failed; using the CPU/);
		const log = stubLog(b);
		assert.ok(log.includes("whisper-gpu") && log.includes("whisper-cpu"));
		assert.match(b.run(["status"]).out, /whisper-nb: running \(pid \d+, [\d-]+ MB, cpu\)/);
		assert.ok(fs.existsSync(path.join(b.lhHome, "logs/whisper-nb.gpu-failed.log")), "the failed attempt keeps its log");
	} finally {
		silenceCurl(b);
		b.run(["stop"]);
	}
});

test("lh start: a GPU server that loads but cannot compute (self-test fails) falls back to the CPU", opts, () => {
	const b = makeBox("PORT=3456\n");
	installFakes(b);
	installGpu(b, "ok");
	const started = b.run(["start"], { LH_TEST_INFER_FAIL: "1" });
	assert.equal(started.code, 0, started.out + started.err);
	try {
		assert.match(started.out, /GPU backend failed; using the CPU/);
		assert.match(b.run(["status"], { LH_TEST_INFER_FAIL: "1" }).out, /whisper-nb: running \(pid \d+, [\d-]+ MB, cpu\)/);
	} finally {
		silenceCurl(b);
		b.run(["stop"]);
	}
});

test("lh config: WHISPER_GPU=off never starts the GPU build; =on refuses to fall back; junk is refused", opts, () => {
	const off = makeBox('PORT=3456\nWHISPER_GPU=off\n');
	installFakes(off);
	installGpu(off, "ok");
	const started = off.run(["start"]);
	assert.equal(started.code, 0, started.out + started.err);
	try {
		assert.ok(!stubLog(off).includes("whisper-gpu"));
	} finally {
		silenceCurl(off);
		off.run(["stop"]);
	}

	const on = makeBox("PORT=3456\nWHISPER_GPU=on\n");
	installFakes(on);
	installGpu(on, "dies");
	const refused = on.run(["start"], { LH_TEST_CURL_DELAY: "1" });
	assert.notEqual(refused.code, 0);
	assert.match(refused.err, /WHISPER_GPU=on/);
	silenceCurl(on);
	on.run(["stop"]);

	const bad = makeBox("WHISPER_GPU=maybe\n").run(["pair"]);
	assert.notEqual(bad.code, 0);
	assert.match(bad.err, /WHISPER_GPU/);
});

test("lh config: STT_EAGER must be inside STT_LANGS, WHISPER_IDLE_MIN a positive number of minutes", opts, () => {
	const outside = makeBox('STT_LANGS="nb"\nSTT_EAGER="en"\n').run(["pair"]);
	assert.notEqual(outside.code, 0);
	assert.match(outside.err, /STT_EAGER/);
	for (const bad of ["0", "ten", "-5"]) {
		const r = makeBox(`WHISPER_IDLE_MIN=${bad}\n`).run(["pair"]);
		assert.notEqual(r.code, 0, bad);
		assert.match(r.err, /WHISPER_IDLE_MIN/);
	}
	assert.equal(makeBox('STT_LANGS="nb en"\nSTT_EAGER="nb en"\nWHISPER_IDLE_MIN=3\n').run(["pair"]).code, 0);
});

test("lh supervisor: starts a language when its request file is fresh, stops it when idle, ignores a stale one and the eager one", opts, () => {
	const b = makeBox("PORT=3456\n"); // nb eager, en on demand, 10 idle minutes
	installFakes(b);
	const want = path.join(b.rootfs, "root/.lh/want");
	fs.mkdirSync(want, { recursive: true });
	const age = (lang: string, minutes: number) => {
		const t = new Date(Date.now() - minutes * 60_000);
		fs.utimesSync(path.join(want, lang), t, t);
	};
	try {
		// a stale request file (nobody asked in an hour): nothing starts
		fs.writeFileSync(path.join(want, "en"), "old");
		age("en", 60);
		assert.equal(b.run(["_supervise", "--once"]).code, 0);
		assert.match(b.run(["status"]).out, /whisper-en: stopped/);
		// a fresh one: it starts (CPU build here), on its own port
		fs.writeFileSync(path.join(want, "en"), String(Date.now()));
		const started = b.run(["_supervise", "--once"]);
		assert.equal(started.code, 0, started.out + started.err);
		assert.match(started.out, /whisper-en asked for: starting/);
		assert.ok(eventually(() => /whisper-cpu -m \S*en\.bin --host 127\.0\.0\.1 --port 8179/.test(stubLog(b))), "the CPU server for en was launched on its port");
		assert.match(b.run(["status"]).out, /whisper-en: running/);
		// still in use: a second pass leaves it alone (and does not start a second copy)
		const again = b.run(["_supervise", "--once"]);
		assert.doesNotMatch(again.out, /starting|stopping/);
		assert.equal((stubLog(b).match(/--port 8179/g) ?? []).length, 1);
		// idle past WHISPER_IDLE_MIN: it stops
		age("en", 11);
		const idle = b.run(["_supervise", "--once"]);
		assert.match(idle.out, /whisper-en idle for 10 min: stopping/);
		assert.match(b.run(["status"]).out, /whisper-en: stopped/);
		// the eager language is never the supervisor's business, even with a request file for it
		fs.writeFileSync(path.join(want, "nb"), "x");
		age("nb", 90);
		assert.doesNotMatch(b.run(["_supervise", "--once"]).out, /whisper-nb/);
	} finally {
		silenceCurl(b);
		b.run(["stop"]);
	}
});

test("lh stop: also stops the supervisor, so it cannot bring a server back", opts, () => {
	const b = makeBox("PORT=3456\n");
	installFakes(b);
	const started = b.run(["start"]);
	assert.equal(started.code, 0, started.out + started.err);
	assert.match(b.run(["status"]).out, /supervisor: running/);
	silenceCurl(b);
	const stopped = b.run(["stop"]);
	assert.equal(stopped.code, 0, stopped.err);
	const status = b.run(["status"]).out;
	assert.match(status, /supervisor: stopped/);
	assert.match(status, /whisper-nb: stopped/);
});
