/**
 * SKETCH-AWARE AND SIZED HINTS (owner, 2026-11-17 — core/hints.ts): the Hint button on a practice problem, the size
 * (slip / nudge / carry) the tutor picks, the grade cap the grader's weight maps to, the conclude rule ("slip is not a
 * miss") and the hint route reading the learner's current ink.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-practice-hints-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { HINT_MAX, capGradeByHint, hintOutcomeProblems, hintPrompt, parseHintReply, practiceHintEligible, practiceHintPrompt, practiceHintsOf, stripHintLabel } = await import("../src/core/hints.ts");
const { newPracticeHintMarker, isSideQuestionMarker } = await import("../src/core/native-messages.ts");
const { gradesForSkills } = await import("../src/agent/subagents/grader.ts");
const { renderProblemSpan } = await import("../src/core/practice-grading.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { handleHintRequest } = await import("../src/server/hint.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createFauxCore, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
import type { PiEngine } from "../src/agent/models.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("a label the model wrote in front of the hint (2026-11-18)", () => {
	it("is stripped: the card labels each hint itself", () => {
		assert.equal(stripHintLabel("Hint 2: Look at the exponents."), "Look at the exponents.");
		assert.equal(stripHintLabel("**Hint 2**: Look at the exponents."), "Look at the exponents.");
		assert.equal(stripHintLabel("**Hint 2:** Look at the exponents."), "Look at the exponents.");
		assert.equal(stripHintLabel("Hint 3 of 3 - Do the substitution."), "Do the substitution.");
		assert.equal(stripHintLabel("Hint: look again."), "look again.");
	});
	it("leaves an ordinary hint alone, and never empties one", () => {
		assert.equal(stripHintLabel("Hints help here: look again."), "Hints help here: look again.");
		assert.equal(stripHintLabel("Hintergrund: look again."), "Hintergrund: look again.");
		assert.equal(stripHintLabel("Hint 2:"), "Hint 2:");
	});
	it("is stripped from a practice hint too, after the size line", () => {
		assert.equal(parseHintReply("SIZE: nudge\nHint 2: Check the sign.").text, "Check the sign.");
	});
});

describe("hints after the first are told the page may have changed (2026-11-18)", () => {
	it("only when a page rides along and an earlier hint exists", () => {
		const changed = /may have changed since the earlier hints/;
		assert.match(hintPrompt({ n: 2, earlier: ["Look at the roots."], ink: true }), changed);
		assert.ok(!changed.test(hintPrompt({ n: 1, earlier: [], ink: true })));
		assert.ok(!changed.test(hintPrompt({ n: 2, earlier: ["Look at the roots."] })));
		assert.match(practiceHintPrompt({ n: 2, earlier: [{ size: "nudge", text: "x" }], ink: true }), changed);
		assert.ok(!changed.test(practiceHintPrompt({ n: 1, earlier: [], ink: true })));
	});
});

describe("the size label", () => {
	it("is split off the first line", () => {
		assert.deepEqual(parseHintReply("SIZE: slip\n\nLook at the sign."), { size: "slip", text: "Look at the sign.", labelled: true });
		assert.deepEqual(parseHintReply("size: CARRY\nDo the substitution first."), { size: "carry", text: "Do the substitution first.", labelled: true });
		assert.equal(parseHintReply("**SIZE: nudge**\nThink about the rule.").size, "nudge");
	});

	it("falls back to nudge when the label is missing or unreadable, and still strips an unreadable label line", () => {
		assert.deepEqual(parseHintReply("Look at the sign."), { size: "nudge", text: "Look at the sign.", labelled: false });
		assert.deepEqual(parseHintReply("SIZE: huge\nLook at the sign."), { size: "nudge", text: "Look at the sign.", labelled: false });
	});
});

describe("the grade cap", () => {
	it("a slip costs nothing, a nudge allows at most good, a carry at most hard, and a grade is never raised", () => {
		assert.equal(capGradeByHint("easy", "slip"), "easy");
		assert.equal(capGradeByHint("easy", "none"), "easy");
		assert.equal(capGradeByHint("easy", undefined), "easy");
		assert.equal(capGradeByHint("easy", "nudge"), "good");
		assert.equal(capGradeByHint("good", "nudge"), "good");
		assert.equal(capGradeByHint("hard", "nudge"), "hard");
		assert.equal(capGradeByHint("easy", "carry"), "hard");
		assert.equal(capGradeByHint("good", "carry"), "hard");
		assert.equal(capGradeByHint("again", "carry"), "again");
	});

	it("is applied in code to the grader's verdict, per skill, and the weight that capped is kept", () => {
		const skills = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const grades = gradesForSkills(
			{
				grades: [
					{ skill: "a", grade: "easy", hint: "carry" },
					{ skill: "b", grade: "easy", hint: "slip" },
					{ skill: "c", grade: "good" },
					{ skill: "zzz", grade: "easy", hint: "carry" },
				],
			} as never,
			skills,
		);
		assert.deepEqual(grades, [
			{ skill: "a", grade: "hard", hint: "carry" },
			{ skill: "b", grade: "easy", hint: "slip" },
			{ skill: "c", grade: "good" },
		]);
	});
});

describe("the conclude rule", () => {
	it("a nudge or carry makes a solve a hinted solve; slips alone, with no hint from the tutor, do not", () => {
		assert.equal(hintOutcomeProblems("solved", null, []).length, 0);
		assert.equal(hintOutcomeProblems("solved", null, [{ size: "slip" }]).length, 0);
		assert.equal(hintOutcomeProblems("solved", null, [{ size: "slip" }, { size: "nudge" }]).length, 1);
		assert.equal(hintOutcomeProblems("solvedWithHints", null, [{ size: "carry" }]).length, 0);
		assert.equal(hintOutcomeProblems("solvedWithHints", null, [{ size: "slip" }]).length, 1);
		assert.equal(hintOutcomeProblems("solvedWithHints", "R2", [{ size: "slip" }]).length, 0, "the tutor hinted in chat: its own call stands");
		assert.equal(hintOutcomeProblems("surrendered", null, [{ size: "carry" }]).length, 0, "only solves are checked");
	});
});

// ─── a practice problem in a record ─────────────────────────────────────────

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const STAMP = { stopReason: "toolUse", api: "openai-completions", provider: "openrouter", model: "z-ai/glm-5.3-flash", usage: USAGE };

function poseMessages(): never[] {
	return [
		{ id: "m_user", role: "user", content: "practice limits", timestamp: 1 } as never,
		{
			id: "m_pose", role: "assistant", timestamp: 2, ...STAMP,
			content: [{ type: "toolCall", id: "pc1", name: "problem", arguments: { statement: "Compute the limit.", mode: "recall", modelSolution: "The answer is 7." } }],
		} as never,
		{ id: "m_pose_r", role: "toolResult", toolCallId: "pc1", toolName: "problem", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 3 } as never,
	];
}

function practiceChat(extra: never[] = []) {
	const chat = chatStore.createChat("Practice");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(chat.id, [...poseMessages(), ...extra]);
	return chat;
}

function scripted(replies: string[]): { engine: PiEngine; contexts: any[] } {
	const contexts: any[] = [];
	const faux = createFauxCore({});
	faux.setResponses(replies.map((text) => (ctx: unknown) => (contexts.push(ctx), fauxAssistantMessage([fauxText(text)]))) as never);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, contexts };
}

describe("the practice hint marker", () => {
	it("keeps the problem, count, size and text; the model is told what it means; it never changes the tail of the record", () => {
		const marker = newPracticeHintMarker("pc1", 2, "slip", "Check the sign.");
		assert.equal(marker.customType, "practice-hint");
		assert.deepEqual(marker.details, { problemCallId: "pc1", n: 2, size: "slip", text: "Check the sign." });
		assert.match(marker.content, /hint of size slip was given: «Check the sign\.»/);
		assert.match(marker.content, /conclude as solved/);
		assert.match(newPracticeHintMarker("pc1", 1, "carry", "x").content, /conclude a solve as solvedWithHints/);
		assert.equal(isSideQuestionMarker(marker), true);
	});

	it("is read back per problem, in order", () => {
		const messages = [newPracticeHintMarker("pc1", 1, "slip", "a"), newPracticeHintMarker("other", 1, "carry", "z"), newPracticeHintMarker("pc1", 2, "nudge", "b")];
		assert.deepEqual(practiceHintsOf(messages, "pc1"), [{ size: "slip", text: "a" }, { size: "nudge", text: "b" }]);
		assert.deepEqual(practiceHintsOf(messages, "none"), []);
	});

	it("shows to the grader with its size", () => {
		const text = renderProblemSpan([newPracticeHintMarker("pc1", 1, "nudge", "Rethink the rule.") as never], "c1");
		assert.match(text, /HINT BY BUTTON \(size nudge, given on the learner's request\): Rethink the rule\./);
	});

	it("the instruction names the sizes, the label form, the earlier hints and the ink", () => {
		const text = practiceHintPrompt({ n: 2, earlier: [{ size: "slip", text: "Check the sign." }], thinking: "x=3", ink: true });
		assert.match(text, /hint \(2 of 3\)/);
		assert.match(text, /slip:.*nudge:|slip:[\s\S]*nudge:[\s\S]*carry:/);
		assert.match(text, /`SIZE: slip`, `SIZE: nudge` or `SIZE: carry`/);
		assert.match(text, /1 \(slip\): Check the sign\./);
		assert.match(text, /x=3/);
		assert.match(text, /CURRENT handwriting/);
		assert.ok(!practiceHintPrompt({ n: 1, earlier: [] }).includes("CURRENT handwriting"));
	});

	it("every posed problem offers the button", () => {
		assert.equal(practiceHintEligible({ statement: "s" }), true);
		assert.equal(practiceHintEligible(null), false);
	});
});

describe("conclude reads the recorded sizes", () => {
	const conclude = (messages: never[], outcome: string, rung: string | null = null) => {
		const tools = practiceTools({ chatId: "x", chatStore: { getChat: () => ({ messages: messages as never }) } });
		return tools.conclude!.execute("c1", { outcome, verdict: "v", rung, missClass: null, retest: false } as never);
	};

	it("refuses solved after a nudge, and solvedWithHints after only a slip; accepts the matching outcomes", async () => {
		const nudged = [...poseMessages(), newPracticeHintMarker("pc1", 1, "nudge", "x") as never];
		const refused = await conclude(nudged, "solved");
		assert.equal((refused as { isError?: boolean }).isError, true);
		assert.match(JSON.stringify(refused), /solvedWithHints/);
		assert.notEqual((await conclude(nudged, "solvedWithHints", "R1") as { isError?: boolean }).isError, true);

		const slipped = [...poseMessages(), newPracticeHintMarker("pc1", 1, "slip", "x") as never];
		assert.equal(((await conclude(slipped, "solvedWithHints")) as { isError?: boolean }).isError, true);
		assert.notEqual(((await conclude(slipped, "solved")) as { isError?: boolean }).isError, true);
	});
});

describe("the practice hint route", () => {
	it("gives a labelled hint, writes it into the chat with its size, and answers the whole list", async () => {
		const chat = practiceChat();
		const before = chatStore.getChat(chat.id)!.messages.length;
		const { engine, contexts } = scripted(["SIZE: nudge\n\nThink about which rule applies to a quotient."]);
		const res = await handleHintRequest(chat.id, { toolCallId: "pc1", thinking: "I got stuck at the quotient" }, engine);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), {
			hint: "Think about which rule applies to a quotient.",
			n: 1,
			size: "nudge",
			hints: [{ size: "nudge", text: "Think about which rule applies to a quotient." }],
		});
		const sent = JSON.stringify(contexts[0]);
		assert.match(sent, /HINT REQUEST/);
		assert.match(sent, /I got stuck at the quotient/);
		const record = chatStore.getChat(chat.id)!.messages;
		assert.equal(record.length, before + 1);
		assert.deepEqual(practiceHintsOf(record, "pc1"), [{ size: "nudge", text: "Think about which rule applies to a quotient." }]);
	});

	it("an unlabelled reply is recorded as a nudge, and the second hint is told the first", async () => {
		const chat = practiceChat();
		await handleHintRequest(chat.id, { toolCallId: "pc1" }, scripted(["No label here."]).engine);
		assert.deepEqual(practiceHintsOf(chatStore.getChat(chat.id)!.messages, "pc1"), [{ size: "nudge", text: "No label here." }]);
		const { engine, contexts } = scripted(["SIZE: carry\nSubstitute u = 2x first."]);
		const res = await handleHintRequest(chat.id, { toolCallId: "pc1" }, engine);
		assert.equal((await res.json() as { n: number }).n, 2);
		assert.match(JSON.stringify(contexts[0]), /1 \(nudge\): No label here\./);
	});

	it("counts from the record: the fourth hint is refused whatever the browser says", async () => {
		const markers = [1, 2, HINT_MAX].map((n) => newPracticeHintMarker("pc1", n, "slip", `h${n}`) as never);
		const chat = practiceChat(markers);
		const res = await handleHintRequest(chat.id, { toolCallId: "pc1", earlier: [] }, scripted(["SIZE: slip\nx"]).engine);
		assert.equal(res.status, 400);
		assert.equal(practiceHintsOf(chatStore.getChat(chat.id)!.messages, "pc1").length, 3);
	});

	it("refuses another problem's id", async () => {
		const chat = practiceChat();
		assert.equal((await handleHintRequest(chat.id, { toolCallId: "nope" }, scripted([]).engine)).status, 409);
	});

	it("reads the learner's current page: the page rides the call as an image and never enters the record", async () => {
		const chat = practiceChat();
		const sketch = { id: "sk_test_page_0001", producer: "web-canvas", strokes: [{ size: 3, color: "#111111", points: [10, 10, 0.5, 80, 40, 0.5, 150, 20, 0.5] }] };
		const { engine, contexts } = scripted(["SIZE: slip\nLook again at the second line."]);
		const res = await handleHintRequest(chat.id, { toolCallId: "pc1", sketch }, engine);
		assert.equal(res.status, 200);
		const sent = JSON.stringify(contexts[0]);
		assert.match(sent, /CURRENT handwriting/);
		assert.match(sent, /"type":"image"/);
		assert.equal(chatStore.getChat(chat.id)!.messages.some((m) => (m as { customType?: string }).customType === "sketch"), false);
	});

	it("keeps the page the hint was written from, beside the chat's sketches and never as a sketch", async () => {
		const chat = practiceChat();
		const sketch = { id: "sk_test_page_0002", producer: "web-canvas", strokes: [{ size: 3, color: "#111111", points: [10, 10, 0.5, 80, 40, 0.5, 150, 20, 0.5] }] };
		const res = await handleHintRequest(chat.id, { toolCallId: "pc1", sketch }, scripted(["SIZE: slip\nHint 1: Look again."]).engine);
		assert.deepEqual((await res.json() as { hint: string }).hint, "Look again.");
		const dir = path.join(TMP_DATA, "sketches", chat.id, "hint-pages");
		assert.deepEqual(fs.readdirSync(dir).sort(), ["pc1_hint1-0.png", "pc1_hint1.json"]);
		assert.equal(fs.readFileSync(path.join(dir, "pc1_hint1-0.png")).subarray(1, 4).toString(), "PNG");
		const meta = JSON.parse(fs.readFileSync(path.join(dir, "pc1_hint1.json"), "utf8")) as { n: number; strokeCount: number };
		assert.equal(meta.n, 1);
		assert.equal(meta.strokeCount, 1);
	});

	it("a page that cannot be read is no ink: the hint goes out text-only", async () => {
		const chat = practiceChat();
		const { engine, contexts } = scripted(["SIZE: slip\nLook again."]);
		const res = await handleHintRequest(chat.id, { toolCallId: "pc1", sketch: { id: "bad", strokes: [] } }, engine);
		assert.equal(res.status, 200);
		assert.ok(!JSON.stringify(contexts[0]).includes("CURRENT handwriting"));
	});
});
