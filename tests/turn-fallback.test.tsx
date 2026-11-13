/**
 * "RETRY ON <MODEL>" (owner, 2026-11-13): offered after a recognised provider failure, never automatic, only between
 * API-key models.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { retryFallbackModel, type FallbackCatalog } from "../src/core/turn-fallback.ts";
import { RetryOnFallback } from "../components/turn-error.tsx";

const OUT_OF_CREDIT = '{"error":{"code":402,"message":"Your prepayment credits are depleted."}}';
const catalog = (over: Partial<FallbackCatalog> = {}): FallbackCatalog => ({
	slots: { strong: { model: { provider: "google", id: "gemini-pro" } }, cheap: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } } },
	providers: [
		{ id: "google", envVar: "GEMINI_API_KEY", keyPresent: true },
		{ id: "openrouter", envVar: "OPENROUTER_API_KEY", keyPresent: true },
		{ id: "claude-code", envVar: "", keyPresent: true },
	],
	...over,
});

describe("retryFallbackModel", () => {
	it("offers the Cheap slot's model after a recognised failure, from the Strong slot or an explicit session model", () => {
		assert.deepEqual(retryFallbackModel({ error: OUT_OF_CREDIT, session: undefined, catalog: catalog() }), { provider: "openrouter", id: "z-ai/glm-5.3-flash" });
		assert.deepEqual(retryFallbackModel({ error: "503 high demand", session: "google:gemini-flash", catalog: catalog() }), { provider: "openrouter", id: "z-ai/glm-5.3-flash" });
	});

	it("offers nothing for an unrecognised failure, no catalog, or no error", () => {
		assert.equal(retryFallbackModel({ error: "The turn crashed: boom", session: undefined, catalog: catalog() }), null);
		assert.equal(retryFallbackModel({ error: OUT_OF_CREDIT, session: undefined, catalog: undefined }), null);
		assert.equal(retryFallbackModel({ error: undefined, session: undefined, catalog: catalog() }), null);
	});

	it("never from or into a subscription route, never to the model that failed, never to a provider without a key", () => {
		assert.equal(retryFallbackModel({ error: OUT_OF_CREDIT, session: "claude-code:sonnet", catalog: catalog() }), null, "a subscription session gets no button");
		const intoSubscription = catalog({ slots: { strong: { model: { provider: "google", id: "gemini-pro" } }, cheap: { model: { provider: "claude-code", id: "haiku" } } } });
		assert.equal(retryFallbackModel({ error: OUT_OF_CREDIT, session: undefined, catalog: intoSubscription }), null, "the target is never a subscription");
		const same = catalog({ slots: { strong: { model: { provider: "google", id: "gemini-pro" } }, cheap: { model: { provider: "google", id: "gemini-pro" } } } });
		assert.equal(retryFallbackModel({ error: OUT_OF_CREDIT, session: undefined, catalog: same }), null);
		const noKey = catalog({ providers: [{ id: "google", envVar: "GEMINI_API_KEY", keyPresent: true }, { id: "openrouter", envVar: "OPENROUTER_API_KEY", keyPresent: false }] });
		assert.equal(retryFallbackModel({ error: OUT_OF_CREDIT, session: undefined, catalog: noKey }), null);
		const noCheap = catalog({ slots: { strong: { model: { provider: "google", id: "gemini-pro" } }, cheap: null } });
		assert.equal(retryFallbackModel({ error: OUT_OF_CREDIT, session: undefined, catalog: noCheap }), null);
	});
});

describe("the Retry-on button", () => {
	it("names the model it will switch to", () => {
		const html = renderToStaticMarkup(<RetryOnFallback chatId="chat_1" target={{ provider: "openrouter", id: "z-ai/glm-5.3-flash" }} onSwitched={() => {}} />);
		assert.match(html, /data-testid="retry-on-fallback"/);
		assert.match(html, /Retry on z-ai\/glm-5\.3-flash/);
	});
});
