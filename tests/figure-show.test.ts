/**
 * Figures wait for the tutor (owner, 2026-11-12): a visual/demo ordered early
 * landed right after the plan. Now its dispatch, delivery and failure stay
 * hidden until the tutor calls show_figure, whose card renders where it is
 * called; old chats render as before; answers to teach questions carry a soft
 * tutor-only note while a finished figure is unshown.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import {
	figureDispatchShown,
	unshownFigures,
	unshownFiguresNote,
	shownFigureIds,
	figureLabel,
	figuresOf,
	type FigureEntry,
} from "../src/core/figure-show.ts";
import { projectView, type LiveTurnState } from "../src/core/view.ts";
import { buildAbortSteer, buildSubagentSteer, type VisualResult, type DemoResult } from "../src/core/contracts/jobs.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import { createShowFigureTool } from "../src/agent/tools/show-figure.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="10" height="10"/></svg>';
const visualOk: VisualResult = { svg: SVG, notes: "fine" };
const visualFailed: VisualResult = { svg: "", notes: "FAILED: iteration limit" };
const demoOk: DemoResult = { title: "Damped oscillator", html: "<html></html>", notes: "ok" } as DemoResult;

let n = 0;
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): LhMessage =>
	({
		id: `a_${++n}`,
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 1,
	}) as LhMessage;
const text = (t: string) => ({ type: "text" as const, text: t });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id, name, arguments: args as ToolCall["arguments"] });
const result = (toolCallId: string, toolName: string, details: unknown, isError = false, body = "ok"): LhMessage =>
	({ id: `r_${toolCallId}`, role: "toolResult", toolCallId, toolName, content: [text(body)], details, isError, timestamp: 1 }) as LhMessage;

/** A figure ordered and delivered under the new rule. */
function newFigure(jobId: string, callId: string, kind: "visual" | "demo" = "visual", res: VisualResult | DemoResult = visualOk): LhMessage[] {
	const args = kind === "visual" ? { brief: "The ε-band around L on the graph of f, with δ-window marked" } : { title: "Damped oscillator", brief: "A spring" };
	return [
		assistant([text("Let's look at the band."), call(callId, kind, args)]),
		result(callId, kind, { jobId, onShow: true }, false, `Dispatched (job ${jobId}). ack`),
		buildSubagentSteer({ id: jobId, kind, toolCallId: callId }, res) as LhMessage,
	];
}

/** A figure from a chat saved before the change: string dispatch details, no flag on the delivery. */
function oldFigure(jobId: string, callId: string): LhMessage[] {
	const steer = buildSubagentSteer({ id: jobId, kind: "visual", toolCallId: callId }, visualOk);
	const { onShow: _drop, ...details } = steer.details as Record<string, unknown>;
	return [
		assistant([text("Here is a figure."), call(callId, "visual", { brief: "old" })]),
		result(callId, "visual", `Dispatched (job ${jobId}). ack`),
		{ ...steer, details } as LhMessage,
	];
}

const showCall = (callId: string, jobId: string, extra: Record<string, unknown> = {}) => assistant([text("Look at this figure."), call(callId, "show_figure", { figure: jobId, ...extra })]);
const showResult = (callId: string, jobId: string, isError = false) => result(callId, "show_figure", isError ? null : { jobId, kind: "visual" }, isError);

const parts = (messages: LhMessage[], live?: LiveTurnState) =>
	projectView(messages, live).flatMap((m) => m.parts) as Array<ReturnType<typeof projectView>[number]["parts"][number] & { figure?: FigureEntry }>;
const steerViews = (messages: LhMessage[]) => projectView(messages).filter((m) => m.parts.some((p) => p.type === "data-subagent-artifact" || p.type === "data-subagent-aborted"));

describe("delivery and dispatch carry the flag", () => {
	it("visual and demo deliveries carry onShow and name their job id; research does not", () => {
		const visual = buildSubagentSteer({ id: "job_v", kind: "visual", toolCallId: "c" }, visualOk);
		assert.equal((visual.details as { onShow?: true }).onShow, true);
		assert.match(visual.content as string, /^Figure job_v is drawn and verified\. It is NOT shown to the learner yet: call show_figure\(\{figure: "job_v"\}\)/);
		const demo = buildSubagentSteer({ id: "job_d", kind: "demo", toolCallId: "c" }, demoOk);
		assert.equal((demo.details as { onShow?: true }).onShow, true);
		assert.match(demo.content as string, /^Demo job_d "Damped oscillator" is built and headlessly tested\. It is NOT shown/);
		const failed = buildSubagentSteer({ id: "job_f", kind: "visual", toolCallId: "c" }, visualFailed);
		assert.match(failed.content as string, /^The figure job_f could not be made: .*The learner never saw it was ordered/);
		const research = buildSubagentSteer({ id: "job_r", kind: "research", toolCallId: "c" }, { brief: "b", sources: [{ url: "https://x", title: "x" }] } as never);
		assert.equal((research.details as { onShow?: true }).onShow, undefined);
	});

	it("figureDispatchShown: only a clean, unflagged (old) dispatch renders", () => {
		assert.equal(figureDispatchShown(undefined), false);
		assert.equal(figureDispatchShown({ isError: true, details: "x" }), false);
		assert.equal(figureDispatchShown({ isError: false, details: { jobId: "j", onShow: true } }), false);
		assert.equal(figureDispatchShown({ isError: false, details: "Dispatched (job j). ack" }), true);
		assert.equal(figureDispatchShown({ isError: false, details: null }), true);
	});
});

