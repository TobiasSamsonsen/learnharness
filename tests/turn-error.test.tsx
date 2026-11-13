import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { turnErrorDisplay } from "../src/core/grade-failure.ts";
import { TurnErrorText } from "../components/turn-error.tsx";

const GOOGLE_402 = `{"error":{"message":"{\n \\"error\\": {\n \\"code\\": 402,\n \\"message\\": \\"Your prepayment credits are depleted.\\"\n }\n}"}}`;

describe("the chat banner's failure text (owner, 2026-11-13)", () => {
	it("names a recognised cause and keeps the provider's words as the detail", () => {
		const shown = turnErrorDisplay(GOOGLE_402);
		assert.equal(shown.phrase, "out of credit");
		assert.match(shown.detail, /prepayment credits are depleted/);
		assert.equal(turnErrorDisplay('{"code": 429, "message": "You exceeded your current quota"}').phrase, "quota or rate limit reached");
		assert.equal(turnErrorDisplay("503 This model is currently experiencing high demand").phrase, "provider unavailable");
		assert.equal(turnErrorDisplay("401 Unauthorized").phrase, "API key rejected");
	});

	it("leaves an unrecognised failure as it is", () => {
		assert.equal(turnErrorDisplay("The turn crashed: boom").phrase, null);
		assert.equal(turnErrorDisplay("").phrase, null);
	});

	it("renders the phrase with the details folded, or the raw text for an unknown failure", () => {
		const known = renderToStaticMarkup(<TurnErrorText message={GOOGLE_402} />);
		assert.match(known, /the model provider reports out of credit\./);
		assert.match(known, /<details[\s\S]*prepayment credits are depleted/);
		const unknown = renderToStaticMarkup(<TurnErrorText message="The turn crashed: boom" />);
		assert.match(unknown, /Something went wrong: The turn crashed: boom/);
		assert.ok(!unknown.includes("<details"));
	});
});
