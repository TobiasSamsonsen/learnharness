/**
 * Courses (fork addition, 2026-10-24 — docs/courses.md): skills in the
 * graph, the understanding threshold for "known", draft checks + approval, the
 * course-session pieces, the stores, the service seam, the practice tool's
 * skill tags, the planner against a scripted model, and the UI's render.
 * Deterministic: no network, no real model; LH_DATA_DIR isolates.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { mergeSkillLines, prerequisiteClosure, topoOrder } = await import("../src/core/skills.ts");
const mastery = await import("../src/core/mastery.ts");
const { approveDraft, draftProblems, uncitedMaterials } = await import("../src/core/course-draft.ts");
const session = await import("../src/core/course-session.ts");
const { skillStore } = await import("../src/store/skills.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { materialStore } = await import("../src/store/materials.ts");
const { subscribe } = await import("../src/core/events.ts");
const courses = await import("../src/server/courses.ts");
const { sessionMaterials } = await import("../src/server/materials.ts");
const { practiceTools, problemTool } = await import("../src/agent/tools/practice.ts");
const { finishLessonTool, placementProbeTool } = await import("../src/agent/tools/course.ts");
const { composeInstructions, createPlacementAgent } = await import("../src/agent/teacher-agent.ts");
const { inputAppends } = await import("../src/core/input-events.ts");
const { draftCourse } = await import("../src/agent/subagents/course-planner.ts");
const { CourseRow, courseMeta } = await import("../components/courses-section.tsx");
const { CourseBody, courseProgress, reviewLabel, skillStateLabel } = await import("../components/course-page.tsx");
const { GraphContextCard } = await import("../components/graph-context-card.tsx");
const { FinishLessonButton, LessonFinishedLine, courseOfView } = await import("../components/lesson-finish.tsx");
const { DictationBar } = await import("../components/dictation.tsx");
const { LEDGER_FILES, PATHS } = await import("../config.ts");

import type { ChatCourseLink, CourseDraft, GraphNode, Skill, SkillLine } from "../src/core/contracts.ts";
import { toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import type { CoursePayload } from "../components/course-page.tsx";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

const line = (id: string, requires: string[] = [], restsOn: string[] = [], name = id): SkillLine => ({
	id,
	name,
	statement: `Do ${name}`,
	requires,
	restsOn,
	createdAt: "2026-10-01T00:00:00Z",
});

// ─── message builders (native records) ──────────────────────────────────────

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
function result(toolCallId: string, toolName: string, at: number, isError = false): LhMessage {
	return { id: `m${++seq}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], isError, timestamp: at } as unknown as LhMessage;
}
/** One posed-and-concluded problem on the given skills. */
function problem(skills: string[], outcome: string, at: number, opts: { poseError?: boolean; grades?: unknown[] } = {}): LhMessage[] {
	const p = `p${++seq}`;
	const c = `c${++seq}`;
	return [
		assistant([{ id: p, name: "problem", args: { statement: "S", mode: "recall", modelSolution: "M", skills } }], at),
		result(p, "problem", at, opts.poseError),
		assistant([{ id: c, name: "conclude", args: { outcome, verdict: "v", rung: null, missClass: null, retest: false, ...(opts.grades ? { grades: opts.grades } : {}) } }], at + 1),
		result(c, "conclude", at + 1),
	];
}

const practiceLink = (skillIds: string[], mode: ChatCourseLink["mode"] = "practice"): ChatCourseLink => ({ courseId: "course_x", mode, skillIds });

// ─── skills ──────────────────────────────────────────────────────────────────

describe("skills (core/skills.ts)", () => {
	it("merges lines by id: the first line defines, later lines union their edges", () => {
		const merged = mergeSkillLines([
			line("a"),
			line("b", ["a"], ["n1"]),
			{ ...line("b", ["c"], ["n2"]), name: "renamed" },
			line("c"),
		]);
		const b = merged.find((s) => s.id === "b")!;
		assert.equal(b.name, "b", "the first line's name stands");
		assert.deepEqual(b.requires, ["a", "c"]);
		assert.deepEqual(b.restsOn, ["n1", "n2"]);
		assert.deepEqual(merged.map((s) => s.id), ["a", "b", "c"]);
	});

	it("drops unknown skills, self-edges and dead propositions at read", () => {
		const merged = mergeSkillLines([line("a", ["a", "ghost"], ["n1", "dead"])], new Set(["n1"]));
		assert.deepEqual(merged[0]!.requires, []);
		assert.deepEqual(merged[0]!.restsOn, ["n1"]);
	});

	it("closure and topological order (prerequisites first; cycles are null)", () => {
		const req: Record<string, string[]> = { d: ["b", "c"], b: ["a"], c: ["a"], a: [] };
		assert.deepEqual([...prerequisiteClosure("d", (id) => req[id] ?? [])].sort(), ["a", "b", "c"]);
		assert.deepEqual(topoOrder(["d", "c", "b", "a"], (id) => req[id] ?? []), ["a", "c", "b", "d"]);
		assert.equal(topoOrder(["x", "y"], (id) => (id === "x" ? ["y"] : ["x"])), null);
	});
});

// ─── understanding (FSRS) ────────────────────────────────────────────────────

