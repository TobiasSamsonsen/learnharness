/**
 * The learner profile's automatic layer (fork addition, 2026-11-11): the events
 * read out of transcripts and the Moderate-floor fold. Pure, no store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CALIBRATION_MIN_ANSWERS,
	MISS_HALF_LIFE_DAYS,
	foldLearner,
	learnerEventsOf,
	learnerEventsOfAll,
	namedMisses,
	type AnswerEvent,
	type ConcludedEvent,
	type LearnerChatInput,
	type MissClass,
} from "../src/core/learner-fold.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

let seq = 0;
function assistant(calls: Array<{ id: string; name: string; args: unknown }>, at: number): LhMessage {
	return {
		id: `m${++seq}`,
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })),
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: at,
	} as unknown as LhMessage;
}
function result(toolCallId: string, toolName: string, at: number, opts: { isError?: boolean; details?: unknown } = {}): LhMessage {
	return {
		id: `m${++seq}`,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: opts.isError ?? false,
		details: opts.details,
		timestamp: at,
	} as unknown as LhMessage;
}
/** One posed-and-concluded problem. */
function problem(skills: string[], conclude: Record<string, unknown>, at: number): LhMessage[] {
	const p = `p${++seq}`;
	const c = `c${++seq}`;
	return [
		assistant([{ id: p, name: "problem", args: { statement: "S", mode: "recall", modelSolution: "M", skills } }], at),
		result(p, "problem", at),
		assistant([{ id: c, name: "conclude", args: { outcome: "solved", verdict: "v", rung: null, missClass: null, retest: false, ...conclude } }], at + 1),
		result(c, "conclude", at + 1),
	];
}
/** One answered quiz or probe. */
function answer(tool: "quiz" | "probe", at: number, data: Record<string, unknown>): LhMessage[] {
	const id = `q${++seq}`;
	return [
		assistant([{ id, name: tool, args: {} }], at),
		result(id, tool, at + 1, { details: { kind: "quiz", tool, questionText: "Q?", dontKnow: false, answers: [], ...data } }),
	];
}

const practiceChat = (id: string, messages: LhMessage[], mode?: "practice" | "review"): LearnerChatInput => ({
	id,
	kind: "practice",
	...(mode ? { course: { mode } } : {}),
	messages,
});
const teachChat = (id: string, messages: LhMessage[], mode?: "learn" | "placement" | "check"): LearnerChatInput => ({
	id,
	...(mode ? { course: { mode } } : {}),
	messages,
});

const miss = (chatId: string, missClass: MissClass | null, at: number): ConcludedEvent => ({
	chatId,
	at,
	skills: [],
	outcome: "solved",
	rung: null,
	missClass,
	verdict: "",
});
const ans = (chatId: string, over: Partial<AnswerEvent> = {}): AnswerEvent => ({
	chatId,
	at: T0,
	dontKnow: false,
	correct: true,
	confidence: 70,
	questionText: "Q?",
	...over,
});

describe("learnerEventsOf: concluded problems", () => {
	it("reads outcome, rung, missClass, verdict and the problem's skills", () => {
		const e = learnerEventsOf(
			practiceChat("c1", [
				...problem(["a", "b", "a"], { outcome: "solvedWithHints", verdict: "dropped a sign", rung: "R2", missClass: "careless" }, T0),
				...problem(["c"], {}, T0 + 10),
			]),
		);
		assert.deepEqual(
			e.concluded.map((x) => [x.skills, x.outcome, x.rung, x.missClass, x.verdict, x.at]),
			[
				[["a", "b"], "solvedWithHints", "R2", "careless", "dropped a sign", T0 + 1],
				[["c"], "solved", null, null, "v", T0 + 11],
			],
		);
		assert.deepEqual(e.answers, []);
	});

	it("treats a bad missClass or rung as none, and skips dismissed and errored concludes", () => {
		const c = `c${++seq}`;
		const messages = [
			...problem(["a"], { missClass: "sloppy", rung: "R9" }, T0),
			...problem(["a"], { outcome: "dismissed", missClass: "cue" }, T0 + 5),
			assistant([{ id: c, name: "conclude", args: { outcome: "solved", verdict: "v", rung: null, missClass: "cue", retest: false } }], T0 + 9),
			result(c, "conclude", T0 + 9, { isError: true }),
		];
		const e = learnerEventsOf(practiceChat("c1", messages));
		assert.equal(e.concluded.length, 1);
		assert.equal(e.concluded[0]!.missClass, null);
		assert.equal(e.concluded[0]!.rung, null);
	});

	it("counts a non-course practice chat too", () => {
		assert.equal(learnerEventsOf(practiceChat("c1", problem([], { missClass: "execution" }, T0))).concluded.length, 1);
	});

	it("gives nothing for a problem whose pose was refused (no conclude without a clean call)", () => {
		const p = `p${++seq}`;
		const messages = [assistant([{ id: p, name: "problem", args: { skills: ["a"] } }], T0), result(p, "problem", T0, { isError: true })];
		assert.equal(learnerEventsOf(practiceChat("c1", messages)).concluded.length, 0);
	});
});

