/**
 * skill-visual — the course page's visual layer as pure functions: the
 * understanding bands, the review-due buckets, the flat list's chips and
 * selection, the weakest-first sort, and the bar color ramp. Fixed `now`, no
 * DOM, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourseSkillView } from "../src/core/contracts/course.ts";
import {
	bandCounts,
	bucketCounts,
	dueBucket,
	isDue,
	matchesSelection,
	NO_SELECTION,
	skillBand,
	sortByUnderstanding,
	understandingColor,
	type SkillSelection,
} from "../src/core/skill-visual.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-09T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

function skill(over: Partial<CourseSkillView> & { name?: string } = {}): CourseSkillView {
	return {
		id: over.id ?? "s",
		name: over.name ?? "S",
		statement: "",
		requires: [],
		understanding: 0,
		learned: false,
		known: false,
		needsReview: false,
		reviewAt: null,
		stability: null,
		lastReview: null,
		missing: [],
		weight: 1,
		priority: 1,
		propositions: [],
		...over,
	};
}

describe("skillBand", () => {
	it("not learned is its own band, whatever the understanding", () => {
		assert.equal(skillBand({ learned: false, understanding: 0 }), "new");
		assert.equal(skillBand({ learned: false, understanding: 8 }), "new");
	});

	it("learned skills split at 3 and at 6 (known)", () => {
		assert.equal(skillBand({ learned: true, understanding: 2.9 }), "low");
		assert.equal(skillBand({ learned: true, understanding: 3 }), "mid");
		assert.equal(skillBand({ learned: true, understanding: 5.9 }), "mid");
		assert.equal(skillBand({ learned: true, understanding: 6 }), "known");
	});
});

describe("bandCounts", () => {
	it("counts each skill once, in its band", () => {
		const counts = bandCounts([
			{ learned: false, understanding: 0 },
			{ learned: false, understanding: 0 },
			{ learned: true, understanding: 1 },
			{ learned: true, understanding: 4 },
			{ learned: true, understanding: 4.5 },
			{ learned: true, understanding: 7 },
		]);
		assert.deepEqual(counts, { new: 2, low: 1, mid: 2, known: 1 });
	});

	it("an empty course has zero in every band", () => {
		assert.deepEqual(bandCounts([]), { new: 0, low: 0, mid: 0, known: 0 });
	});
});

describe("isDue", () => {
	it("a learned skill is due when the server flags needsReview", () => {
		assert.equal(isDue({ learned: true, needsReview: true, reviewAt: at(3 * DAY) }, NOW), true);
	});

	it("a learned skill is due when reviewAt has passed, even without the flag", () => {
		assert.equal(isDue({ learned: true, needsReview: false, reviewAt: at(-HOUR) }, NOW), true);
	});

	it("a learned skill with a future reviewAt and no flag is not due", () => {
		assert.equal(isDue({ learned: true, needsReview: false, reviewAt: at(2 * DAY) }, NOW), false);
	});

	it("a skill that is not learned is never due", () => {
		assert.equal(isDue({ learned: false, needsReview: true, reviewAt: at(-HOUR) }, NOW), false);
	});
});

describe("dueBucket", () => {
	it("due now (flagged or past reviewAt) is now", () => {
		assert.equal(dueBucket({ learned: true, needsReview: true, reviewAt: at(10 * DAY) }, NOW), "now");
		assert.equal(dueBucket({ learned: true, needsReview: false, reviewAt: at(-HOUR) }, NOW), "now");
	});

	it("within 24 hours is today", () => {
		assert.equal(dueBucket({ learned: true, needsReview: false, reviewAt: at(12 * HOUR) }, NOW), "today");
		assert.equal(dueBucket({ learned: true, needsReview: false, reviewAt: at(DAY) }, NOW), "today", "24h exactly is still today");
	});

	it("within 7 days is this week", () => {
		assert.equal(dueBucket({ learned: true, needsReview: false, reviewAt: at(DAY + HOUR) }, NOW), "week");
		assert.equal(dueBucket({ learned: true, needsReview: false, reviewAt: at(3 * DAY) }, NOW), "week");
		assert.equal(dueBucket({ learned: true, needsReview: false, reviewAt: at(7 * DAY) }, NOW), "week", "7 days exactly is still this week");
	});

	it("beyond 7 days is later", () => {
		assert.equal(dueBucket({ learned: true, needsReview: false, reviewAt: at(7 * DAY + HOUR) }, NOW), "later");
		assert.equal(dueBucket({ learned: true, needsReview: false, reviewAt: at(30 * DAY) }, NOW), "later");
	});

	it("not learned is no bucket", () => {
		assert.equal(dueBucket({ learned: false, needsReview: false, reviewAt: at(HOUR) }, NOW), null);
		assert.equal(dueBucket({ learned: false, needsReview: true, reviewAt: null }, NOW), null);
	});
});

describe("bucketCounts", () => {
	it("counts learned skills per bucket and leaves not-learned skills out", () => {
		const counts = bucketCounts(
			[
				{ learned: true, needsReview: true, reviewAt: at(9 * DAY) },
				{ learned: true, needsReview: false, reviewAt: at(-HOUR) },
				{ learned: true, needsReview: false, reviewAt: at(2 * HOUR) },
				{ learned: true, needsReview: false, reviewAt: at(4 * DAY) },
				{ learned: true, needsReview: false, reviewAt: at(20 * DAY) },
				{ learned: true, needsReview: false, reviewAt: at(21 * DAY) },
				{ learned: false, needsReview: false, reviewAt: null },
			],
			NOW,
		);
		assert.deepEqual(counts, { now: 2, today: 1, week: 1, later: 2 });
	});
});

describe("matchesSelection", () => {
	// A: learned, weak, due by the flag. B: known, not due. C: locked behind A. D: not learned, no prerequisite.
	const A = skill({ id: "a", understanding: 2, learned: true, needsReview: true, reviewAt: at(3 * DAY) });
	const B = skill({ id: "b", understanding: 7, learned: true, known: true, reviewAt: at(20 * DAY) });
	const C = skill({ id: "c", missing: ["a"] });
	const D = skill({ id: "d" });
	const ids = (sel: SkillSelection) => [A, B, C, D].filter((s) => matchesSelection(s, sel, NOW)).map((s) => s.id);
	const chip = (c: SkillSelection["chip"]): SkillSelection => ({ ...NO_SELECTION, chip: c });

	it("the All chip matches every skill", () => {
		assert.deepEqual(ids(chip("all")), ["a", "b", "c", "d"]);
	});

	it("the Due chip matches only the due skills", () => {
		assert.deepEqual(ids(chip("due")), ["a"]);
	});

	it("the Learning chip is learned but not known", () => {
		assert.deepEqual(ids(chip("learning")), ["a"]);
	});

	it("the Locked chip is not learned with a missing prerequisite", () => {
		assert.deepEqual(ids(chip("locked")), ["c"]);
	});

	it("the Known chip matches only known skills", () => {
		assert.deepEqual(ids(chip("known")), ["b"]);
	});

	it("a band narrows the chip", () => {
		assert.deepEqual(ids({ ...NO_SELECTION, band: "low" }), ["a"]);
		assert.deepEqual(ids({ ...NO_SELECTION, band: "known" }), ["b"]);
		assert.deepEqual(ids({ ...NO_SELECTION, band: "new" }), ["c", "d"]);
		assert.deepEqual(ids({ chip: "learning", band: "known", bucket: null }), [], "learning and known do not meet");
	});

	it("a timeline bucket narrows the chip", () => {
		assert.deepEqual(ids({ ...NO_SELECTION, bucket: "now" }), ["a"]);
		assert.deepEqual(ids({ ...NO_SELECTION, bucket: "later" }), ["b"]);
		assert.deepEqual(ids({ ...NO_SELECTION, bucket: "week" }), []);
		assert.deepEqual(ids({ chip: "due", band: null, bucket: "later" }), [], "due and later do not meet");
	});
});

describe("sortByUnderstanding", () => {
	const p = skill({ id: "p", name: "Pia", understanding: 2, learned: true, reviewAt: at(20 * DAY) });
	const q = skill({ id: "q", name: "Quinn", understanding: 5, learned: true, reviewAt: at(20 * DAY) });
	const r = skill({ id: "r", name: "Ruth", understanding: 5, learned: true, needsReview: true, reviewAt: at(DAY) });
	const s = skill({ id: "s", name: "Sam", understanding: 5, learned: true, needsReview: true, reviewAt: at(DAY) });
	const t = skill({ id: "t", name: "Tove", understanding: 8, learned: true, known: true, reviewAt: at(20 * DAY) });
	const input = [t, q, s, p, r];

	it("weakest first: lowest understanding first, due before not due, then name", () => {
		assert.deepEqual(sortByUnderstanding(input, true, NOW).map((x) => x.id), ["p", "r", "s", "q", "t"]);
	});

	it("strongest first: highest understanding first, ties still due-first then name", () => {
		assert.deepEqual(sortByUnderstanding(input, false, NOW).map((x) => x.id), ["t", "r", "s", "q", "p"]);
	});

	it("does not mutate the input", () => {
		const before = input.map((x) => x.id);
		sortByUnderstanding(input, true, NOW);
		sortByUnderstanding(input, false, NOW);
		assert.deepEqual(input.map((x) => x.id), before);
	});
});

describe("understandingColor", () => {
	it("not learned (0) has no color", () => {
		assert.equal(understandingColor(0), null);
	});

	it("steps round to the 1-10 ramp", () => {
		assert.equal(understandingColor(0.4), "var(--lh-understanding-1)");
		assert.equal(understandingColor(6.4), "var(--lh-understanding-6)");
		assert.equal(understandingColor(10), "var(--lh-understanding-10)");
	});
});