describe("understanding — the FSRS fold (core/mastery.ts)", () => {
	const none = () => [];
	const ev = (outcome: string, at: number, grade?: string, skillId = "a") => ({ skillId, outcome: outcome as never, at, ...(grade ? { grade: grade as never } : {}), placement: false });
	const fold = (...events: ReturnType<typeof ev>[]) => mastery.foldSkills(events, none);
	const stabilityOf = (...events: ReturnType<typeof ev>[]) => fold(...events).get("a")?.stability;

	it("reads skill events from cleanly concluded problems only", () => {
		const messages = [
			...problem(["a"], "solved", T0),
			...problem(["b"], "solved", T0 + 10, { poseError: true }), // a refused pose never happened
			...problem(["a", "a", "c"], "movedOn", T0 + 20),
		];
		const events = mastery.skillEventsOf(messages, practiceLink(["a", "b", "c"]));
		assert.deepEqual(
			events.map((e) => [e.skillId, e.outcome]),
			[
				["a", "solved"],
				["a", "movedOn"],
				["c", "movedOn"],
			],
		);
		assert.equal(events[0]!.at, T0 + 1, "the conclude's timestamp");
		assert.deepEqual(mastery.skillEventsOf(messages, practiceLink(["a"], "learn")), [], "an unfinished Learn session carries no evidence");
	});

	it("carries the tutor's per-skill grades, and ignores malformed entries", () => {
		const messages = [
			...problem(["a", "b"], "solvedWithHints", T0, {
				grades: [
					{ skill: "a", grade: "good" },
					{ skill: "b", grade: "again" },
					{ skill: "b", grade: "wild" }, // not a grade: ignored, the earlier entry stands
					{ grade: "easy" }, // no skill
				],
			}),
			...problem(["a"], "solved", T0 + 100), // no grades at all (an older chat)
		];
		const events = mastery.skillEventsOf(messages, practiceLink(["a", "b"]));
		assert.deepEqual(
			events.map((e) => [e.skillId, e.outcome, e.grade]),
			[
				["a", "solvedWithHints", "good"],
				["b", "solvedWithHints", "again"],
				["a", "solved", undefined],
			],
		);
	});

	it("a finished Learn session is evidence — the learner's marker or the teacher's clean finish_lesson, first one wins", () => {
		const learn = practiceLink(["a"], "learn");
		const marker = { ...session.newLessonFinishedMarker(), timestamp: T0 + 5 } as LhMessage;
		assert.deepEqual(mastery.skillEventsOf([marker], learn).map((e) => [e.skillId, e.outcome, e.at]), [["a", "finished", T0 + 5]]);
		const f = `f${++seq}`;
		const byTeacher = [assistant([{ id: f, name: session.FINISH_LESSON_TOOL, args: { summary: "s" } }], T0 + 2), result(f, session.FINISH_LESSON_TOOL, T0 + 2), marker];
		assert.deepEqual(session.sessionFinishOf(byTeacher), { at: T0 + 2, by: "agent" });
		assert.equal(mastery.skillEventsOf(byTeacher, learn).length, 1, "finished once");
		const refused = [assistant([{ id: f, name: session.FINISH_LESSON_TOOL, args: {} }], T0), result(f, session.FINISH_LESSON_TOOL, T0, true)];
		assert.equal(session.sessionFinishOf(refused), null, "a failed call never finished anything");
	});

	it("the placement test reads graded probe answers: confident → known, unsure → learned, wrong → miss", () => {
		const probe = (id: string, skill: string) => assistant([{ id, name: "probe", args: { skill, question: "Q" } }], T0);
		const answer = (id: string, at: number, a: Record<string, unknown>) =>
			({ ...result(id, "probe", at), details: { kind: "quiz", dontKnow: false, answers: [], answeredAt: "t", ...a } }) as LhMessage;
		const messages = [
			probe("q1", "c"),
			answer("q1", T0 + 1, { correct: true, confidence: 70 }),
			probe("q2", "b"),
			answer("q2", T0 + 2, { correct: true, confidence: 50 }),
			probe("q3", "a"),
			answer("q3", T0 + 3, { correct: false, confidence: 90 }),
			probe("q4", "a"),
			answer("q4", T0 + 4, { dontKnow: true }),
			probe("q5", "a"),
			answer("q5", T0 + 5, { dismissed: true }),
		];
		assert.deepEqual(
			mastery.skillEventsOf(messages, practiceLink(["a", "b", "c"], "placement")).map((e) => [e.skillId, e.outcome]),
			[
				["c", "placementKnown"],
				["b", "placementUnsure"],
				["a", "placementMiss"],
				["a", "placementMiss"],
			],
			"a dismissal is no answer",
		);
		assert.equal(mastery.placementGrade({ dontKnow: false, correct: true, confidence: session.PLACEMENT_KNOWN_CONFIDENCE }), "placementKnown");
		assert.equal(mastery.placementGrade({ dontKnow: false, correct: true }), "placementUnsure", "no confidence = not sure");
	});

	it("a dismissal ends the active problem without an outcome", () => {
		const p = `p${++seq}`;
		const messages = [
			assistant([{ id: p, name: "problem", args: { skills: ["a"] } }], T0),
			result(p, "problem", T0),
			{ id: "d", role: "custom", customType: "problem-dismissed", content: "", display: true, details: {}, timestamp: T0 + 1 } as unknown as LhMessage,
		];
		assert.deepEqual(mastery.skillEventsOf(messages, practiceLink(["a"])), []);
	});

	it("a first review sets the FSRS-6 initial stability by grade: again < hard < good < easy", () => {
		const first = (grade: string) => stabilityOf(ev("solved", T0, grade))!;
		assert.ok(first("hard") > 1.29 && first("hard") < 1.30, "w1");
		assert.ok(first("good") > 2.30 && first("good") < 2.31, "w2");
		assert.ok(first("easy") > 8.29 && first("easy") < 8.30, "w3");
		assert.equal(fold(ev("movedOn", T0, "again")).get("a"), undefined, "an again on a skill never learned stays unlearned");
		assert.ok(first("hard") < first("good") && first("good") < first("easy"));
	});

	it("without a tutor grade the outcome gives the default: solved good, hints hard, moved on / surrendered / taught again", () => {
		const first = (outcome: string) => stabilityOf(ev(outcome, T0));
		assert.equal(first("solved"), stabilityOf(ev("solved", T0, "good")));
		assert.equal(first("solvedWithHints"), stabilityOf(ev("solved", T0, "hard")));
		assert.equal(fold(ev("dismissed", T0)).get("a"), undefined, "dismissed is ignored");
		const learned = [ev("solved", T0, "good")];
		const after = (outcome: string) => stabilityOf(...learned, ev(outcome, T0 + 3 * DAY))!;
		assert.ok(after("movedOn") < stabilityOf(...learned)!, "a miss lowers stability");
		assert.equal(after("movedOn"), after("surrendered"));
		assert.equal(after("movedOn"), after("taught"));
		assert.ok(fold(...learned, ev("movedOn", T0 + 3 * DAY)).has("a"), "a miss on a learned skill keeps it learned");
	});

	it("the tutor's grade beats the outcome's default", () => {
		assert.equal(stabilityOf(ev("solvedWithHints", T0, "easy")), stabilityOf(ev("solved", T0, "easy")));
		assert.ok(stabilityOf(ev("solved", T0, "hard"))! < stabilityOf(ev("solved", T0))!);
	});

	it("spaced good reviews grow stability; a same-moment review adds nothing; order does not matter", () => {
		const one = stabilityOf(ev("solved", T0))!;
		const spaced = stabilityOf(ev("solved", T0), ev("solved", T0 + 3 * DAY))!;
		assert.ok(spaced > one, "a good review when recall had faded grows stability");
		assert.equal(stabilityOf(ev("solved", T0), ev("solved", T0))!, one, "no credit for drilling the same minute");
		assert.equal(stabilityOf(ev("solved", T0 + 3 * DAY), ev("solved", T0)), spaced, "events arrive in any order");
		const harder = stabilityOf(ev("solved", T0), ev("solved", T0 + 3 * DAY, "hard"))!;
		const easier = stabilityOf(ev("solved", T0), ev("solved", T0 + 3 * DAY, "easy"))!;
		assert.ok(harder < spaced && spaced < easier, "the grade shapes the growth");
	});

	it("understanding is 0–10 from stability on a log scale, and known from about a month of memory", () => {
		const at = (stability: number) => mastery.understandingOf({ stability, difficulty: 5, lastReview: T0 });
		assert.equal(at(1), 1.2);
		assert.equal(at(8), 3.7);
		assert.equal(at(30), 5.8);
		assert.equal(at(100), 7.8);
		assert.equal(at(365), 10);
		assert.equal(at(100000), 10, "capped");
		assert.equal(mastery.isKnown({ stability: 30, difficulty: 5, lastReview: T0 }), false);
		assert.equal(mastery.isKnown({ stability: 40, difficulty: 5, lastReview: T0 }), true);
		// it does not fall as days pass
		const state = { stability: 10, difficulty: 5, lastReview: T0 };
		assert.equal(mastery.understandingOf(state), mastery.understandingOf({ ...state, lastReview: T0 - 99 * DAY }));
	});

	it("the course percentage is the average known share: understanding over the known line, capped (owner, 2026-11-08)", () => {
		assert.equal(mastery.knownShare(0), 0);
		assert.equal(mastery.knownShare(3), 0.5);
		assert.equal(mastery.knownShare(6), 1, "known = fully counted");
		assert.equal(mastery.knownShare(9.5), 1, "depth above the line adds nothing to coverage");
		assert.equal(mastery.courseProgressPercent([]), 0);
		// a known skill, a skill at half the line, and one with no evidence: (1 + .5 + 0) / 3
		assert.equal(mastery.courseProgressPercent([6.3, 3, 0]), 50);
		// an inferred prerequisite (5.2) no longer falls off a cliff: 87%, not 0
		assert.equal(mastery.courseProgressPercent([5.2]), 87);
		assert.equal(mastery.courseProgressPercent([8, 10]), 100);
	});

	it("an understanding reads as how long the skill lasts", () => {
		assert.equal(mastery.lastsLabel(0.5), "about a day");
		assert.equal(mastery.lastsLabel(2), "about 2 days");
		assert.equal(mastery.lastsLabel(4), "about 10 days");
		assert.equal(mastery.lastsLabel(5.2), "about 3 weeks");
		assert.equal(mastery.lastsLabel(6.3), "about 6 weeks");
		assert.equal(mastery.lastsLabel(7.8), "about 3 months");
		assert.equal(mastery.lastsLabel(10), "about a year");
	});

	it("needs review once recall drops below 90%: one stability after the last review", () => {
		const state = { stability: 4, difficulty: 5, lastReview: T0 };
		assert.equal(mastery.retrievability(state, T0), 1);
		assert.equal(mastery.needsReview(state, T0 + 2 * DAY), false);
		assert.equal(mastery.needsReview(state, T0 + 5 * DAY), true);
		assert.equal(mastery.reviewAt(state), T0 + 4 * DAY);
		assert.ok(Math.abs(mastery.retrievability(state, mastery.reviewAt(state)) - 0.9) < 1e-6, "R(S) = 90%");
	});

	it("placement: a confident answer seeds the skill known and every transitive prerequisite lower (learning)", () => {
		const req: Record<string, string[]> = { c: ["b"], b: ["a"], a: [] };
		const states = mastery.foldSkills([{ skillId: "c", outcome: "placementKnown", at: T0, placement: false }], (id) => req[id] ?? []);
		assert.equal(states.get("c")!.stability, mastery.PLACEMENT_SEED_DAYS);
		assert.equal(mastery.isKnown(states.get("c")!), true, "known at once");
		assert.equal(states.get("b")!.stability, mastery.PREREQUISITE_SEED_DAYS, "inferred: weaker evidence");
		assert.equal(states.get("a")!.stability, mastery.PREREQUISITE_SEED_DAYS);
		assert.equal(mastery.isKnown(states.get("a")!), false, "learned, not known, until a real review");
		// the seed never lowers a skill that already lasts longer
		const strong = mastery.foldSkills(
			[
				{ skillId: "c", outcome: "finished", at: T0, placement: false },
				{ skillId: "c", outcome: "placementKnown", at: T0 + DAY, placement: false },
			],
			(id) => req[id] ?? [],
		);
		assert.ok(strong.get("c")!.stability >= mastery.PLACEMENT_SEED_DAYS);
	});

	it("placement: a direct miss blocks inferred credit, whichever came first", () => {
		const req: Record<string, string[]> = { c: ["b"], b: ["a"], a: [], y: ["x"], x: [] };
		const states = mastery.foldSkills(
			[
				{ skillId: "b", outcome: "placementMiss", at: T0, placement: false },
				{ skillId: "c", outcome: "placementKnown", at: T0 + 1, placement: false },
				{ skillId: "y", outcome: "placementKnown", at: T0, placement: false },
				{ skillId: "x", outcome: "placementMiss", at: T0 + 1, placement: false },
			],
			(id) => req[id] ?? [],
		);
		assert.ok(states.has("c"), "the skill answered directly is still known");
		assert.equal(states.has("b"), false, "missed before the credit: not credited");
		assert.ok(states.has("a"), "a prerequisite below the miss is still credited");
		assert.ok(states.has("y"));
		assert.equal(states.has("x"), false, "missed after the credit: not credited either");
	});

	it("finished lessons and unsure placement answers learn a skill (good / hard); a placement miss does nothing", () => {
		const states = mastery.foldSkills(
			[
				{ skillId: "d", outcome: "finished", at: T0, placement: false },
				{ skillId: "e", outcome: "placementUnsure", at: T0, placement: false },
				{ skillId: "f", outcome: "placementMiss", at: T0, placement: false },
			],
			none,
		);
		assert.equal(states.get("d")!.stability, stabilityOf(ev("solved", T0, "good")));
		assert.equal(states.get("e")!.stability, stabilityOf(ev("solved", T0, "hard")));
		assert.equal(states.get("d")!.lastReview, T0);
		assert.equal(states.has("f"), false);
	});

	it("legacy placement problems: a solve credits, with hints is hard, a miss is nothing", () => {
		const states = mastery.foldSkills(
			[
				{ skillId: "x", outcome: "solvedWithHints", at: T0, placement: true },
				{ skillId: "y", outcome: "surrendered", at: T0, placement: true },
				{ skillId: "z", outcome: "solved", at: T0, placement: true },
			],
			none,
		);
		assert.equal(states.get("x")!.stability, stabilityOf(ev("solved", T0, "hard")));
		assert.equal(states.has("y"), false);
		assert.equal(states.get("z")!.stability, mastery.PLACEMENT_SEED_DAYS, "a clean legacy solve credits like a confident answer");
	});

	describe("the review session's skills (pickReviewSkills)", () => {
		/** A partition whose review queue is the given skills: [id, stability, days since last review]. */
		const queue = (rows: Array<[string, number, number]>) => {
			const states = new Map(rows.map(([id, stability, ago]) => [id, { state: { stability, difficulty: 5, lastReview: T0 - ago * DAY }, learned: true, known: false, needsReview: true, missing: [] }]));
			return { review: rows.map(([id]) => id), states } as never;
		};

		it("takes everything when six or fewer need review, the strongest first (a warm open), then weakest to strongest", () => {
			const p = queue([["a", 1, 5], ["b", 20, 5], ["c", 3, 5]]);
			assert.deepEqual(mastery.pickReviewSkills(p), ["b", "a", "c"], "b is the strongest; a (S=1) is weaker than c (S=3)");
			assert.deepEqual(mastery.pickReviewSkills(queue([])), []);
		});

		it("with more than six: the four weakest, the stalest of the rest, and one morale skill", () => {
			// stability 1..8 = understanding rising with the number; "s" is old but strong-ish
			const p = queue([
				["w1", 1, 2], ["w2", 1.5, 2], ["w3", 2, 2], ["w4", 2.5, 2], // the weakest four
				["old", 6, 90], // stale: not practiced for the longest
				["mid", 5, 2],
				["top", 30, 2], // the strongest: morale
				["x", 4, 2],
			]);
			const picked = mastery.pickReviewSkills(p);
			assert.equal(picked.length, mastery.REVIEW_SESSION_SIZE);
			assert.equal(picked[0], "top", "morale first");
			assert.deepEqual([...picked].sort(), ["old", "top", "w1", "w2", "w3", "w4"].sort());
			assert.deepEqual(picked.slice(1), ["w1", "w2", "w3", "w4", "old"], "then weakest to strongest");
			assert.equal(new Set(picked).size, picked.length, "no skill twice");
		});

		it("the unpicked skills stay in the queue for the next session", () => {
			const rows: Array<[string, number, number]> = Array.from({ length: 9 }, (_, i) => [`k${i}`, 1 + i, 2] as [string, number, number]);
			const first = mastery.pickReviewSkills(queue(rows));
			assert.equal(first.length, 6);
			const rest = rows.filter(([id]) => !first.includes(id));
			assert.equal(rest.length, 3);
			assert.deepEqual([...mastery.pickReviewSkills(queue(rest))].sort(), rest.map(([id]) => id).sort());
		});
	});

	it("partitions a course: review, next up, learning, locked (with what is missing), known — learned unlocks", () => {
		const skills = new Map<string, Skill>(
			mergeSkillLines([line("a"), line("b", ["a"]), line("c", ["b"]), line("d"), line("e", ["d"]), line("f", ["e"])]).map((s) => [s.id, s]),
		);
		const states = new Map([
			["a", { stability: 40, difficulty: 5, lastReview: T0 }],
			["d", { stability: 2, difficulty: 5, lastReview: T0 }],
		]);
		const p = mastery.partitionSkills(["c", "b", "a", "d", "e", "f", "ghost"], skills, states, T0 + 3 * DAY);
		assert.ok(p.order.indexOf("a") < p.order.indexOf("b") && p.order.indexOf("b") < p.order.indexOf("c"), "prerequisites first");
		assert.deepEqual(p.known, ["a"]);
		assert.deepEqual(p.learning, ["d"], "learned, not known");
		assert.deepEqual(p.nextUp.sort(), ["b", "e"], "e unlocks: its prerequisite d is learned, not known");
		assert.deepEqual(p.locked.sort(), ["c", "f"]);
		assert.deepEqual(p.states.get("c")!.missing, ["b"]);
		assert.equal(p.states.get("d")!.learned, true);
		assert.deepEqual(p.review, ["d"], "learned and recall below 90% (a is known and still fresh)");
	});
});