describe("learnerEventsOf: quiz and probe answers", () => {
	it("reads correct, dontKnow and confidence from teach and learn chats", () => {
		const messages = [
			...answer("quiz", T0, { correct: false, confidence: 95 }),
			...answer("probe", T0 + 10, { dontKnow: true }),
			...answer("quiz", T0 + 20, { correct: true, confidence: 60 }),
			...answer("quiz", T0 + 30, { correct: true }), // an old record: no confidence
		];
		const e = learnerEventsOf(teachChat("c1", messages, "learn"));
		assert.deepEqual(
			e.answers.map((x) => [x.dontKnow, x.correct, x.confidence]),
			[
				[false, false, 95],
				[true, undefined, undefined],
				[false, true, 60],
				[false, true, undefined],
			],
		);
		assert.equal(learnerEventsOf(teachChat("c2", messages)).answers.length, 4, "a free teach chat counts as well");
	});

	it("skips explain answers, dismissed answers and errors", () => {
		const id = `q${++seq}`;
		const messages = [
			assistant([{ id, name: "explain", args: {} }], T0),
			result(id, "explain", T0 + 1, { details: { kind: "explain", questionText: "Q", dontKnow: false } }),
			...answer("quiz", T0 + 5, { dismissed: true }),
			assistant([{ id: "e1", name: "quiz", args: {} }], T0 + 8),
			result("e1", "quiz", T0 + 9, { isError: true, details: { kind: "quiz", dontKnow: false, correct: false } }),
		];
		assert.deepEqual(learnerEventsOf(teachChat("c1", messages)).answers, []);
	});

	it("leaves placement sessions out entirely, but a context check counts like practice", () => {
		const messages = [...answer("probe", T0, { correct: false, confidence: 99 }), ...problem(["a"], { missClass: "cue" }, T0 + 5)];
		assert.deepEqual(learnerEventsOf({ id: "c", course: { mode: "placement" }, messages }), { concluded: [], answers: [] });
		assert.deepEqual(learnerEventsOf({ id: "c", kind: "practice", course: { mode: "placement" }, messages }), { concluded: [], answers: [] });
		// a context check (mode "check") is a short practice session: its concluded problems are evidence
		assert.equal(learnerEventsOf({ id: "c", kind: "practice", course: { mode: "check" }, messages }).concluded.length, 1);
	});

	it("a teach chat gives no concluded problems and a practice chat gives no answers", () => {
		const messages = [...answer("quiz", T0, { correct: true, confidence: 80 }), ...problem(["a"], { missClass: "cue" }, T0 + 5)];
		assert.equal(learnerEventsOf(teachChat("c1", messages)).concluded.length, 0);
		assert.equal(learnerEventsOf(practiceChat("c1", messages)).answers.length, 0);
	});

	it("merges many chats", () => {
		const all = learnerEventsOfAll([
			teachChat("t", answer("quiz", T0, { correct: true, confidence: 80 })),
			practiceChat("p", problem(["a"], { missClass: "cue" }, T0)),
		]);
		assert.equal(all.answers.length, 1);
		assert.equal(all.concluded.length, 1);
	});
});

