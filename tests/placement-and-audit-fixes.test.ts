import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { coursePromptSection, newCourseContextMessage } from "../src/core/course-session.ts";
import { foldSkills, PLACEMENT_GOOD_SEED_DAYS, PLACEMENT_SEED_DAYS, PREREQUISITE_SEED_DAYS, skillEventsOf, understandingOf } from "../src/core/mastery.ts";
import { recentSolvedForSession } from "../src/core/missed-problems.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { formatPlacementStatus, hasUnreadPlacementSketch, placementProgressOf, type PlacementSkillInfo } from "../src/core/placement-frontier.ts";
import { dockSubmitGate, emptyDockSelection } from "../src/core/question-core.ts";
import { projectView, stripDuplicateProblemProse } from "../src/core/view.ts";
import { createPlacementAgent } from "../src/agent/teacher-agent.ts";
import { installPlacementGrader, placementGradeAfterReadSketchHook } from "../src/agent/placement-grade.ts";
import { finishSessionTool, placementProbeTool, placementRecallTool } from "../src/agent/tools/course.ts";

let ts = 1000;
const assistantMsg = (content: AssistantMessage["content"]): LhMessage =>
	({
		id: `a_${ts}`,
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: ts++,
	}) as unknown as LhMessage;

const toolRes = (toolCallId: string, toolName: string, details: Record<string, unknown>, isError = false): LhMessage =>
	({
		id: `r_${ts}`,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
		isError,
		timestamp: ts++,
	}) as unknown as LhMessage;

const skills: PlacementSkillInfo[] = [
	{ id: "sk_base", name: "Base", requires: [], priority: 3 },
	{ id: "sk_mid", name: "Mid", requires: ["sk_base"], priority: 3 },
	{ id: "sk_top", name: "Top", requires: ["sk_mid"], priority: 3 },
	{ id: "sk_alt", name: "Alt", requires: ["sk_base"], priority: 2 },
	{ id: "sk_zero", name: "ZeroWeight", requires: [], priority: 0 },
];

describe("placement-frontier", () => {
	it("ranks weighted top-down sinks before w=0 and propagates easy/good credits while blocking direct misses", () => {
		const initial = placementProgressOf([], skills);
		assert.equal(initial.frontier[0], "sk_top", "highest weight + most prereqs sink comes first");
		assert.ok(!initial.frontier.includes("sk_zero"), "w=0 is held back while weighted skills remain");

		// Miss sk_base directly, then answer sk_top as `good` -> sk_mid is credited, sk_base is NOT credited
		const msgs: LhMessage[] = [
			assistantMsg([{ type: "toolCall", id: "p1", name: "probe", arguments: { skill: "sk_base" } } as ToolCall]),
			toolRes("p1", "probe", { kind: "quiz", correct: false, confidence: 70, placementGrade: { skill: "sk_base", grade: "again" } }),
			assistantMsg([{ type: "toolCall", id: "p2", name: "recall", arguments: { skill: "sk_top" } } as ToolCall]),
			toolRes("p2", "recall", { kind: "explain", text: "done", confidence: 50, placementGrade: { skill: "sk_top", grade: "good" } }),
		];
		const prog = placementProgressOf(msgs, skills);
		assert.equal(prog.credited.get("sk_mid"), "sk_top");
		assert.equal(prog.credited.has("sk_base"), false, "direct miss blocks inferred credit");
		assert.deepEqual(prog.uncoveredWeighted, ["sk_alt"]);
		assert.deepEqual(prog.frontier, ["sk_alt"]);

		// Once sk_alt is answered, only w=0 remains and status prompts ask_user_question
		const msgs2: LhMessage[] = [
			...msgs,
			assistantMsg([{ type: "toolCall", id: "p3", name: "probe", arguments: { skill: "sk_alt" } } as ToolCall]),
			toolRes("p3", "probe", { kind: "quiz", correct: true, confidence: 90, placementGrade: { skill: "sk_alt", grade: "easy" } }),
		];
		const prog2 = placementProgressOf(msgs2, skills);
		assert.deepEqual(prog2.uncoveredWeighted, []);
		assert.deepEqual(prog2.frontier, ["sk_zero"]);
		assert.match(formatPlacementStatus(prog2, skills), /ask_user_question/);
	});

	it("detects unread sketches on the latest placement answer", () => {
		const withSketch: LhMessage[] = [
			assistantMsg([{ type: "toolCall", id: "p1", name: "recall", arguments: { skill: "sk_top" } } as ToolCall]),
			toolRes("p1", "recall", { kind: "explain", sketch: { id: "sk_img1", pages: [{}] } }),
		];
		assert.deepEqual(hasUnreadPlacementSketch(withSketch), { sketchId: "sk_img1" });

		const afterRead: LhMessage[] = [
			...withSketch,
			assistantMsg([{ type: "toolCall", id: "r1", name: "read_sketch", arguments: { sketchId: "sk_img1", reading: "x=1", uncertain: [] } } as ToolCall]),
			toolRes("r1", "read_sketch", { sketchId: "sk_img1", doubts: 0 }),
		];
		assert.equal(hasUnreadPlacementSketch(afterRead), null);
	});
});