// ─── drafts ──────────────────────────────────────────────────────────────────

describe("drafts (core/course-draft.ts)", () => {
	const existing = new Map<string, Skill>([["sk_old", { ...line("sk_old", [], ["n1"]), name: "Old" }]]);
	const ctx = { skills: existing, nodeIds: new Set(["n1", "n2"]) };
	const ds = (key: string, over: Partial<CourseDraft["skills"][number]> = {}) => ({
		key,
		name: key.toUpperCase(),
		statement: `Do ${key}`,
		requires: [] as string[],
		restsOn: [] as string[],
		...over,
	});

	it("accepts a valid draft and names every problem otherwise", () => {
		assert.deepEqual(draftProblems([ds("s1"), ds("s2", { requires: ["s1"], restsOn: ["n2"] }), ds("s3", { reuse: "sk_old" })], ctx), []);
		assert.deepEqual(draftProblems([], ctx), ["the draft has no skills"]);
		const problems = draftProblems(
			[
				ds("s1", { requires: ["s1", "nope"], restsOn: ["ghost"], reuse: "sk_missing" }),
				ds("s1", { name: " " }),
				ds("s2", { reuse: "sk_old" }),
				ds("s3", { reuse: "sk_old" }),
			],
			ctx,
		);
		const text = problems.join("\n");
		for (const re of [/duplicate key "s1"/, /empty name/, /not an existing skill id/, /both reuse sk_old/, /not an existing proposition id/, /requires itself/, /"nope" is not a key/]) {
			assert.match(text, re);
		}
		assert.match(draftProblems([ds("s1", { requires: ["s2"] }), ds("s2", { requires: ["s1"] })], ctx).join(), /cycle/);
	});

	it("checks that every material is cited", () => {
		assert.deepEqual(uncitedMaterials([ds("s1", { cite: "Calculus.pdf, p. 3" })], [{ id: "mat_1", name: "Calculus.pdf" }, { id: "mat_2", name: "Notes.md" }]), ["Notes.md"]);
	});

	it("approval mints new skills, link-appends only new edges to reused ones, and pulls in their prerequisites", () => {
		const skills = new Map<string, Skill>([
			["sk_base", line("sk_base")],
			["sk_old", line("sk_old", ["sk_base"], ["n1"])],
		]);
		let n = 0;
		const draft: CourseDraft = {
			createdAt: "t",
			summary: "s",
			skills: [ds("s1", { reuse: "sk_old", name: "sk_old", statement: "Do sk_old", restsOn: ["n1", "n2"] }), ds("s2", { requires: ["s1"] })],
		};
		const out = approveDraft(draft, { skills, nodeIds: new Set(["n1", "n2"]) }, () => `sk_new${++n}`, "2026-10-24T00:00:00Z");
		assert.deepEqual(
			out.lines.map((l) => [l.id, l.requires, l.restsOn]),
			[
				["sk_old", [], ["n2"]],
				["sk_new1", ["sk_old"], []],
			],
		);
		assert.equal(out.lines[0]!.name, "sk_old", "a reused skill keeps its own name");
		assert.deepEqual(out.skillIds.sort(), ["sk_base", "sk_new1", "sk_old"], "the reused skill's prerequisite joins the course");
		const again = approveDraft({ ...draft, skills: [ds("s1", { reuse: "sk_old", name: "sk_old", statement: "Do sk_old", restsOn: ["n1"] })] }, { skills, nodeIds: new Set(["n1"]) }, () => "x", "t");
		assert.deepEqual(again.lines, [], "nothing new → nothing written");
	});

	it("a reused skill the planner re-worded gets a reworded line, and the latest wording wins at read", () => {
		const skills = new Map<string, Skill>([["sk_old", line("sk_old", [], ["n1"])]]);
		const draft: CourseDraft = {
			createdAt: "t",
			summary: "s",
			skills: [ds("s1", { reuse: "sk_old", name: "Gammel", statement: "Gjør gammel", restsOn: ["n1"] })],
		};
		const out = approveDraft(draft, { skills, nodeIds: new Set(["n1"]) }, () => "x", "t");
		assert.equal(out.lines.length, 1, "a re-wording alone is worth a line");
		assert.deepEqual([out.lines[0]!.name, out.lines[0]!.statement, out.lines[0]!.reworded], ["Gammel", "Gjør gammel", true]);
		const merged = mergeSkillLines([line("sk_old", [], ["n1"]), ...out.lines]);
		assert.deepEqual([merged[0]!.name, merged[0]!.statement], ["Gammel", "Gjør gammel"]);
	});
});