describe("the view hides waiting figures", () => {
	it("a new figure's dispatch and delivery render nothing; the teaching text stays", () => {
		const messages = newFigure("job_1", "c1");
		const all = parts(messages);
		assert.ok(all.some((p) => p.type === "text" && p.text === "Let's look at the band."));
		assert.ok(!all.some((p) => p.type === "tool-visual"));
		assert.equal(steerViews(messages).length, 0);
	});

	it("an assistant message holding only the hidden call adds no empty row", () => {
		const messages: LhMessage[] = [
			assistant([call("c1", "visual", { brief: "b" })]),
			result("c1", "visual", { jobId: "job_1", onShow: true }),
		];
		assert.deepEqual(projectView(messages), []);
	});

	it("a running figure call (live, no result yet) is hidden too", () => {
		const m = assistant([text("Teaching."), call("c1", "demo", { title: "t", brief: "b" })]);
		const live: LiveTurnState = { executions: new Map(), inFlight: true, streamingIds: new Set([m.id]) };
		assert.ok(!parts([m], live).some((p) => p.type === "tool-demo"));
	});

	it("a failed new figure and an aborted one stay hidden", () => {
		const failed = newFigure("job_f", "cf", "visual", visualFailed);
		assert.equal(steerViews(failed).length, 0);
		const aborted: LhMessage[] = [...newFigure("job_a", "ca").slice(0, 2), buildAbortSteer({ id: "job_a", kind: "visual", toolCallId: "ca" }) as LhMessage];
		assert.equal(steerViews(aborted).length, 0);
	});

	it("old chats render exactly as before: the dispatch part and the figure where it arrived", () => {
		const messages = oldFigure("job_o", "co");
		assert.ok(parts(messages).some((p) => p.type === "tool-visual" && p.state === "output-available"));
		assert.equal(steerViews(messages).length, 1);
		const aborted: LhMessage[] = [...oldFigure("job_x", "cx").slice(0, 2), buildAbortSteer({ id: "job_x", kind: "visual", toolCallId: "cx" }) as LhMessage];
		assert.equal(steerViews(aborted).length, 1);
	});

	it("research deliveries still render", () => {
		const research = buildSubagentSteer({ id: "job_r", kind: "research", toolCallId: "cr" }, { brief: "b", sources: [{ url: "https://x", title: "x" }] } as never);
		assert.equal(steerViews([research as LhMessage]).length, 1);
	});
});

describe("show_figure renders the figure where it is called", () => {
	it("joins the delivered figure onto the call by job id", () => {
		const messages = [...newFigure("job_1", "c1"), showCall("s1", "job_1", { caption: "The band" }), showResult("s1", "job_1")];
		const shown = parts(messages).filter((p) => p.type === "tool-show_figure");
		assert.equal(shown.length, 1);
		assert.equal(shown[0]!.state, "output-available");
		assert.equal(shown[0]!.figure?.jobId, "job_1");
		assert.equal(shown[0]!.figure?.steerId, "steer_job_1");
		assert.equal((shown[0]!.figure?.result as VisualResult).svg, SVG);
		// The figure sits after the teaching text of the showing turn, not at the delivery.
		const view = projectView(messages);
		const last = view[view.length - 1]!;
		assert.ok(last.parts.some((p) => p.type === "tool-show_figure"));
	});

	it("a figure shown twice gets two cards; an old chat's figure can be shown too", () => {
		const messages = [...newFigure("job_1", "c1"), showCall("s1", "job_1"), showResult("s1", "job_1"), showCall("s2", "job_1"), showResult("s2", "job_1")];
		assert.equal(parts(messages).filter((p) => p.type === "tool-show_figure" && p.figure).length, 2);
		const old = [...oldFigure("job_o", "co"), showCall("s3", "job_o"), showResult("s3", "job_o")];
		assert.ok(parts(old).some((p) => p.type === "tool-show_figure" && p.figure?.jobId === "job_o"));
	});
});

