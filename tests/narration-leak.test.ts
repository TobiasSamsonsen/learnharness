/**
 * The thinking-text leak (owner, 2026-11-14 — the Diagonalisering lesson): the Anthropic API's summarized thinking and its
 * narration blocks put the tutor's planning and part of the correction in the thinking rows. The signature reader, the
 * view's skip of narration blocks, and the omitted thinking display on the Anthropic path.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNarrationSignature } from "../src/core/narration-signature.ts";
import { piEngineForSpec, omitThinkingText } from "../src/agent/models.ts";

const sig = (type: string) => Buffer.from(`\x08\x04\x12\x10\n\x11\x08\x13\x18\x028\x01B\t${type}\x12\x0cpayload`).toString("base64");

describe("isNarrationSignature", () => {
	it("reads the header the way the guard does, and rejects anything else", () => {
		assert.equal(isNarrationSignature(sig("narration")), true);
		assert.equal(isNarrationSignature(sig("thinking")), false);
		assert.equal(isNarrationSignature(""), false);
		assert.equal(isNarrationSignature(undefined), false);
		assert.equal(isNarrationSignature("not base64 !!"), false);
		assert.equal(isNarrationSignature(Buffer.from("x".repeat(60) + "narration").toString("base64")), false, "past the first 60 bytes");
	});
});

describe("thinking text on the Anthropic path", () => {
	it("the payload hook switches thinking to omitted, after the caller's own hook, and leaves disabled thinking alone", async () => {
		assert.deepEqual(omitThinkingText("openai-responses"), {});
		const hook = omitThinkingText("anthropic-messages").onPayload!;
		const body = { model: "m", thinking: { type: "adaptive", display: "summarized" }, messages: [] };
		assert.deepEqual(await hook(body, {} as never), { ...body, thinking: { type: "adaptive", display: "omitted" } });
		assert.equal(body.thinking.display, "summarized", "the original body is not mutated");
		assert.equal(await hook({ thinking: { type: "disabled" } }, {} as never), undefined);
		assert.equal(await hook({ model: "m" }, {} as never), undefined);
		const chained = omitThinkingText("anthropic-messages", async (raw: unknown) => ({ ...(raw as object), thinking: { type: "enabled", budget_tokens: 2000 } })).onPayload!;
		assert.deepEqual(await chained({ model: "m" }, {} as never), { model: "m", thinking: { type: "enabled", budget_tokens: 2000, display: "omitted" } });
		assert.equal(piEngineForSpec({ provider: "anthropic", id: "claude-sonnet-5-5" } as never, false).model.api, "anthropic-messages");
	});
});