// ─── course sessions (pure) ──────────────────────────────────────────────────

describe("course sessions (core/course-session.ts)", () => {
	const sk = (id: string, understanding = 0) => ({ id, name: id.toUpperCase(), statement: `Do ${id}`, understanding, learned: understanding > 0, known: understanding >= 6, needsReview: false });

	it("the context marker carries skills, prerequisites, propositions and chains — as a graph-context marker", () => {
		const m = session.newCourseContextMessage({
			courseTitle: "Calc",
			mode: "learn",
			skills: [sk("sk_b", 2)],
			background: [sk("sk_a", 8)],
			propositions: [{ id: "n1", name: "Chain rule", statement: "(f∘g)' = f'(g)·g'" }],
			chains: ["A → B"],
		});
		assert.equal(m.customType, "graph-context");
		assert.match(m.content, /course "Calc" \(Learn\)/);
		assert.match(m.content, /\[sk_b\] SK_B: Do sk_b · learned, not yet known \(understanding 2 of 10\)/);
		assert.match(m.content, /prerequisite skills[\s\S]*\[sk_a\] SK_A: Do sk_a · known \(understanding 8 of 10\)/);
		assert.match(m.content, /\[n1\] Chain rule/);
		assert.match(m.content, /- A → B/);
		const details = m.details as { course: { title: string; mode: string; skills: unknown[] }; propositions: unknown[] };
		assert.equal(details.course.mode, "learn");
		assert.equal(details.course.skills.length, 1);
		assert.equal(details.propositions.length, 1);
	});

	it("titles and first messages per mode", () => {
		assert.equal(session.courseSessionTitle("learn", "Calc", [{ name: "Chain rule" }]), "Learn: Chain rule");
		assert.equal(session.courseSessionTitle("practice", "Calc", [{ name: "A" }, { name: "B" }]), "Practice: A, B");
		assert.equal(session.courseSessionTitle("review", "Calc", []), "Review: Calc");
		assert.equal(session.courseSessionTitle("placement", "Calc", []), "Placement: Calc");
		assert.equal(session.courseFirstMessage("learn", "Calc", [{ name: "A", statement: "Do a" }]), "I want to learn to: Do a");
		assert.equal(session.courseFirstMessage("placement", "Calc", []), "Placement test for Calc");
		assert.equal(session.courseFirstMessage("learn", "Calc", [{ name: "A", statement: "Gjør a" }], "nb"), "Jeg vil lære å: Gjør a");
		assert.equal(session.courseFirstMessage("practice", "Calc", [{ name: "A", statement: "x" }, { name: "B", statement: "y" }], "nb"), "Øv på: A, B");
		assert.equal(session.courseFirstMessage("review", "Calc", [], "nb"), "Repeter ferdighetene mine som skal repeteres nå");
		assert.equal(session.courseFirstMessage("placement", "Calc", [], "nb"), "Nivåtest for Calc");
		assert.match(session.courseFirstMessage("check", "Calc", [{ name: "A", statement: "Gjør a" }], "nb"), /^Jeg kan dette fra et annet kurs\. Sjekk at jeg kan bruke det i Calc: Gjør a$/);
	});

	it("the prompt section: Learn targets one skill and finishes; practice modes carry the tagging law; the placement test grades", () => {
		const learn = session.coursePromptSection("learn", "Calc", [sk("sk_a")]);
		assert.match(learn, /^<course>\n/);
		assert.match(learn, /ONE skill/);
		assert.match(learn, /SK_A: Do sk_a/);
		assert.match(learn, /call `finish_lesson`/);
		assert.doesNotMatch(learn, /`skills` field/);
		for (const mode of ["practice", "review"] as const) {
			assert.match(session.coursePromptSection(mode, "Calc", [sk("sk_a")]), /`skills` field MUST name them/);
		}
		const placement = session.coursePromptSection("placement", "Calc", Array.from({ length: 32 }, (_, i) => sk(`sk_${i}`)));
		assert.match(placement, /PLACEMENT TEST[\s\S]*`probe`[\s\S]*set `skill`[\s\S]*Hardest technical skills first[\s\S]*Judgment skills last/);
		assert.match(placement, /about 11 questions/, "a third of the skills, rounded");
		assert.match(placement, /never ask about a credited skill again/);
		assert.match(placement, /confidence ≥ 70 → known[\s\S]*a direct miss always wins/);
		assert.doesNotMatch(placement, /Roughly one question per skill/);
		// the soft target is a checkpoint, not a stop (owner, 2026-10-25)
		assert.match(placement, /At about 11 questions with skills still neither tested nor credited, ask ONCE with `ask_user_question`/);
		assert.match(placement, /Continue → keep testing until every skill is tested or credited/);
		assert.match(placement, /untested skills plainly as not tested/);
		assert.doesNotMatch(placement, /`skills` field/, "no problem tagging law in a quiz test");
		const review = session.coursePromptSection("review", "Calc", []);
		assert.match(review, /REVIEW session/);
		assert.match(review, /do not add skills or extra problems/);
		assert.match(review, /at most one retest after a taught problem/);
	});
});

// ─── stores ──────────────────────────────────────────────────────────────────

describe("the stores", () => {
	it("skills.jsonl appends in order and skips corrupt lines", () => {
		skillStore.appendSkillLines([line("sk_s1"), line("sk_s2", ["sk_s1"])]);
		fs.appendFileSync(LEDGER_FILES.skills, "{torn\n");
		skillStore.appendSkillLines([]);
		const read = skillStore.readSkillLines().filter((l) => l.id.startsWith("sk_s"));
		assert.deepEqual(read.map((l) => l.id), ["sk_s1", "sk_s2"]);
		fs.writeFileSync(LEDGER_FILES.skills, ""); // leave the ledger empty for the service tests
	});

	it("course records: create, update (undefined clears), list newest first, delete — each announced", () => {
		let announced = 0;
		const off = subscribe((e) => {
			if (e.type === "courses-changed") announced++;
		});
		const a = courseStore.createCourse("  ");
		assert.equal(a.title, "Untitled course");
		assert.equal(a.status, "new");
		assert.match(a.id, /^course_/);
		const updated = courseStore.updateCourse(a.id, { error: "boom", status: "error" })!;
		assert.equal(updated.error, "boom");
		const cleared = courseStore.updateCourse(a.id, { error: undefined })!;
		assert.equal("error" in cleared, false);
		assert.equal(courseStore.getCourse(a.id)!.version, 1);
		assert.ok(courseStore.listCourses().some((c) => c.id === a.id));
		assert.equal(courseStore.deleteCourse(a.id), true);
		assert.equal(courseStore.deleteCourse(a.id), false);
		assert.equal(courseStore.getCourse(a.id), null);
		off();
		assert.equal(announced, 4);
	});

	it("a newer-stamped course record is refused", () => {
		fs.mkdirSync(PATHS.courses, { recursive: true });
		fs.writeFileSync(path.join(PATHS.courses, "course_future.json"), JSON.stringify({ id: "course_future", version: 99 }));
		assert.equal(courseStore.getCourse("course_future"), null);
		fs.rmSync(path.join(PATHS.courses, "course_future.json"));
	});

	it("a chat is born with its course link, and the summary carries it", () => {
		const chat = chatStore.createChat("x", "practice", practiceLink(["a"]));
		assert.deepEqual(chatStore.getChat(chat.id)!.course, practiceLink(["a"]));
		assert.deepEqual(chatStore.listChats().find((c) => c.id === chat.id)!.course, practiceLink(["a"]));
		chatStore.deleteChat(chat.id);
	});
});

// ─── the service seam ────────────────────────────────────────────────────────

function node(id: string, name: string, chatId = "src_notes"): GraphNode {
	return { id, name, statement: `${name} holds`, aliases: [], createdAt: "2026-10-01T00:00:00Z", provenance: [{ chatId, messageId: "" }] };
}

