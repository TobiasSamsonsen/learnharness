/** Run the real payload-curation script in throwaway repository fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const source = fs.readFileSync(new URL("../scripts/build-server.mjs", import.meta.url), "utf8");
const STANDALONE = path.join(".next", "standalone");
const PROMPT = path.join("src", "agent", "system-prompt.md");
/** The local dictation worker's repo-side payload (fork addition): what
 *  build-server copies, plus a FOREIGN platform's onnxruntime binary that
 *  must not ride along. */
const ORT_BIN = path.join("node_modules", "onnxruntime-node", "bin", "napi-v6");
const OTHER_PLATFORM = process.platform === "win32" ? "linux" : "win32";
const STT_REPO_FILES = [
	path.join("src", "server", "stt", "worker.mjs"),
	path.join("node_modules", "@huggingface", "transformers", "package.json"),
	path.join("node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs"),
	path.join("node_modules", "@huggingface", "transformers", "dist", "transformers.web.js"),
	path.join("node_modules", "@huggingface", "tokenizers", "package.json"),
	path.join("node_modules", "@huggingface", "jinja", "package.json"),
	path.join("node_modules", "onnxruntime-common", "package.json"),
	path.join("node_modules", "onnxruntime-node", "package.json"),
	path.join("node_modules", "onnxruntime-node", "dist", "index.js"),
	path.join(ORT_BIN, process.platform, process.arch, "onnxruntime_binding.node"),
	path.join(ORT_BIN, OTHER_PLATFORM, "x64", "onnxruntime_binding.node"),
];

function withPayload(test: (fixture: {
	root: string;
	write: (relative: string, content?: string) => void;
	run: () => ReturnType<typeof spawnSync>;
}) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-payload-test-"));
	const write = (relative: string, content = "fixture") => {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	};
	try {
		write(path.join("scripts", "build-server.mjs"), source);
		write(path.join(STANDALONE, "server.js"));
		write(path.join(".next", "static", "runtime.js"));
		write(path.join("public", "asset.txt"));
		write(path.join(STANDALONE, PROMPT));
		write(path.join(STANDALONE, "src", "agent", "prompts", "teacher", "20-teaching.md"));
		for (const file of STT_REPO_FILES) write(file);
		test({ root, write, run: () => spawnSync(process.execPath, [path.join(root, "scripts", "build-server.mjs")], {
			cwd: root, encoding: "utf8", timeout: 10_000,
		}) });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("desktop standalone payload", () => {
	it("removes only traced installers/dev Electron, preserving runtime dist/ and native binaries", () => {
		withPayload(({ root, write, run }) => {
			for (const extra of [path.join("dist", "old.app", "nested.dmg"), path.join("node_modules", "electron", "dist", "electron.exe")]) {
				// BOTH copies exist: curation must not touch the real repo's build/runtime.
				write(extra);
				write(path.join(STANDALONE, extra));
			}
			const runtime = [
				"node_modules/@earendil-works/pi-ai/dist/index.js",
				"node_modules/@earendil-works/pi-agent-core/dist/index.js",
				"node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node",
				"node_modules/@resvg/resvg-js-win32-x64-msvc/resvgjs.win32-x64-msvc.node",
				"node_modules/electron-updater/out/main.js",
			];
			for (const file of runtime) write(path.join(STANDALONE, file));
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			assert.equal(fs.existsSync(path.join(root, STANDALONE, "dist")), false);
			assert.equal(fs.existsSync(path.join(root, STANDALONE, "node_modules", "electron")), false);
			assert.ok(fs.existsSync(path.join(root, "dist", "old.app", "nested.dmg")));
			assert.ok(fs.existsSync(path.join(root, "node_modules", "electron", "dist", "electron.exe")));
			for (const file of runtime) assert.ok(fs.existsSync(path.join(root, STANDALONE, file)), file);
			assert.ok(fs.existsSync(path.join(root, STANDALONE, ".next", "static", "runtime.js")));
			assert.ok(fs.existsSync(path.join(root, STANDALONE, "public", "asset.txt")));
		});
	});

	it("accepts a clean payload and is idempotent", () => {
		withPayload(({ run }) => {
			for (let i = 0; i < 2; i++) {
				const result = run();
				assert.equal(result.status, 0, String(result.stderr));
				assert.match(String(result.stdout), /server payload ready/);
			}
		});
	});

	it("still refuses leaked developer data or keys", () => {
		for (const leaked of ["data/chat.json", "auth.json", ".env", ".env.local"]) {
			withPayload(({ write, run }) => {
				write(path.join(STANDALONE, leaked));
				const result = run();
				assert.equal(result.status, 1, leaked);
				assert.match(String(result.stderr), /REFUSING/);
			});
		}
	});

	it("copies the dictation worker with ONLY this platform's onnxruntime binary", () => {
		withPayload(({ root, run }) => {
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			const out = (rel: string) => fs.existsSync(path.join(root, STANDALONE, rel));
			assert.ok(out(path.join("src", "server", "stt", "worker.mjs")));
			assert.ok(out(path.join("node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs")));
			assert.ok(out(path.join(ORT_BIN, process.platform, process.arch, "onnxruntime_binding.node")));
			assert.equal(out(path.join(ORT_BIN, OTHER_PLATFORM)), false, "foreign platform binaries pruned");
			assert.equal(out(path.join("node_modules", "@huggingface", "transformers", "dist", "transformers.web.js")), false, "web build left out");
			assert.equal(out(path.join("node_modules", "sharp")), false, "sharp never copied (the worker stubs it)");
		});
	});

	it("refuses a missing dictation worker payload", () => {
		withPayload(({ root, run }) => {
			fs.rmSync(path.join(root, "src", "server", "stt", "worker.mjs"));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /local dictation payload missing/);
		});
	});

	it("still refuses a missing runtime prompt asset", () => {
		withPayload(({ root, run }) => {
			fs.rmSync(path.join(root, STANDALONE, PROMPT));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /prompt asset missing/);
		});
	});
});
