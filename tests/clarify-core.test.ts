import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLARIFY_QUOTE_MAX } from "../src/core/contracts/chat.ts";
import { clarifyErrorText, markedQuote } from "../components/clarify-core.ts";

describe("markedQuote — the Ask button's hand-over", () => {
	it("trims the marked text", () => {
		assert.equal(markedQuote("  the passage \n"), "the passage");
	});

	it("empty and whitespace-only selections give null", () => {
		assert.equal(markedQuote(""), null);
		assert.equal(markedQuote("   \n\t  "), null);
	});

	it("caps at CLARIFY_QUOTE_MAX", () => {
		const long = "a".repeat(CLARIFY_QUOTE_MAX + 500);
		const quote = markedQuote(long);
		assert.ok(quote !== null);
		assert.equal(quote.length, CLARIFY_QUOTE_MAX);
		assert.equal(quote, "a".repeat(CLARIFY_QUOTE_MAX));
	});

	it("keeps inner newlines (the passage as the learner saw it)", () => {
		assert.equal(markedQuote("first line\n\nsecond line"), "first line\n\nsecond line");
	});
});

describe("clarifyErrorText — the error reply's text", () => {
	it("uses the error field", async () => {
		const res = Response.json({ error: "Mark some text first" }, { status: 400 });
		assert.equal(await clarifyErrorText(res), "Mark some text first");
	});

	it("falls back to the message field", async () => {
		const res = Response.json({ message: "Models are not configured" }, { status: 503 });
		assert.equal(await clarifyErrorText(res), "Models are not configured");
	});

	it("falls back to a status line for a non-JSON body", async () => {
		const res = new Response("<html>Bad Gateway</html>", { status: 502 });
		assert.equal(await clarifyErrorText(res), "The question could not be sent (502).");
	});

	it("falls back to a status line when the JSON has neither field", async () => {
		const res = Response.json({ other: 1 }, { status: 500 });
		assert.equal(await clarifyErrorText(res), "The question could not be sent (500).");
	});
});
