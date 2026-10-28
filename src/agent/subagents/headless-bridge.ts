import type { DemoRunResult, HeadlessApi, RunDemoOptions } from "./headless.ts";

/**
 * The demo browser on Android (docs/android/m12-plan.md, step 5). There is no Chromium inside the phone's Linux guest;
 * the Kotlin shell owns the system WebView and runs demos for the server through a token-authenticated loopback HTTP
 * service. When the shell starts the server it sets the two variables below; this module then replaces ONLY `runDemo`
 * (and reports the engine as available): SVGs already render with resvg and PDFs with pdfjs + Skia in Node, so they
 * stay on the real implementation. Paths never cross the guest boundary — the HTML travels in the request body.
 */

export const BRIDGE_URL_ENV = "LH_DEMO_BRIDGE_URL";
export const BRIDGE_TOKEN_ENV = "LH_DEMO_BRIDGE_TOKEN";

/** The shell caps a run at load (30 s) + settle + probe (15 s); the client waits a little longer than that. */
const REQUEST_TIMEOUT_MS = 75_000;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/** The shell's answer, validated: three string lists and an optional probe value; `ok` is recomputed here, never trusted. */
export function parseBridgeResult(body: unknown): DemoRunResult {
	if (typeof body !== "object" || body === null) throw new Error("the render bridge sent an invalid answer");
	const b = body as Record<string, unknown>;
	const consoleErrors = strings(b.consoleErrors);
	const pageErrors = strings(b.pageErrors);
	const failedRequests = strings(b.failedRequests);
	const result: DemoRunResult = {
		consoleErrors,
		pageErrors,
		failedRequests,
		ok: consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0,
	};
	if ("probeResult" in b && b.probeResult !== undefined && b.probeResult !== null) result.probeResult = b.probeResult;
	return result;
}

export interface BridgeOptions {
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
}

/** `base` with `runDemo` routed through the shell, or null when the server was not started by the Android shell. */
export function bridgedHeadless(base: HeadlessApi, opts: BridgeOptions = {}): HeadlessApi | null {
	const env = opts.env ?? process.env;
	const url = env[BRIDGE_URL_ENV];
	const token = env[BRIDGE_TOKEN_ENV];
	if (!url || !token) return null;
	const doFetch = opts.fetchImpl ?? fetch;
	return {
		...base,
		available: () => true,
		unavailableReason: () => null,
		async runDemo(html: string, runOpts?: RunDemoOptions): Promise<DemoRunResult> {
			const response = await doFetch(`${url.replace(/\/+$/, "")}/run-demo`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-lh-token": token },
				body: JSON.stringify({ html, probe: runOpts?.probe ?? null, settleMs: runOpts?.settleMs ?? 2000 }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`the render bridge answered ${response.status}`);
			return parseBridgeResult(await response.json());
		},
	};
}