describe("the soft note", () => {
	it("lists finished, unshown figures with a label, and clears once shown", () => {
		const messages = [...newFigure("job_1", "c1"), ...newFigure("job_2", "c2", "demo", demoOk)];
		assert.equal(
			unshownFiguresNote(messages),
			'Figures ready but not shown yet: job_1 (visual: "The ε-band around L on the graph of f, with δ-window marked"), job_2 (demo: "Damped oscillator"). ' +
				"Show one with show_figure in the turn whose teaching it serves; leave it until then.",
		);
		const shownOne = [...messages, showCall("s1", "job_1"), showResult("s1", "job_1")];
		assert.deepEqual(unshownFigures(shownOne).map((f) => f.jobId), ["job_2"]);
		assert.deepEqual([...shownFigureIds(shownOne)], ["job_1"]);
	});

	it("a refused show_figure does not count; failed and old figures are never listed", () => {
		const refused = [...newFigure("job_1", "c1"), showCall("s1", "job_1"), showResult("s1", "job_1", true)];
		assert.deepEqual(unshownFigures(refused).map((f) => f.jobId), ["job_1"]);
		assert.equal(unshownFiguresNote(newFigure("job_f", "cf", "visual", visualFailed)), undefined);
		assert.equal(unshownFiguresNote(oldFigure("job_o", "co")), undefined);
	});

	it("long briefs are shortened", () => {
		const long = "x".repeat(200);
		const messages: LhMessage[] = [
			assistant([call("c1", "visual", { brief: long })]),
			result("c1", "visual", { jobId: "job_1", onShow: true }),
			buildSubagentSteer({ id: "job_1", kind: "visual", toolCallId: "c1" }, visualOk) as LhMessage,
		];
		assert.equal(figureLabel(messages, figuresOf(messages).get("job_1")!), `${"x".repeat(60)}…`);
	});

	it("rides a teach question's answer for the tutor only, never an ask", () => {
		const answer = { kind: "quiz", questionText: "Q", dontKnow: false, answers: [], answeredAt: "t" };
		const forModel = (toolName: string, note?: string) => JSON.parse((newAnswerResult("q1", toolName, answer, note).content[0] as { text: string }).text);
		assert.equal(forModel("quiz", "NOTE").figures, "NOTE");
		assert.equal(forModel("quiz").figures, undefined);
		assert.equal(forModel("ask_user_question", "NOTE").figures, undefined);
		// The learner-facing record (details) is the answer itself, untouched.
		assert.deepEqual(newAnswerResult("q1", "quiz", answer, "NOTE").details, answer);
	});
});

describe("show_figure on a live teacher agent", () => {
	it("rides every teacher and finds a figure delivered mid-run (the run's own history, not the store)", async () => {
		const faux = createFauxCore({});
		const steer = buildSubagentSteer({ id: "job_live", kind: "visual", toolCallId: "c_live" }, visualOk) as LhMessage;
		faux.setResponses([
			// Before the figure is in the run: refused, with nothing ready to list.
			() => fauxAssistantMessage([fauxToolCall("show_figure", { figure: "job_live" }, { id: "s1" })], { stopReason: "toolUse" }),
			// After the steer joined at the turn boundary: shown.
			() => fauxAssistantMessage([fauxToolCall("show_figure", { figure: "job_live" }, { id: "s2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([{ type: "text", text: "Done." }], { stopReason: "stop" }),
		]);
		const agent = createTeacherAgent(undefined, {
			engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			messages: [{ role: "user", content: "Teach me", timestamp: 0 } as never],
		});
		assert.ok(agent.state.tools.some((t) => t.name === "show_figure"), "show_figure rides the teacher");
		agent.steer(steer as never);
		await agent.continue();
		const results = agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as unknown as Array<{ toolCallId: string; isError: boolean; content: Array<{ text?: string }> }>;
		const byId = (id: string) => results.find((r) => r.toolCallId === id)!;
		assert.equal(byId("s2").isError, false, "the mid-run delivery is found");
		assert.equal(byId("s2").content[0]!.text, "Shown: figure job_live (visual).");
	});
});

describe("the show_figure tool", () => {
	it("shows a delivered figure and answers in one line", async () => {
		const messages = newFigure("job_1", "c1");
		const tool = createShowFigureTool({ messages: () => messages });
		const out = await tool.execute("s1", { figure: " job_1 ", caption: " The band " } as never, undefined);
		assert.deepEqual(out.content, [{ type: "text", text: "Shown: figure job_1 (visual)." }]);
		assert.deepEqual(out.details, { jobId: "job_1", kind: "visual", caption: "The band" });
	});

	it("refuses an unknown or failed figure and lists what can be shown", async () => {
		const messages = [...newFigure("job_1", "c1"), ...newFigure("job_f", "cf", "visual", visualFailed)];
		const tool = createShowFigureTool({ messages: () => messages });
		await assert.rejects(tool.execute("s1", { figure: "job_nope" } as never, undefined), /No finished figure or demo with id "job_nope".*Figures you can show: job_1 \(visual: /);
		await assert.rejects(tool.execute("s2", { figure: "job_f" } as never, undefined), /could not be made/);
	});
});