describe("the course service (src/server/courses.ts)", () => {
	beforeEach(() => {
		for (const c of courseStore.listCourses()) courseStore.deleteCourse(c.id);
		for (const c of chatStore.listChats()) chatStore.deleteChat(c.id);
		fs.rmSync(LEDGER_FILES.skills, { force: true });
		fs.rmSync(LEDGER_FILES.nodes, { force: true });
	});

	/** An approved course a → b → c (b rests on n1). */
	function approvedCourse() {
		graphStore.appendNode(node("n1", "Power rule"));
		const course = courseStore.createCourse("Calc");
		courseStore.updateCourse(course.id, {
			status: "draft",
			draft: {
				createdAt: "t",
				summary: "s",
				skills: [
					{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [] },
					{ key: "s2", name: "B", statement: "Do b", requires: ["s1"], restsOn: ["n1"] },
					{ key: "s3", name: "C", statement: "Do c", requires: ["s2"], restsOn: [] },
				],
			},
		});
		const approved = courses.approveCourse(course.id);
		assert.ok(approved.ok);
		const ids = approved.value.skills;
		const byName = Object.fromEntries(mergeSkillLines(skillStore.readSkillLines()).map((s) => [s.name, s.id]));
		return { courseId: course.id, ids, a: byName.A!, b: byName.B!, c: byName.C! };
	}

	it("approval writes the ledger, clears the draft and activates the course", () => {
		const { courseId, ids, a, b } = approvedCourse();
		assert.equal(ids.length, 3);
		const record = courseStore.getCourse(courseId)!;
		assert.equal(record.status, "active");
		assert.equal(record.draft, undefined);
		const skills = mergeSkillLines(skillStore.readSkillLines());
		assert.deepEqual(skills.find((s) => s.id === b)!.requires, [a]);
		assert.deepEqual(skills.find((s) => s.id === b)!.restsOn, ["n1"]);
		assert.equal(courses.approveCourse(courseId).ok, false, "no draft left to approve");
	});

	it("approval refuses a draft that no longer fits the graph", () => {
		const course = courseStore.createCourse("X");
		courseStore.updateCourse(course.id, {
			draft: { createdAt: "t", summary: "s", skills: [{ key: "s1", name: "A", statement: "a", requires: [], restsOn: ["n_gone"] }] },
		});
		const out = courses.approveCourse(course.id);
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.status, 422);
	});

	it("the view: a fresh course has a as next up and b, c locked", () => {
		const { courseId, a, b, c } = approvedCourse();
		const view = courses.courseView(courseId)!;
		assert.deepEqual(view.skills.map((s) => s.id), [a, b, c]);
		assert.deepEqual(view.nextUp, [a]);
		assert.deepEqual(view.locked, [b, c]);
		assert.deepEqual(view.skills.find((s) => s.id === b)!.missing, [a]);
		assert.deepEqual(view.skills.find((s) => s.id === b)!.propositions.map((p) => p.id), ["n1"]);
		assert.deepEqual(courses.listCourseSummaries().map((s) => [s.title, s.known, s.total]), [["Calc", 0, 3]]);
	});

	it("sessions: refusals per mode, then a Learn session born with link, marker and stamp", () => {
		const { courseId, a, b } = approvedCourse();
		assert.equal(courses.createCourseSession(courseId, "learn").ok, false, "Learn needs a skill");
		const review = courses.createCourseSession(courseId, "review");
		assert.ok(!review.ok && review.status === 409, "nothing is due");
		assert.equal(courses.createCourseSession(courseId, "learn", "sk_elsewhere").ok, false);
		const learn = courses.createCourseSession(courseId, "learn", b);
		assert.ok(learn.ok);
		assert.equal(learn.value.title, "Learn: B");
		assert.equal(learn.value.prompt, "I want to learn to: Do b");
		const record = chatStore.getChat(learn.value.id)!;
		assert.equal(record.kind, undefined, "Learn is a teach session");
		assert.deepEqual(record.course, { courseId, mode: "learn", skillIds: [b] });
		assert.equal(record.messages.length, 1);
		const marker = record.messages[0] as unknown as { customType: string; content: string };
		assert.equal(marker.customType, "graph-context");
		assert.match(marker.content, new RegExp(`\\[${a}\\] A: Do a`), "the prerequisite rides as background");
		assert.match(marker.content, /\[n1\] Power rule/);
		assert.ok(record.settings?.language, "the birth stamp ran");
	});

	it("the placement test: a conversation session whose confident answers credit prerequisites; the route follows", () => {
		const { courseId, a, b, c } = approvedCourse();
		const placement = courses.createCourseSession(courseId, "placement");
		assert.ok(placement.ok);
		assert.equal(placement.value.prompt, "Placement test for Calc");
		const record = chatStore.getChat(placement.value.id)!;
		assert.equal(record.kind, undefined, "the placement tester is a conversation agent, not practice");
		assert.deepEqual(record.course!.skillIds, [a, b, c]);
		assert.deepEqual(courses.courseForTurn(placement.value.id)!.skills!().map((s) => s.id), [a, b, c], "the probe may tag every course skill");
		// a confident correct answer on B → B is known, its prerequisite A learned
		const at = Date.now() - 1000;
		chatStore.saveMessages(placement.value.id, [
			...record.messages,
			assistant([{ id: "pq1", name: "probe", args: { skill: b, question: "Q" } }], at),
			{ ...result("pq1", "probe", at), details: { kind: "quiz", dontKnow: false, answers: [], answeredAt: "t", correct: true, confidence: 90 } } as LhMessage,
		]);
		const view = courses.courseView(courseId)!;
		assert.deepEqual(view.known, [b]);
		assert.deepEqual(view.learning, [a], "inferred through B: learned, not known until a real review");
		assert.deepEqual(view.nextUp, [c]);
		assert.deepEqual(view.locked, []);
		// progress counts the inferred prerequisite (a: 5.2 of 6) instead of dropping it: (1 + .87 + 0) / 3
		assert.equal(courses.listCourseSummaries().find((x) => x.id === courseId)!.progress, 62);
		const practice = courses.createCourseSession(courseId, "practice");
		assert.ok(practice.ok, "practice all = the learning group");
		assert.deepEqual(chatStore.getChat(practice.value.id)!.course!.skillIds, [a]);
	});

	it("finishing a Learn session makes its skill learned and unlocks what builds on it; practice all = learning", () => {
		const { courseId, a, b } = approvedCourse();
		const learn = courses.createCourseSession(courseId, "learn", a);
		assert.ok(learn.ok);
		const record = chatStore.getChat(learn.value.id)!;
		// the learner's Finish lesson, through the input-event seam
		const appends = inputAppends(record, { type: "finish" });
		assert.equal((appends[0] as { customType?: string }).customType, "lesson-finished");
		chatStore.saveMessages(learn.value.id, [...record.messages, ...appends]);
		const view = courses.courseView(courseId)!;
		assert.deepEqual(view.learning, [a]);
		assert.equal(view.skills.find((s) => s.id === a)!.learned, true);
		assert.deepEqual(view.nextUp, [b], "b unlocks on a learned prerequisite");
		assert.equal(view.sessions.find((s) => s.id === learn.value.id)!.finished, true);
		assert.throws(() => inputAppends(chatStore.getChat(learn.value.id)!, { type: "finish" }), /already finished/);
		const practice = courses.createCourseSession(courseId, "practice");
		assert.ok(practice.ok);
		assert.deepEqual(chatStore.getChat(practice.value.id)!.course!.skillIds, [a], "practice all = learning");
	});

	it("a skill had from another course: offered a context check (never forced), skipped by placement, cleared by one problem here", () => {
		const { courseId, a } = approvedCourse();
		const learn = courses.createCourseSession(courseId, "learn", a);
		assert.ok(learn.ok);
		const lesson = chatStore.getChat(learn.value.id)!;
		chatStore.saveMessages(learn.value.id, [...lesson.messages, ...inputAppends(lesson, { type: "finish" })]);
		// a second course reuses A and builds D on it
		const second = courseStore.createCourse("Physics");
		courseStore.updateCourse(second.id, {
			status: "draft",
			draft: {
				createdAt: "t",
				summary: "s",
				skills: [
					{ key: "s1", reuse: a, name: "A", statement: "Do a", requires: [], restsOn: [] },
					{ key: "s2", name: "D", statement: "Do d", requires: ["s1"], restsOn: [] },
				],
			},
		});
		assert.ok(courses.approveCourse(second.id).ok);
		const d = mergeSkillLines(skillStore.readSkillLines()).find((s) => s.name === "D")!.id;

		const view = courses.courseView(second.id)!;
		assert.deepEqual(view.contextCheck, [a]);
		assert.deepEqual(view.learning, [a], "still learned — the count and the unlock read it");
		assert.deepEqual(view.nextUp, [d], "nothing is locked behind the check");
		assert.deepEqual(courses.courseView(courseId)!.contextCheck, [], "the course it was learned in owes no check");

		const placement = courses.createCourseSession(second.id, "placement");
		assert.ok(placement.ok);
		assert.deepEqual(chatStore.getChat(placement.value.id)!.course!.skillIds, [d], "placement spends no question on A");
		chatStore.deleteChat(placement.value.id);

		assert.equal(courses.createCourseSession(second.id, "check").ok, false, "a check needs a skill");
		const unlearned = courses.createCourseSession(second.id, "check", d);
		assert.ok(!unlearned.ok && unlearned.status === 409, "only for skills the learner has");
		const check = courses.createCourseSession(second.id, "check", a);
		assert.ok(check.ok);
		assert.equal(check.value.title, "Context check: A");
		assert.match(check.value.prompt, /already know this from another course[\s\S]*Physics: Do a/);
		const record = chatStore.getChat(check.value.id)!;
		assert.equal(record.kind, "practice", "a short practice session");
		assert.match(courses.courseForTurn(check.value.id)!.section, /CONTEXT CHECK[\s\S]*one problem \(two at most\)[\s\S]*Never re-teach/);

		// one concluded problem in THIS course clears the offer
		const at = Date.now() - 1000;
		chatStore.saveMessages(check.value.id, [
			...record.messages,
			assistant([{ id: "p1", name: "problem", args: { skills: [a], statement: "S", modelSolution: "M" } }], at),
			result("p1", "problem", at),
			assistant([{ id: "c1", name: "conclude", args: { outcome: "solved" } }], at + 1),
			result("c1", "conclude", at + 1),
		]);
		assert.deepEqual(courses.courseView(second.id)!.contextCheck, []);

		// the knowledge graph's skills layer: only what is held (A, learned —
		// never D, untouched), both its courses, one region for it
		const layer = courses.graphSkillLayer()!;
		assert.deepEqual(layer.nodes.map((s) => [s.name, s.known, s.understanding, s.courses.map((c) => c.title).sort()]), [["A", false, 2, ["Calc", "Physics"]]]);
		assert.equal(layer.regions.length, 1, "a skill sits in one course's region");
		assert.deepEqual(layer.regions[0]!.members, [a]);
	});

	it("the graph's skills layer: held skills, prerequisite arrows among them, rests-on arrows from live propositions", () => {
		const { courseId, a, b } = approvedCourse();
		assert.equal(courses.graphSkillLayer(), undefined, "nothing held → no layer");
		// a confident placement answer on B credits B (known) and A (learned)
		const placement = courses.createCourseSession(courseId, "placement");
		assert.ok(placement.ok);
		const record = chatStore.getChat(placement.value.id)!;
		const at = Date.now() - 1000;
		chatStore.saveMessages(placement.value.id, [
			...record.messages,
			assistant([{ id: "pq", name: "probe", args: { skill: b, question: "Q" } }], at),
			{ ...result("pq", "probe", at), details: { kind: "quiz", dontKnow: false, answers: [], answeredAt: "t", correct: true, confidence: 90 } } as LhMessage,
		]);
		const layer = courses.graphSkillLayer()!;
		assert.deepEqual(layer.nodes.map((s) => s.id).sort(), [a, b].sort());
		assert.deepEqual(layer.nodes.map((s) => [s.id, s.known]).sort(), [[a, false], [b, true]].sort(), "B known, its inferred prerequisite A learning");
		assert.deepEqual(
			layer.edges.map((e) => `${e.from}->${e.to}`).sort(),
			[`${a}->${b}`, `n1->${b}`].sort(),
			"A → B (prerequisite) and the proposition B rests on → B",
		);
		assert.deepEqual(layer.nodes.find((s) => s.id === b)!.propositions, ["n1"]);
		assert.deepEqual(layer.regions, [{ id: courseId, label: "Calc", members: layer.nodes.map((s) => s.id) }]);
	});

	it("finish is a course-session affordance — any mode, once, never over an open question or a live problem", () => {
		const { courseId, a } = approvedCourse();
		const plain = chatStore.createChat("plain");
		assert.throws(() => inputAppends(chatStore.getChat(plain.id)!, { type: "finish" }), /course-session affordance/);
		const practice = courses.createCourseSession(courseId, "practice", a);
		assert.ok(practice.ok);
		const record = chatStore.getChat(practice.value.id)!;
		const at = Date.now() - 1000;
		const live = [...record.messages, assistant([{ id: "lp", name: "problem", args: { skills: [a], statement: "S", modelSolution: "M" } }], at), result("lp", "problem", at)];
		assert.throws(() => inputAppends({ ...record, messages: live }, { type: "finish" }), /no active problem/);
		const appends = inputAppends(record, { type: "finish" });
		assert.match((appends.at(-1) as { content: string }).content, /SESSION FINISHED[\s\S]*pose nothing more/, "a practice session gets the session wording, not the lesson's");
		chatStore.saveMessages(practice.value.id, [...record.messages, ...appends]);
		assert.throws(() => inputAppends(chatStore.getChat(practice.value.id)!, { type: "finish" }), /already finished/);
		assert.equal(courses.courseView(courseId)!.sessions.find((s) => s.id === practice.value.id)!.finished, true);
		assert.equal(chatStore.listChats().find((c) => c.id === practice.value.id)!.finished, true, "the sidebar row knows");
		assert.equal(chatStore.listChats().find((c) => c.id === plain.id)!.finished, undefined);
		assert.equal(courses.courseView(courseId)!.learning.length, 0, "finishing a practice session credits no skill");
		const learn = courses.createCourseSession(courseId, "learn", a);
		assert.ok(learn.ok);
		const open = [...chatStore.getChat(learn.value.id)!.messages, assistant([{ id: "oq", name: "quiz", args: { type: "check", lead: "Next.", nodeId: "n", question: "Which is even?", options: [{ label: "2", value: "a" }, { label: "3", value: "b" }], correctAnswer: "a", explanation: "E" } }], Date.now())];
		assert.throws(() => inputAppends({ messages: open, course: { mode: "learn" } }, { type: "finish" }), /no open question/);
		// Upstream v0.4.1: a malformed (unvalidated) quiz is not an open question. Finish
		// goes through, and the model-bound history still pairs the dangling call.
		const malformed = [...chatStore.getChat(learn.value.id)!.messages, assistant([{ id: "mq", name: "quiz", args: {} }], Date.now())];
		const closing = inputAppends({ messages: malformed, course: { mode: "learn" } }, { type: "finish" });
		const wire = toLlmMessages([...malformed, ...closing]);
		assert.ok(wire.some((m) => m.role === "toolResult" && m.toolCallId === "mq"), "the malformed call gets a result before the finish marker");
	});

	it("propositions extracted from a Learn session rest on its skill (derived)", () => {
		const { courseId, c } = approvedCourse();
		const learn = courses.createCourseSession(courseId, "learn", c);
		assert.ok(learn.ok);
		graphStore.appendNode(node("n2", "Quotient rule", learn.value.id));
		const view = courses.courseView(courseId)!;
		const props = view.skills.find((s) => s.id === c)!.propositions;
		assert.deepEqual(props.map((p) => p.id), ["n2"]);
		assert.deepEqual(props[0]!.sessions, [{ id: learn.value.id, title: "Learn: C" }]);
	});

	it("each turn: Learn gets the section and its mode; practice modes get the taggable skills", () => {
		const { courseId, a } = approvedCourse();
		const learn = courses.createCourseSession(courseId, "learn", a);
		const practice = courses.createCourseSession(courseId, "practice", a);
		assert.ok(learn.ok && practice.ok);
		const l = courses.courseForTurn(learn.value.id)!;
		assert.match(l.section, /ONE skill/);
		assert.equal(l.mode, "learn");
		assert.equal(l.skills, undefined);
		const p = courses.courseForTurn(practice.value.id)!;
		assert.deepEqual(p.skills!(), [{ id: a, name: "A" }]);
		const plain = chatStore.createChat("plain");
		assert.equal(courses.courseForTurn(plain.id), undefined);
	});

	it("drafting refuses without curriculum, and a change request needs a draft", () => {
		const course = courseStore.createCourse("Empty");
		const none = courses.startCourseDraft(course.id);
		assert.ok(!none.ok && none.status === 400);
		materialStore.add(course.id, { kind: "text", name: "c.md", ext: ".md", bytes: new TextEncoder().encode("# C") });
		materialStore.update(course.id, materialStore.list(course.id)[0]!.id, { status: "ready", profile: "P" });
		const feedback = courses.startCourseDraft(course.id, "split it");
		assert.ok(!feedback.ok && feedback.status === 400);
		assert.ok(!courses.startCourseDraft("course_nope").ok);
	});

	it("a new course is stamped with the default language, a pick sticks, and its sessions are taught in it", () => {
		const made = courses.createCourse("Stamped");
		assert.equal(courseStore.getCourse(made.id)!.language, "en", "the factory default");
		assert.equal(courses.setCourseLanguage(made.id, "nb")!.language, "nb");
		assert.equal(courses.setCourseLanguage("course_nope", "nb"), null);
		const { courseId, a } = approvedCourse();
		courses.setCourseLanguage(courseId, "nb");
		const learn = courses.createCourseSession(courseId, "learn", a);
		assert.ok(learn.ok);
		assert.equal(chatStore.getChat(learn.value.id)!.settings?.language, "nb");
	});

	it("a course left 'drafting' by a dead run settles instead of spinning forever", () => {
		const orphan = courseStore.createCourse("Orphan");
		courseStore.updateCourse(orphan.id, { status: "drafting" });
		assert.equal(courses.listCourseSummaries().find((s) => s.id === orphan.id)!.status, "error");
		const healed = courses.courseView(orphan.id)!.course;
		assert.equal(healed.status, "error");
		assert.match(healed.error ?? "", /interrupted/);
		const withSkills = approvedCourse().courseId;
		courseStore.updateCourse(withSkills, { status: "drafting" });
		assert.equal(courses.courseView(withSkills)!.course.status, "active");
	});

	it("a course session sees its course's material beside its own", () => {
		const { courseId, a } = approvedCourse();
		const cm = materialStore.add(courseId, { kind: "text", name: "curriculum.md", ext: ".md", bytes: new TextEncoder().encode("# Curriculum") });
		const learn = courses.createCourseSession(courseId, "learn", a);
		assert.ok(learn.ok);
		const lm = materialStore.add(learn.value.id, { kind: "text", name: "mine.md", ext: ".md", bytes: new TextEncoder().encode("# Mine") });
		const store = sessionMaterials(learn.value.id);
		assert.deepEqual(store.list(learn.value.id).map((m) => m.name).sort(), ["curriculum.md", "mine.md"]);
		assert.equal(fs.readFileSync(store.filePath(learn.value.id, cm), "utf8"), "# Curriculum");
		assert.equal(fs.readFileSync(store.filePath(learn.value.id, lm), "utf8"), "# Mine");
	});

	it("deleting a course keeps its skills and sessions", () => {
		const { courseId, a } = approvedCourse();
		const learn = courses.createCourseSession(courseId, "learn", a);
		assert.ok(learn.ok);
		assert.equal(courses.deleteCourse(courseId), true);
		assert.equal(courseStore.getCourse(courseId), null);
		assert.equal(mergeSkillLines(skillStore.readSkillLines()).length, 3);
		assert.ok(chatStore.getChat(learn.value.id));
	});
});