describe("mastery folding with placement grader verdicts", () => {
	const reqs = (id: string) => skills.find((s) => s.id === id)?.requires ?? [];

	it("seeds easy=40d + prereqs=7d, good=12d + prereqs=7d, hard=normal FSRS without prereqs, again=blocked", () => {
		const msgs: LhMessage[] = [
			// sk_base missed directly -> blocks inferred credit
			assistantMsg([{ type: "toolCall", id: "p1", name: "probe", arguments: { skill: "sk_base" } } as ToolCall]),
			toolRes("p1", "probe", { kind: "quiz", correct: false, confidence: 70, placementGrade: { skill: "sk_base", grade: "again" } }),
			// sk_top graded `good` via read_sketch -> 12d + sk_mid 7d (sk_base stays unlearned!)
			assistantMsg([{ type: "toolCall", id: "p2", name: "recall", arguments: { skill: "sk_top" } } as ToolCall]),
			toolRes("p2", "recall", { kind: "explain", sketch: { id: "s2", pages: [{}] } }),
			assistantMsg([{ type: "toolCall", id: "r2", name: "read_sketch", arguments: { sketchId: "s2", reading: "ok", uncertain: [] } } as ToolCall]),
			toolRes("r2", "read_sketch", { sketchId: "s2", doubts: 0, placementGrade: { skill: "sk_top", grade: "good" } }),
			// sk_alt graded `hard` -> no prereq credit, normal FSRS hard stability (< 7d)
			assistantMsg([{ type: "toolCall", id: "p3", name: "recall", arguments: { skill: "sk_alt" } } as ToolCall]),
			toolRes("p3", "recall", { kind: "explain", text: "half", placementGrade: { skill: "sk_alt", grade: "hard" } }),
			// sk_zero graded `easy` -> 40d known
			assistantMsg([{ type: "toolCall", id: "p4", name: "probe", arguments: { skill: "sk_zero" } } as ToolCall]),
			toolRes("p4", "probe", { kind: "quiz", correct: true, confidence: 90, placementGrade: { skill: "sk_zero", grade: "easy" } }),
		];

		const events = skillEventsOf(msgs, { courseId: "c1", mode: "placement", skillIds: skills.map((s) => s.id) });
		const states = foldSkills(events, reqs);
		assert.equal(states.has("sk_base"), false, "direct miss never credited");
		assert.equal(states.get("sk_top")?.stability, PLACEMENT_GOOD_SEED_DAYS);
		assert.equal(states.get("sk_mid")?.stability, PREREQUISITE_SEED_DAYS);
		assert.ok((states.get("sk_alt")?.stability ?? 99) < PREREQUISITE_SEED_DAYS, "hard uses normal FSRS without seeding");
		assert.equal(states.get("sk_zero")?.stability, PLACEMENT_SEED_DAYS);
		assert.ok(understandingOf(states.get("sk_zero")!) >= 6);
	});
});

