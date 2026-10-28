import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, bridgedHeadless, parseBridgeResult } from "../src/agent/subagents/headless-bridge.ts";

/**
 * M12 step 5: on Android the demo browser is the Kotlin shell's system WebView behind a token-authenticated loopback
 * service. These tests stand in for the shell with a real HTTP server and pin the contract: what is sent, what is
 * accepted back, and that only runDemo is replaced.
 */

const TOKEN = "bridge-" + "0123456789abcdef".repeat(3);

function base(): HeadlessApi {
	return {
		available: () => false,
		unavailableReason: () => "no chrome",
		runDemo: async () => {
			throw new Error("the real runDemo must not run");
		},
		renderSvg: async () => Buffer.from("svg-from-node"),
		renderPdfPages: async () => [{ page: 1, png: Buffer.from("pdf-from-node") }],
	};
}

async function shell(handler: (body: Record<string, unknown>, headers: http.IncomingHttpHeaders, url: string) => { status: number; json?: unknown }) {
	const seen: { body: Record<string, unknown>; headers: http.IncomingHttpHeaders; url: string }[] = [];
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			seen.push({ body, headers: req.headers, url: req.url ?? "" });
			const out = handler(body, req.headers, req.url ?? "");
			res.writeHead(out.status, { "content-type": "application/json" });
			res.end(JSON.stringify(out.json ?? {}));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { url, seen, close: () => server.close() };
}

test("without the shell's variables the real implementation stays in charge", () => {
	assert.equal(bridgedHeadless(base(), { env: {} }), null);
	assert.equal(bridgedHeadless(base(), { env: { [BRIDGE_URL_ENV]: "http://127.0.0.1:1" } }), null);
	assert.equal(bridgedHeadless(base(), { env: { [BRIDGE_TOKEN_ENV]: TOKEN } }), null);
});

test("with the bridge configured the engine counts as available and only runDemo is replaced", async () => {
	const api = bridgedHeadless(base(), { env: { [BRIDGE_URL_ENV]: "http://127.0.0.1:1", [BRIDGE_TOKEN_ENV]: TOKEN } });
	assert.ok(api);
	assert.equal(api.available(), true);
	assert.equal(api.unavailableReason(), null);
	assert.equal((await api.renderSvg("<svg/>")).toString(), "svg-from-node");
	assert.equal((await api.renderPdfPages("/x.pdf", [1]))[0]?.png.toString(), "pdf-from-node");
});

test("runDemo posts the html, probe and settle time with the token and returns the shell's capture", async () => {
	const s = await shell(() => ({
		status: 200,
		json: { consoleErrors: ["boom"], pageErrors: [], failedRequests: ["https://cdn.example/x.js (net::ERR_FAILED)"], probeResult: { n: 3 } },
	}));
	try {
		const api = bridgedHeadless(base(), { env: { [BRIDGE_URL_ENV]: s.url + "/", [BRIDGE_TOKEN_ENV]: TOKEN } });
		assert.ok(api);
		const r = await api.runDemo("<p>hi</p>", { probe: "document.title" });
		assert.equal(s.seen.length, 1);
		assert.equal(s.seen[0]?.url, "/run-demo");
		assert.equal(s.seen[0]?.headers["x-lh-token"], TOKEN);
		assert.deepEqual(s.seen[0]?.body, { html: "<p>hi</p>", probe: "document.title", settleMs: 2000 });
		assert.deepEqual(r.consoleErrors, ["boom"]);
		assert.deepEqual(r.failedRequests, ["https://cdn.example/x.js (net::ERR_FAILED)"]);
		assert.deepEqual(r.probeResult, { n: 3 });
		assert.equal(r.ok, false);
	} finally {
		s.close();
	}
});

test("a clean run is ok, and an absent probe result stays absent", async () => {
	const s = await shell(() => ({ status: 200, json: { consoleErrors: [], pageErrors: [], failedRequests: [], probeResult: null } }));
	try {
		const api = bridgedHeadless(base(), { env: { [BRIDGE_URL_ENV]: s.url, [BRIDGE_TOKEN_ENV]: TOKEN } });
		const r = await api!.runDemo("<p/>", { settleMs: 50 });
		assert.equal(r.ok, true);
		assert.equal("probeResult" in r, false);
		assert.equal(s.seen[0]?.body.settleMs, 50);
		assert.equal(s.seen[0]?.body.probe, null);
	} finally {
		s.close();
	}
});

test("a refusing or broken shell is an infrastructure failure, not a demo verdict", async () => {
	const refuse = await shell(() => ({ status: 403 }));
	try {
		const api = bridgedHeadless(base(), { env: { [BRIDGE_URL_ENV]: refuse.url, [BRIDGE_TOKEN_ENV]: TOKEN } });
		await assert.rejects(() => api!.runDemo("<p/>"), /answered 403/);
	} finally {
		refuse.close();
	}
	assert.throws(() => parseBridgeResult("nope"), /invalid answer/);
	assert.throws(() => parseBridgeResult(null), /invalid answer/);
});

test("the answer's ok flag is recomputed, never trusted", () => {
	const r = parseBridgeResult({ ok: true, consoleErrors: ["e"], pageErrors: [], failedRequests: [] });
	assert.equal(r.ok, false);
	assert.deepEqual(parseBridgeResult({}).consoleErrors, []);
});
