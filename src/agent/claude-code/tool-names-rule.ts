import { BRIDGE_SERVER_NAME } from "./tool-bridge.ts";

const PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;

/**
 * Appended to every agent prompt on the claude-code provider (owner-approved wording, 2026-11-10).
 *
 * The CLI exposes the harness tools under their MCP names, but the prompts, the sketch hand-in text and the gates all say
 * the plain name (`read_sketch`). A call by the plain name is rejected by the CLI itself ("No such tool available") and
 * leaves no trace in the chat; opus then believed the tool was missing, skipped it and could not conclude a practice problem.
 */
export const CLAUDE_CODE_TOOL_NAMES_RULE =
	"## Tool names\n\n" +
	`You reach the harness tools through MCP, so each is named \`${PREFIX}<name>\`. ` +
	"Wherever these instructions or a message tell you to use a tool (`read_sketch`, `conclude`, `quiz`, `problem`, `send_to_user`, …), " +
	`call it by the prefixed name, for example \`${PREFIX}read_sketch\`. ` +
	'A call without the prefix fails with "No such tool available"; that error means the name was wrong, not that the tool is missing. ' +
	"Retry with the prefix before telling the learner anything is unavailable.";