describe("placement tools & context", () => {
	afterEach(() => installPlacementGrader(null));

	it("refuses probe/recall on an already-credited skill and finish_session when weighted skills remain", async () => {
		const msgs: LhMessage[] = [
			assistantMsg([{ type: "toolCall", id: "p1", name: "probe", arguments: { skill: "sk_top" } } as ToolCall]),
			toolRes("p1", "probe", { kind: "quiz", correct: true, confidence: 90, placementGrade: { skill: "sk_top", grade: "easy" } }),
		];
		const prog = placementProgressOf(msgs, skills);
		const list = () => skills.map((s) => ({ id: s.id, name: s.name }));

		const recall = placementRecallTool(list, () => prog);
		const probe = placementProbeTool(list, () => prog);
		const resRecall = await recall.execute("c1", { skill: "sk_mid", question: "q", correctAnswer: "a" });
		assert.equal(resRecall.isError, true);
		assert.match((resRecall.content[0] as { text: string }).text, /already credited/);

		const resProbe = await probe.execute("c2", {
			skill: "sk_base",
			question: "q",
			options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
			correctAnswer: "a",
			explanation: "A",
		});
		assert.equal(resProbe.isError, true);
		assert.match((resProbe.content[0] as { text: string }).text, /already credited/);

		const fin = finishSessionTool({
			chatId: "chat_1",
			chatStore: { getChat: () => ({ id: "chat_1", title: "Placement", createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z", messages: msgs }) },
			placementCheck: () => ({ uncoveredWeighted: [{ id: "sk_alt", name: "Alt" }], stoppedEarly: false }),
		});
		const resFin = await fin.execute("c3", { summary: "Done" });
		assert.equal(resFin.isError, true);
		assert.match((resFin.content[0] as { text: string }).text, /sk_alt/);
	});

	it("createPlacementAgent includes both probe and recall tools and prints requires/weights in context", () => {
		const agent = createPlacementAgent(
			{ skills: () => skills, placementSkills: skills },
			{ engine: { model: { id: "fixture" } as never, streamFn: (() => {}) as never } },
		);
		const names = agent.state.tools.map((t) => t.name);
		assert.ok(names.includes("probe"));
		assert.ok(names.includes("recall"));

		const ctx = newCourseContextMessage({
			courseTitle: "ADE",
			mode: "placement",
			skills: skills.map((s) => ({
				id: s.id,
				name: s.name,
				statement: s.name,
				understanding: 0,
				learned: false,
				known: false,
				needsReview: false,
				requires: s.requires,
				priority: s.priority,
			})),
			propositions: [],
			chains: [],
		});
		assert.match(ctx.content, /w=3 · requires: sk_mid/);
		assert.match(ctx.content, /w=0 \(not examined\)/);
	});
});

describe("chunk 1.5 & chunk 3 helpers", () => {
	it("dockSubmitGate requires confidence in text mode when requireConfidence is true", () => {
		assert.deepEqual(
			dockSubmitGate({ kind: "explain", mode: "text", sel: emptyDockSelection(), other: "", text: "42", confidenceSet: false, requireConfidence: true }),
			{ canSubmit: false, needsConfidence: true },
		);
		assert.deepEqual(
			dockSubmitGate({ kind: "explain", mode: "text", sel: emptyDockSelection(), other: "", text: "42", confidenceSet: true, requireConfidence: true }),
			{ canSubmit: true, needsConfidence: false },
		);
		assert.deepEqual(
			dockSubmitGate({ kind: "explain", mode: "text", sel: { ...emptyDockSelection(), dontKnow: true }, other: "", text: "", confidenceSet: false, requireConfidence: true }),
			{ canSubmit: true, needsConfidence: false },
		);
	});

	it("recentSolvedForSession returns newest solved problems per skill and coursePromptSection renders them", () => {
		const solved = recentSolvedForSession(
			[
				{ chatId: "c1", at: 100, statement: "Old MVT", skills: ["sk_1"], outcome: "solved" },
				{ chatId: "c2", at: 300, statement: "New MVT", skills: ["sk_1"], outcome: "solved" },
				{ chatId: "c3", at: 200, statement: "Mid MVT", skills: ["sk_1"], outcome: "solved" },
				{ chatId: "c4", at: 400, statement: "Hinted MVT", skills: ["sk_1"], outcome: "solvedWithHints" },
			],
			["sk_1"],
			2,
		);
		assert.deepEqual(solved.map((s) => s.statement), ["New MVT", "Mid MVT"]);
		const sec = coursePromptSection("review", "Matte 1", [], false, [], [{ statement: "New MVT", skillNames: ["MVT"], date: "2026-11-22" }]);
		assert.match(sec, /RECENTLY SOLVED/);
		assert.match(sec, /New MVT/);
	});

	it("stripDuplicateProblemProse removes duplicated problem statement while preserving orientation line", () => {
		const stmt = "Funksjonen $f$ er deriverbar for alle reelle $x$, med $f(0)=1$ og $f'(x)\\le 2$ for alle $x$.";
		const prose = `Neste ferdighet er middelverdisetningen.\n\n**Oppgave**\n${stmt}`;
		assert.equal(stripDuplicateProblemProse(prose, stmt), "Neste ferdighet er middelverdisetningen.");
		assert.equal(stripDuplicateProblemProse("Vi starter med middelverdisetningen.", stmt), "Vi starter med middelverdisetningen.");
	});

	it("sketch re-read overwrites an earlier read_sketch placement grade in both progress and mastery", () => {
		const msgs: LhMessage[] = [
			assistantMsg([{ type: "toolCall", id: "p1", name: "recall", arguments: { skill: "sk_top" } } as ToolCall]),
			toolRes("p1", "recall", { kind: "explain", sketch: { id: "s_dispute", pages: [{}] } }),
			assistantMsg([{ type: "toolCall", id: "r1", name: "read_sketch", arguments: { sketchId: "s_dispute", reading: "wrong", uncertain: [] } } as ToolCall]),
			toolRes("r1", "read_sketch", { sketchId: "s_dispute", doubts: 0, placementGrade: { skill: "sk_top", grade: "again" } }),
			assistantMsg([{ type: "toolCall", id: "r2", name: "read_sketch", arguments: { sketchId: "s_dispute", reading: "actually right", uncertain: [] } } as ToolCall]),
			toolRes("r2", "read_sketch", { sketchId: "s_dispute", doubts: 0, placementGrade: { skill: "sk_top", grade: "good" } }),
		];
		const prog = placementProgressOf(msgs, skills);
		assert.equal(prog.directGrades.get("sk_top"), "good");
		assert.equal(prog.credited.get("sk_mid"), "sk_top");
		const events = skillEventsOf(msgs, { courseId: "c1", mode: "placement", skillIds: skills.map((s) => s.id) });
		assert.equal(events[0]?.outcome, "placementGood");
	});

	it("placementGradeAfterReadSketchHook grades clean read_sketch and skips when doubts > 0", async () => {
		installPlacementGrader(async () => ({ grade: "good", gradedBy: "session" }));
		const hook = placementGradeAfterReadSketchHook({ placementSkills: skills });
		const history: LhMessage[] = [
			assistantMsg([{ type: "toolCall", id: "p1", name: "recall", arguments: { skill: "sk_top" } } as ToolCall]),
			toolRes("p1", "recall", { kind: "explain", sketch: { id: "sk_img2", pages: [{}] } }),
		];
		const readAssistant = assistantMsg([
			{ type: "toolCall", id: "r_doubt", name: "read_sketch", arguments: { sketchId: "sk_img2", reading: "?", uncertain: ["x"] } } as ToolCall,
		]);
		const doubtRes = await hook({
			toolCall: { type: "toolCall", id: "r_doubt", name: "read_sketch", arguments: { sketchId: "sk_img2", reading: "?", uncertain: ["x"] } },
			args: { sketchId: "sk_img2", reading: "?", uncertain: ["x"] },
			assistantMessage: readAssistant as never,
			result: { content: [{ type: "text", text: "ok" }], details: { sketchId: "sk_img2", doubts: 1 } },
			isError: false,
			context: { messages: history as never } as never,
		});
		assert.equal(doubtRes, undefined);

		const readClean = assistantMsg([
			{ type: "toolCall", id: "r_ok", name: "read_sketch", arguments: { sketchId: "sk_img2", reading: "V=IR", uncertain: [] } } as ToolCall,
		]);
		const cleanRes = await hook({
			toolCall: { type: "toolCall", id: "r_ok", name: "read_sketch", arguments: { sketchId: "sk_img2", reading: "V=IR", uncertain: [] } },
			args: { sketchId: "sk_img2", reading: "V=IR", uncertain: [] },
			assistantMessage: readClean as never,
			result: { content: [{ type: "text", text: "Read ok" }], details: { sketchId: "sk_img2", doubts: 0 } },
			isError: false,
			context: { messages: history as never } as never,
		});
		assert.ok(cleanRes);
		const pg = (cleanRes.details as { placementGrade?: { grade: string; skill: string } }).placementGrade;
		assert.deepEqual(pg, { skill: "sk_top", grade: "good", gradedBy: "session" });
		const txt = (cleanRes.content?.[0] as { text: string }).text;
		assert.match(txt, /Graded sk_top: good/);
		assert.match(txt, /Placement status:/);
	});

	it("finish_session afterToolCall guard tells agent to stop when substantial closing summary preceded it", async () => {
		const faux = createFauxCore({});
		const longSummary = "Du har nå vist god kontroll på de grunnleggende regnereglene og vi er klare til å avslutte kartleggingen av dette emnet.";
		assert.ok(longSummary.length >= 120);
		faux.setResponses([
			() => fauxAssistantMessage([
				{ type: "text", text: longSummary },
				fauxToolCall("finish_session", { summary: "Done." }, { id: "fin_1" }),
			], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([{ type: "text", text: "" }], { stopReason: "stop" }),
		]);
		const finTool = finishSessionTool({
			chatId: "c_fin",
			chatStore: { getChat: () => ({ id: "c_fin", title: "Placement", createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z", messages: [] }) },
		});
		const agent = createPlacementAgent(
			{ skills: () => skills, placementSkills: skills },
			{
				engine: { model: faux.getModel(), streamFn: faux.streamSimple },
				course: { section: "<course>test</course>", tools: [finTool] },
			},
		);
		await agent.prompt("Finish now");
		const finResult = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "finish_session");
		assert.ok(finResult && finResult.role === "toolResult");
		const resText = (finResult.content[0] as { text: string }).text;
		assert.match(resText, /You already gave your closing summary — end your turn with no further text or tool calls/);
	});

	it("finishSessionTool placementCheck reading live messages allows finish after intra-turn read_sketch", async () => {
		const liveMsgs: LhMessage[] = [
			assistantMsg([{ type: "toolCall", id: "p1", name: "probe", arguments: { skill: "sk_alt" } } as ToolCall]),
			toolRes("p1", "probe", { kind: "quiz", correct: true, confidence: 90, placementGrade: { skill: "sk_alt", grade: "easy" } }),
			assistantMsg([{ type: "toolCall", id: "p2", name: "recall", arguments: { skill: "sk_top" } } as ToolCall]),
			toolRes("p2", "recall", { kind: "explain", sketch: { id: "s_last", pages: [{}] } }),
		];
		const fin = finishSessionTool({
			chatId: "c_live",
			chatStore: { getChat: () => ({ id: "c_live", title: "Placement", createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z", messages: [] }) },
			placementCheck: () => {
				const prog = placementProgressOf(liveMsgs, skills);
				return { uncoveredWeighted: prog.uncoveredWeighted.map((id) => ({ id, name: id })), stoppedEarly: prog.stoppedEarly };
			},
		});
		const beforeRead = await fin.execute("f1", { summary: "Done" });
		assert.equal(beforeRead.isError, true);

		liveMsgs.push(
			assistantMsg([{ type: "toolCall", id: "r_last", name: "read_sketch", arguments: { sketchId: "s_last", reading: "ok", uncertain: [] } } as ToolCall]),
			toolRes("r_last", "read_sketch", { sketchId: "s_last", doubts: 0, placementGrade: { skill: "sk_top", grade: "good" } }),
		);
		const afterRead = await fin.execute("f2", { summary: "Done" });
		assert.equal(afterRead.isError, undefined);
	});

	it("projectView strips duplicated problem prose while keeping orientation line and problem tool part", () => {
		const stmt = "Funksjonen $f$ er deriverbar for alle reelle $x$, med $f(0)=1$ og $f'(x)\\le 2$ for alle $x$.";
		const native: LhMessage[] = [
			{ id: "u1", role: "user", content: "Start", timestamp: 1 } as LhMessage,
			assistantMsg([
				{ type: "text", text: `Neste ferdighet er middelverdisetningen.\n\n**Oppgave**\n${stmt}` },
				{ type: "toolCall", id: "prob_1", name: "problem", arguments: { statement: stmt, mode: "recall", modelSolution: "MVT", skills: ["sk_1"] } } as ToolCall,
			]),
		];
		const view = projectView(native);
		const assistantView = view.find((m) => m.role === "assistant");
		assert.ok(assistantView);
		const textPart = assistantView.parts.find((p) => p.type === "text");
		assert.equal(textPart?.text, "Neste ferdighet er middelverdisetningen.");
		assert.ok(assistantView.parts.some((p) => p.type === "tool-problem"));
	});
});