// ─── the course tools (finish_lesson, the placement probe) ───────────────────

describe("the course tools", () => {
	const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("");
	const skills = () => [{ id: "sk_a", name: "Chain rule" }];
	const quiz = {
		question: "Q?",
		explanation: "Because.",
		options: [
			{ label: "Yes", value: "y" },
			{ label: "No", value: "n" },
		],
		correctAnswer: "y",
	};

	it("the placement probe leads with `skill`, refuses an unknown one, and poses a valid one", async () => {
		const tool = placementProbeTool(skills);
		assert.equal(tool.name, "probe", "the dock renders it unchanged");
		assert.equal(Object.keys((tool.parameters as { properties: object }).properties)[0], "skill");
		const bad = await tool.execute("t1", { ...quiz, skill: "Chain rule" } as never);
		assert.equal((bad as { isError?: boolean }).isError, true);
		assert.match(text(bad), /not one of this course's skill ids[\s\S]*sk_a/);
		const good = await tool.execute("t2", { ...quiz, skill: "sk_a" } as never);
		assert.doesNotMatch(text(good), /not one of/);
	});

	it("the placement tester: its own prompt (craft + voice, no teaching base) and a probe + ask registry", () => {
		const prompt = composeInstructions("placement");
		assert.match(prompt, /placement tester/);
		assert.match(prompt, /Solve it before you write a single option/, "the shared question craft composes");
		assert.doesNotMatch(prompt, /# Teach — one step at a time/, "no teaching doctrine");
		const agent = createPlacementAgent({ skills }, { engine: { model: { id: "fixture" } as never, streamFn: (() => {}) as never } });
		assert.deepEqual(agent.state.tools.map((t) => t.name).sort(), ["ask_user_question", "circuit_solve", "figure_guide", "probe", "read_sketch"]);
	});

	it("finish_lesson logs once, then says it already did", async () => {
		const learn = chatStore.createChat("Learn: A", undefined, { courseId: "course_x", mode: "learn", skillIds: ["sk_a"] });
		const tool = finishLessonTool({ chatId: learn.id, chatStore });
		assert.match(text(await tool.execute("f1", { summary: "s" })), /Logged: the lesson is finished/);
		chatStore.saveMessages(learn.id, [session.newLessonFinishedMarker()]);
		assert.match(text(await tool.execute("f2", { summary: "s" })), /already finished/);
	});
});

// ─── the practice tool's skill tags ──────────────────────────────────────────

describe("the problem tool in a course session", () => {
	const skills = () => [
		{ id: "sk_a", name: "Chain rule" },
		{ id: "sk_b", name: "Product rule" },
	];
	const pose = { statement: "S", mode: "recall", modelSolution: "M" };
	const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("");

	it("has a skills field only when the session has skills", () => {
		const plain = problemTool({ problemActive: false });
		assert.equal("skills" in (plain.parameters as { properties: object }).properties, false);
		const course = problemTool({ problemActive: false }, undefined, skills);
		assert.equal("skills" in (course.parameters as { properties: object }).properties, true);
	});

	it("normalizes names to ids and rejects missing or foreign skills", async () => {
		const tool = problemTool({ problemActive: false }, undefined, skills);
		const prepared = tool.prepareArguments!({ ...pose, skills: ["chain rule", "sk_b", "sk_b"] }) as unknown as { skills: string[] };
		assert.deepEqual(prepared.skills, ["sk_a", "sk_b"]);
		const missing = await tool.execute("t1", { ...pose } as never);
		assert.match(text(missing), /skills is required/);
		const foreign = await problemTool({ problemActive: false }, undefined, skills).execute("t2", { ...pose, skills: ["sk_z"] } as never);
		assert.match(text(foreign), /not this session's skills/);
		const gate = { problemActive: false };
		const ok = await problemTool(gate, undefined, skills).execute("t3", { ...pose, skills: ["sk_a"] } as never);
		assert.doesNotMatch(text(ok), /not this session|required/);
		assert.equal(gate.problemActive, true);
	});

	it("the registry wires courseSkills through", () => {
		const tools = practiceTools({ chatId: "x", chatStore: { getChat: () => ({ messages: [] }) }, courseSkills: skills });
		assert.equal("skills" in (tools.problem!.parameters as { properties: object }).properties, true);
	});
});

// ─── the planner ─────────────────────────────────────────────────────────────

describe("the course planner (scripted model)", () => {
	function engine(steps: FauxResponseStep[]) {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}
	const submit = (input: unknown, id: string) => () =>
		fauxAssistantMessage([fauxToolCall("submit_draft", input as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

	it("an invalid draft is sent back; the corrected one is returned", async () => {
		const bad = { summary: "s", skills: [{ key: "s1", name: "A", statement: "Do a", requires: ["s9"], restsOn: [], cite: "Book.pdf" }] };
		const good = { summary: "s", skills: [{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [], cite: "Book.pdf, p. 1" }] };
		let steps = 0;
		const out = await draftCourse(
			{ title: "T", materials: [{ id: "mat_1", name: "Book.pdf" }], materialsSection: "<curriculum/>", language: "en" },
			{
				engine: engine([submit(bad, "c1"), submit(good, "c2")]),
				checkContext: () => ({ skills: new Map(), nodeIds: new Set() }),
				tools: {},
				courseId: "course_t",
				onStep: () => void steps++,
			},
		);
		assert.deepEqual(out.skills.map((s) => [s.key, s.requires]), [["s1", []]]);
		assert.equal(steps, 2);
	});

	it("the planner is told the course's language", async () => {
		const good = { summary: "s", skills: [{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [], cite: "Book.pdf, p. 1" }] };
		let system = "";
		await draftCourse(
			{ title: "T", materials: [{ id: "mat_1", name: "Book.pdf" }], materialsSection: "", language: "nb" },
			{
				engine: engine([
					(ctx) => {
						system = JSON.stringify(ctx.messages); // the system prompt leads the transcript as a system message
						return submit(good, "c1")();
					},
				]),
				checkContext: () => ({ skills: new Map(), nodeIds: new Set() }),
				tools: {},
				courseId: "course_t",
				onStep: () => {},
			},
		);
		assert.match(system, /<lesson_language>[\s\S]*This course is in Norwegian Bokmål\./);
	});

	it("an uncited material is a validation problem", async () => {
		const uncited = { summary: "s", skills: [{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [] }] };
		await assert.rejects(
			draftCourse(
				{ title: "T", materials: [{ id: "mat_1", name: "Book.pdf" }], materialsSection: "", language: "en" },
				{
					engine: engine([submit(uncited, "c1"), () => fauxAssistantMessage("I give up")]),
					checkContext: () => ({ skills: new Map(), nodeIds: new Set() }),
					tools: {},
					courseId: "course_t",
					onStep: () => {},
				},
			),
			/never submitted/,
		);
	});
});

// ─── render ──────────────────────────────────────────────────────────────────

describe("the UI", () => {
	const summary = { id: "course_a", title: "Calc", status: "active" as const, updatedAt: "t", total: 12, known: 7, progress: 58, needsReview: 2 };

	it("the sidebar row reads known/total, percent and due", () => {
		assert.equal(courseMeta(summary), "7/12 known · 58% · 2 due");
		assert.equal(courseMeta({ ...summary, status: "drafting" }), "Drafting skill map…");
		assert.equal(courseMeta({ ...summary, total: 0, known: 0, progress: 0, needsReview: 0, status: "draft" }), "Draft ready to review");
		const html = renderToStaticMarkup(<CourseRow course={summary} active={false} onOpen={() => {}} />);
		assert.match(html, /Calc/);
		assert.match(html, /7\/12 known/);
	});

	const skillView = (id: string, over: Partial<CoursePayload["skills"][number]> = {}) => ({
		id,
		name: id.toUpperCase(),
		statement: `Do ${id}`,
		requires: [] as string[],
		understanding: 0,
		learned: false,
		known: false,
		needsReview: true,
		reviewAt: null,
		missing: [] as string[],
		propositions: [],
		...over,
	});
	const payload = (over: Partial<CoursePayload> = {}): CoursePayload => ({
		course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "active", skills: ["a", "b"] },
		skills: [skillView("a", { understanding: 6, learned: true, known: true, needsReview: false, reviewAt: "2099-01-01T00:00:00Z" }), skillView("b", { requires: ["a"] })],
		review: [],
		reviewBatch: 0,
		nextUp: ["b"],
		learning: [],
		locked: [],
		known: ["a"],
		contextCheck: [],
		sessions: [{ id: "chat_1", title: "Learn: A", mode: "learn", updatedAt: "t" }],
		reused: {},
		drafting: false,
		...over,
	});
	const body = (data: CoursePayload, placementSkipped = false) =>
		renderToStaticMarkup(
			<CourseBody
				data={data}
				busy={false}
				error={null}
				onDraft={() => {}}
				onApprove={() => {}}
				onStart={() => {}}
				materialCount={1}
				placementSkipped={placementSkipped}
			/>,
		);

	it("an active course shows the map, next up with Learn/Practice, known and sessions", () => {
		const html = body(payload());
		assert.match(html, /data-testid="course-map"/);
		assert.match(html, /data-testid="learn-b"/);
		assert.match(html, /data-testid="practice-b"/);
		assert.match(html, /data-testid="course-known"/);
		assert.match(html, /Learn: A/);
		assert.doesNotMatch(html, /course-draft"/);
		assert.equal(courseProgress(payload()), "1/2 known · 50%");
		assert.doesNotMatch(html, /placement-offer/, "a course with sessions offers no placement");
	});

	it("the Review button says how many of the due skills the next review takes (the session cap)", () => {
		const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
		const many = payload({
			skills: ids.map((id) => skillView(id, { understanding: 2, learned: true })),
			review: ids,
			reviewBatch: 6,
			nextUp: [],
			known: [],
			learning: ids,
		});
		const html = body(many);
		assert.match(html, /Due for review · 8/, "the section still lists all eight");
		assert.match(html, />Review · 6 of 8</, "the section's button says six of the eight");
		// at or under the cap the button just says Review
		const few = payload({ skills: ids.slice(0, 3).map((id) => skillView(id, { understanding: 2, learned: true })), review: ids.slice(0, 3), reviewBatch: 3, nextUp: [], known: [], learning: ids.slice(0, 3) });
		const fewHtml = body(few);
		assert.match(fewHtml, /Due for review · 3/);
		assert.doesNotMatch(fewHtml, / of 3</);
		assert.match(fewHtml, />Review</);
		// the header button's label is the same pure function
		assert.equal(reviewLabel(many), "Review · 6 of 8");
		assert.equal(reviewLabel(few), "Review · 3");
		assert.equal(reviewLabel(payload()), "Review", "nothing to review: no count");
	});

	it("learned skills sit in Learning with Practice and Learn again; a finished lesson is marked", () => {
		const data = payload({
			skills: [skillView("a", { understanding: 2, learned: true, needsReview: false, reviewAt: "2099-01-01T00:00:00Z" }), skillView("b", { requires: ["a"] }), skillView("c", { understanding: 4, learned: true })],
			nextUp: ["b"],
			learning: ["a", "c"],
			known: [],
			sessions: [
				{ id: "chat_2", title: "Practice: A", mode: "practice", updatedAt: "t" },
				{ id: "chat_1", title: "Learn: A", mode: "learn", updatedAt: "t", finished: true },
			],
		});
		const html = body(data);
		assert.match(html, /data-testid="course-learning"[\s\S]*Learning · 2[\s\S]*data-testid="practice-all"/);
		assert.match(html, /data-testid="practice-a"[\s\S]*Learn again/);
		assert.match(html, /Learned · understanding 2\/10 · lasts about 2 days/);
		assert.match(html, /data-testid="course-sessions-open"[\s\S]*Practice: A[\s\S]*aria-expanded="false"[^>]*data-testid="course-sessions-finished-toggle"[^>]*>[\s\S]*Finished · 1/);
		assert.doesNotMatch(html, /data-testid="course-sessions-finished"/, "finished sessions fold away until opened");
		const allDone = body({ ...data, sessions: [data.sessions[1]!] });
		assert.match(allDone, /No session in progress/);
	});

	it("right after approval the placement test is offered first — until skipped or a session exists", () => {
		const fresh = payload({ sessions: [], known: [], nextUp: ["a"], skills: [skillView("a"), skillView("b", { requires: ["a"], missing: ["a"] })], locked: ["b"] });
		const html = body(fresh);
		assert.match(html, /data-testid="placement-offer"[\s\S]*Find your starting point[\s\S]*about one short question for 2 skills/);
		assert.ok(html.indexOf("placement-offer") < html.indexOf("course-map"), "before the map");
		assert.match(html, /data-testid="placement-take"/);
		assert.match(html, /data-testid="placement-skip"[^>]*>Start from the beginning/);
		assert.doesNotMatch(body(fresh, true), /placement-offer/);
	});

	it("skills from another course get their own section with Quick check — shown once, never locked, and the placement offer counts without them", () => {
		const data = payload({
			skills: [skillView("a", { understanding: 6, learned: true, known: true, needsReview: false }), skillView("b", { requires: ["a"] })],
			known: ["a"],
			nextUp: ["b"],
			contextCheck: ["a"],
			sessions: [],
		});
		const html = body(data);
		assert.match(html, /data-testid="course-context-check"[\s\S]*From another course · 1[\s\S]*optional, nothing is locked[\s\S]*data-testid="check-a"[^>]*>Quick check/);
		assert.doesNotMatch(html, /data-testid="course-known"/, "A shows once — in its own section");
		assert.match(html, /about one short question for 1 skill,/);
		assert.doesNotMatch(body({ ...data, skills: [skillView("a", { understanding: 6, learned: true, known: true })], nextUp: [] }), /placement-offer/, "nothing left to place");
	});

	it("a draft shows its skills, reused marks, and the review controls", () => {
		const html = body(
			payload({
				course: {
					id: "course_a",
					title: "Calc",
					createdAt: "t",
					updatedAt: "t",
					status: "draft",
					skills: [],
					draft: {
						createdAt: "t",
						summary: "Two skills.",
						skills: [
							{ key: "s1", reuse: "sk_old", name: "Gammel ferdighet", statement: "Gjør gammel", requires: [], restsOn: ["n1"], cite: "Book, p. 2" },
							{ key: "s2", name: "New", statement: "Do new", requires: ["s1"], restsOn: [] },
						],
					},
				},
				skills: [],
				nextUp: [],
				known: [],
				reused: { sk_old: { name: "Old skill", statement: "Do old" } },
			}),
		);
		assert.match(html, /Draft skill map · 2 skills · 1 reused/);
		// a reused skill shows the draft's wording — approval writes it over the stored one
		assert.match(html, /Gammel ferdighet/);
		assert.doesNotMatch(html, /Old skill/);
		assert.match(html, /Requires Gammel ferdighet/);
		assert.match(html, /rests on 1 proposition you have learned/);
		assert.match(html, /data-testid="draft-approve"/);
		assert.doesNotMatch(html, /data-testid="course-map"/);
	});

	it("drafting shows the planner's progress and disables re-drafting", () => {
		const html = body(payload({ drafting: true }));
		assert.match(html, /data-testid="course-drafting"/);
		const button = html.match(/<button[^>]*data-testid="course-draft-button"[^>]*>/)![0];
		assert.match(button, /disabled=""/);
	});

	it("skill state words", () => {
		assert.equal(skillStateLabel({ understanding: 8, learned: true, known: true, missing: [] }), "Known · understanding 8/10 · lasts about 4 months");
		assert.equal(skillStateLabel({ understanding: 0, learned: false, known: false, missing: ["x"] }), "Locked");
		assert.equal(skillStateLabel({ understanding: 0, learned: false, known: false, missing: [] }), "Not started");
		assert.equal(skillStateLabel({ understanding: 4, learned: true, known: false, missing: [] }), "Learned · understanding 4/10 · lasts about 10 days");
		assert.equal(skillStateLabel({ understanding: 2, learned: true, known: false, missing: ["x"] }), "Learned · understanding 2/10 · lasts about 2 days", "learned outranks locked");
	});

	it("Finish lesson: the button, its blocked state, the finished chip, and the divider", () => {
		const open = renderToStaticMarkup(<FinishLessonButton finished={false} blocked={null} onFinish={() => {}} />);
		assert.match(open, /data-testid="finish-lesson"/);
		assert.doesNotMatch(open.match(/<button[^>]*>/)![0], /disabled=""/);
		const blocked = renderToStaticMarkup(<FinishLessonButton finished={false} blocked="Answer first" onFinish={() => {}} />);
		assert.match(blocked.match(/<button[^>]*>/)![0], /disabled=""/);
		assert.match(renderToStaticMarkup(<FinishLessonButton finished blocked={null} onFinish={() => {}} />), /data-testid="lesson-finished-chip"[\s\S]*Finished/);
		assert.match(renderToStaticMarkup(<LessonFinishedLine skill="Chain rule" />), /Lesson finished · Chain rule learned/);
		const view = [{ id: "m0", role: "user" as const, parts: [{ type: "data-graph-context", id: "gc", data: { propositions: [], chains: [], course: { title: "C", mode: "learn", skills: [{ id: "a", name: "A", statement: "s" }] } } }] }];
		assert.equal(courseOfView(view as never)?.skills[0]?.name, "A");
	});

	it("dictation: a failed local clip offers Retry; the compact idle mic is an icon", () => {
		const base = { phase: "idle" as const, stopLabel: null, levelRef: { current: 0 }, active: false, toggle() {}, stop() {}, finish: async () => {}, cancel() {}, clearError() {} };
		const failed = renderToStaticMarkup(<DictationBar dictation={{ ...base, error: "Local dictation failed: x", retry: () => {} }} compact />);
		assert.match(failed, /Local dictation failed: x[\s\S]*data-testid="dictation-retry"[^>]*>Retry/);
		const idle = renderToStaticMarkup(<DictationBar dictation={{ ...base, error: null, retry: null }} compact />);
		assert.match(idle, /aria-label="Start dictation"/);
		assert.doesNotMatch(idle, />Dictate</, "icon only");
		assert.doesNotMatch(idle, /dictation-retry/);
	});

	it("the transcript card leads with the course and counts its skills", () => {
		const html = renderToStaticMarkup(
			<GraphContextCard
				data={{
					propositions: [{ id: "n1", name: "P", statement: "p" }],
					chains: [],
					course: { title: "Calc", mode: "review", skills: [{ id: "a", name: "A", statement: "Do a" }] },
				}}
			/>,
		);
		assert.match(html, /Calc · Review/);
		assert.match(html, /1 skill · 1 proposition/);
	});
});
