/**
 * The learner profile through the chat handler (fork addition, 2026-11-11):
 * the block frozen into the chat record reaches the agent's build options, and
 * the model's system prompt carries it for the teacher. Driven like
 * chat-flow.test.ts: a scripted faux engine, the factory seam.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-handler-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { subscribe } = await import("../src/core/events.ts");

import type { AgentBuildOptions } from "../src/agent/teacher-agent.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const BLOCK = "<learner>\nEvidence about this learner.\n- execution (right idea, slip in carrying it out): 6 misses in 3 sessions\n</learner>";

async function runTurn(settings: { learnerProfile?: string }): Promise<{ captured: AgentBuildOptions | undefined; systemPrompt: string }> {
	const chat = chatStore.createChat("handler");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, ...settings });
	let captured: AgentBuildOptions | undefined;
	let systemPrompt = "";
	const faux = createFauxCore({});
	faux.setResponses([
		(context) => {
			// the system prompt leads the transcript as a system message
			systemPrompt = JSON.stringify(context.messages);
			return fauxAssistantMessage([fauxText("Hello.")]);
		},
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const res = await handleChatRequest(
		new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "teach me" } }) }),
		(opts) => {
			captured = opts;
			return createTeacherAgent(undefined, { engine, messages: opts.messages, ...(opts.learner ? { learner: opts.learner } : {}) });
		},
	);
	assert.equal(res.status, 200, await res.clone().text());
	const handle = runningTurn(chat.id);
	if (handle) {
		await new Promise<void>((resolve) => {
			const stop = subscribe?.(() => {}) ?? (() => {});
			const timer = setInterval(() => {
				if (!runningTurn(chat.id)) {
					clearInterval(timer);
					stop();
					resolve();
				}
			}, 20);
		});
	}
	return { captured, systemPrompt };
}

describe("the learner block through the chat handler", () => {
	it("hands the frozen block to the agent build options and into the system prompt", async () => {
		const { captured, systemPrompt } = await runTurn({ learnerProfile: BLOCK });
		assert.equal(captured?.learner, BLOCK);
		assert.ok(systemPrompt.includes(JSON.stringify(BLOCK).slice(1, -1)), "the teacher's system prompt carries the block");
	});

	it("adds nothing when the session has no profile", async () => {
		const { captured, systemPrompt } = await runTurn({});
		assert.equal(captured?.learner, undefined);
		assert.ok(!systemPrompt.includes("<learner>"));
	});
});