describe("foldLearner: the miss floors (raw counts)", () => {
	const now = T0 + 30 * DAY;

	it("shows nothing to the tutor below 6 classified misses, but keeps the stats", () => {
		const events = { concluded: [miss("a", "execution", T0), miss("b", "execution", T0), miss("c", "execution", T0), miss("a", "careless", T0), miss("b", null, T0)], answers: [] };
		const fold = foldLearner(events, now);
		assert.equal(fold.classified, 4, "a problem with no miss class is not a classified miss");
		assert.equal(fold.missesShown, false);
		assert.deepEqual(namedMisses(fold), []);
		assert.equal(fold.classes.find((c) => c.missClass === "execution")?.named, true, "the per-class stat still says it passes");
	});

	it("at 6 misses names only the classes with >= 3 misses from >= 2 sessions", () => {
		const events = {
			concluded: [
				miss("a", "execution", T0),
				miss("b", "execution", T0),
				miss("a", "execution", T0),
				miss("a", "careless", T0), // 1 miss
				miss("a", "discrimination", T0),
				miss("a", "discrimination", T0), // 3 misses...
				miss("a", "discrimination", T0), // ...but one session
			],
			answers: [],
		};
		const fold = foldLearner(events, now);
		assert.equal(fold.classified, 7);
		assert.equal(fold.missesShown, true);
		assert.deepEqual(namedMisses(fold).map((c) => c.missClass), ["execution"]);
		const disc = fold.classes.find((c) => c.missClass === "discrimination")!;
		assert.deepEqual([disc.count, disc.sessions, disc.named], [3, 1, false]);
	});

	it("the floors count raw events, so an old pattern is still named", () => {
		const old = T0 - 400 * DAY;
		const events = { concluded: [miss("a", "cue", old), miss("b", "cue", old), miss("a", "cue", old), miss("b", "careless", T0), miss("a", "careless", T0), miss("b", "execution", T0)], answers: [] };
		const fold = foldLearner(events, now);
		assert.equal(fold.missesShown, true);
		assert.ok(namedMisses(fold).some((c) => c.missClass === "cue"));
	});

	it("ranks by recency weight, half-life 45 days, then by count", () => {
		const events = {
			concluded: [
				miss("a", "cue", now - 90 * DAY), // two half-lives: 0.25
				miss("b", "cue", now - 90 * DAY),
				miss("a", "cue", now - 90 * DAY),
				miss("a", "careless", now), // 1 recent: 1
			],
			answers: [],
		};
		const fold = foldLearner(events, now);
		assert.deepEqual(fold.classes.map((c) => c.missClass), ["careless", "cue"]);
		assert.ok(Math.abs(fold.classes[0]!.weight - 1) < 1e-9);
		assert.ok(Math.abs(fold.classes[1]!.weight - 0.75) < 1e-9);
		assert.equal(MISS_HALF_LIFE_DAYS, 45);
		assert.equal(fold.classes[1]!.lastAt, now - 90 * DAY);
	});

	it("is empty for no evidence", () => {
		const fold = foldLearner({ concluded: [], answers: [] }, now);
		assert.deepEqual([fold.classified, fold.missesShown, fold.classes], [0, false, []]);
		assert.deepEqual(fold.calibration, { answers: 0, sessions: 0, dontKnow: 0, scored: 0, wrongHigh: 0, shown: false });
	});
});

describe("foldLearner: the calibration line", () => {
	it("counts answers, don't-knows, scored answers and wrong-at->=90", () => {
		const answers = [
			ans("a", { correct: false, confidence: 95 }),
			ans("a", { correct: false, confidence: 90 }),
			ans("a", { correct: false, confidence: 89 }),
			ans("b", { correct: true, confidence: 99 }),
			ans("b", { dontKnow: true, correct: undefined, confidence: undefined }),
			ans("b", { correct: true, confidence: undefined }), // old record: not scored
		];
		const c = foldLearner({ concluded: [], answers }, T0).calibration;
		assert.deepEqual([c.answers, c.sessions, c.dontKnow, c.scored, c.wrongHigh], [6, 2, 1, 4, 2]);
		assert.equal(c.shown, false);
	});

	it("appears at 20 answers from 2 sessions, not at 19 or from one session", () => {
		const many = (n: number, chats: string[]) => Array.from({ length: n }, (_, i) => ans(chats[i % chats.length]!));
		assert.equal(foldLearner({ concluded: [], answers: many(CALIBRATION_MIN_ANSWERS - 1, ["a", "b"]) }, T0).calibration.shown, false);
		assert.equal(foldLearner({ concluded: [], answers: many(CALIBRATION_MIN_ANSWERS, ["a"]) }, T0).calibration.shown, false);
		assert.equal(foldLearner({ concluded: [], answers: many(CALIBRATION_MIN_ANSWERS, ["a", "b"]) }, T0).calibration.shown, true);
	});
});
