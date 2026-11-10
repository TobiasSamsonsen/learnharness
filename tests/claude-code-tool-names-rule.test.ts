/**
 * The claude-code tool-name rule: the CLI exposes harness tools as mcp__learnharness__<name>, but the prompts, the sketch
 * hand-in text and the gates say the plain name. A plain-name call is rejected by the CLI and leaves no trace in the chat
 * (practice chat 2026-11-10: opus could not read a sketch, so it could not conclude the problem).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLAUDE_CODE_TOOL_NAMES_RULE } from "../src/agent/claude-code/tool-names-rule.ts";
import { BRIDGE_SERVER_NAME } from "../src/agent/claude-code/tool-bridge.ts";

describe("CLAUDE_CODE_TOOL_NAMES_RULE", () => {
	it("pins the approved wording", () => {
		assert.equal(
			CLAUDE_CODE_TOOL_NAMES_RULE,
			"## Tool names\n\nYou reach the harness tools through MCP, so each is named `mcp__learnharness__<name>`. Wherever these instructions or a message tell you to use a tool (`read_sketch`, `conclude`, `quiz`, `problem`, `send_to_user`, …), call it by the prefixed name, for example `mcp__learnharness__read_sketch`. A call without the prefix fails with \"No such tool available\"; that error means the name was wrong, not that the tool is missing. Retry with the prefix before telling the learner anything is unavailable.",
		);
	});

	it("names the prefix the bridge really uses", () => {
		assert.ok(CLAUDE_CODE_TOOL_NAMES_RULE.includes(`mcp__${BRIDGE_SERVER_NAME}__read_sketch`));
	});
});
