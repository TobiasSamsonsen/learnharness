/**
 * The course page's skill list in a real client mount (linkedom + react-dom): the grouped list (Due, Next up, Learning,
 * Known, and one closed Locked group), the band bar and the due strip narrowing it to one weakest-first list, the Map
 * button, and the row buttons inside a skill's opened detail. The rules themselves are pure in
 * src/core/skill-visual.ts (tests/skill-visual.test.ts); this pins the wiring.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { InteractionLayersProvider } from "../components/interaction-layers";
import { parseHTML } from "linkedom";
import { CourseBody, dueShort, type CoursePayload } from "../components/course-page.tsx";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
const storage = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => {
		store.set(key, String(value));
	},
	removeItem: (key: string) => {
		store.delete(key);
	},
	clear: () => store.clear(),
	key: (index: number) => [...store.keys()][index] ?? null,
	get length() {
		return store.size;
	},
};
Object.assign(dom.window, { localStorage: storage });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: storage,
	// next/link's idle-callback shim reads `self` (the browser global) at mount.
	self: globalThis,
});

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2001-01-01T00:00:00Z";

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
	stability: null,
	lastReview: null,
	missing: [] as string[],
	weight: 1,
	priority: 1,
	propositions: [],
	...over,
});

// Four skills covering every band and state. A is locked: it names B as a
// prerequisite (the server's `missing` only lists prerequisites with no state
// at all, which a four-skill course with B, C, D learned cannot produce, so the
// fixture sets it directly).
const data: CoursePayload = {
	course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "active", skills: ["a", "b", "c", "d"] },
	skills: [
		skillView("a", { requires: ["b"], missing: ["b"], needsReview: false }),
		skillView("b", { understanding: 2, learned: true, needsReview: true, reviewAt: PAST }),
		skillView("c", { understanding: 4.5, learned: true, needsReview: false, reviewAt: FUTURE }),
		skillView("d", { understanding: 8, learned: true, known: true, needsReview: false, reviewAt: FUTURE }),
	],
	review: ["b"],
	reviewBatch: 1,
	notExamined: [],
	plan: { skillsLeft: 0, reviewDue: 0, reviewBatch: 0, lessons: [] },
	nextUp: [],
	learning: ["b", "c"],
	locked: ["a"],
	known: ["d"],
	contextCheck: [],
	sessions: [{ id: "chat_1", title: "Learn: B", mode: "learn", updatedAt: "t" }],
	reused: {},
	drafting: false,
};

async function mount(): Promise<void> {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<InteractionLayersProvider><CourseBody
				data={data}
				busy={false}
				error={null}
				onDraft={() => {}}
				onApprove={() => {}}
				onStart={() => {}}
				materialCount={1}
			/></InteractionLayersProvider>,
		);
	});
}

const byTestId = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const has = (id: string): boolean => byTestId(id) !== null;

async function click(id: string): Promise<void> {
	const el = byTestId(id);
	assert.ok(el, `expected a [data-testid="${id}"] element to click`);
	await act(async () => {
		el.click();
	});
}

/** The skill letters listed inside a section, in DOM order (skill-<id> rows only). */
function listed(scope: string): string[] {
	const section = byTestId(scope);
	assert.ok(section, `expected [data-testid="${scope}"] to be on the page`);
	return [...section.querySelectorAll("[data-testid]")]
		.map((el) => el.getAttribute("data-testid") ?? "")
		.filter((id) => /^skill-[a-d]$/.test(id))
		.map((id) => id.slice("skill-".length));
}

/** The skill letters listed anywhere on the page (for the Sections view). */
function listedAnywhere(): string[] {
	return [...document.querySelectorAll("[data-testid]")]
		.map((el) => el.getAttribute("data-testid") ?? "")
		.filter((id) => /^skill-[a-d]$/.test(id))
		.map((id) => id.slice("skill-".length));
}

/** Open a skill row's detail (the row is one tap target; its buttons live in the detail). */
async function expand(skillId: string): Promise<void> {
	const row = byTestId(`skill-${skillId}`);
	assert.ok(row, `expected the row skill-${skillId}`);
	const toggle = row.querySelector("button[aria-expanded]") as HTMLElement | null;
	assert.ok(toggle, `expected skill-${skillId} to have its row button`);
	await act(async () => {
		toggle.click();
	});
}

beforeEach(() => {
	store.clear();
	globalThis.fetch = () => new Promise<Response>(() => {});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
	store.clear();
});

test("the list is grouped by default: the review section shows and the narrowed list does not", async () => {
	await mount();
	assert.ok(has("course-review"), "the due-for-review group shows");
	assert.ok(has("course-learning") && has("course-known"), "Learning and Known are groups");
	assert.equal(has("course-flat"), false, "the narrowed list is not shown by default");
	assert.equal(store.has("lh:skill-view"), false, "nothing is saved: there is one list, no view to remember");
	assert.equal(has("view-sections") || has("view-understanding") || has("sort-direction") || has("chip-all"), false, "the view switch, sort and filter pills are gone");
});

test("Reviews due is its own box right below the Understanding box", async () => {
	await mount();
	const overview = byTestId("course-overview");
	const due = byTestId("course-due");
	assert.ok(overview && due, "both boxes are there");
	assert.equal(overview.contains(due), false, "the review strip is not inside the Understanding box");
	assert.equal(overview.querySelector("[data-testid='due-timeline']"), null);
	assert.ok(due.querySelector("[data-testid='due-timeline']"), "the strip lives in its own box");
	assert.match(due.textContent ?? "", /Reviews due/);
	assert.equal(overview.nextElementSibling, due, "directly below Understanding");
});

test("Locked is one closed group at the end, listing the locked skills", async () => {
	await mount();
	const locked = byTestId("course-locked");
	assert.ok(locked, "the locked group is there");
	assert.equal(locked.hasAttribute("open"), false, "closed by default");
	assert.deepEqual(listed("course-locked"), ["a"]);
	const groups = [...document.querySelectorAll("[data-testid^='course-']")].map((el) => el.getAttribute("data-testid"));
	assert.ok(groups.indexOf("course-locked") > groups.indexOf("course-known"), "after Known, at the end of the list");
});

test("a band on the bar narrows the list to the matching skills; clear-band brings the groups back", async () => {
	await mount();
	await click("strip-known");
	assert.ok(has("course-flat"), "tapping a band shows the narrowed list");
	assert.equal(has("course-review"), false, "the groups are replaced");
	assert.deepEqual(listed("course-flat"), ["d"], "only the 6-and-up skill is listed");
	assert.ok(has("clear-band"), "the active band is shown as a clearable chip");

	await click("clear-band");
	assert.equal(has("course-flat"), false, "clearing the band shows the groups again");
	assert.ok(has("course-review") && has("course-learning"));
	assert.equal(has("clear-band"), false);
});

test("the narrowed list is sorted weakest first", async () => {
	await mount();
	await click("timeline-later");
	assert.deepEqual(listed("course-flat"), ["c", "d"], "the two skills not due this week, weakest first");
});

test("the due strip's Now bucket narrows the list to the due skill and saves nothing", async () => {
	await mount();
	assert.equal(has("course-flat"), false);
	await click("timeline-now");
	assert.ok(has("course-flat"));
	assert.deepEqual(listed("course-flat"), ["b"], "only B is due now");
	assert.equal(store.has("lh:skill-view"), false);
	assert.equal(listedAnywhere().length, 1, "no other skill row is on the page");
	assert.ok(has("clear-bucket"));
	await click("clear-bucket");
	assert.equal(has("course-flat"), false);
});

test("the Map button shows the skill map, fitted, and hides it again", async () => {
	await mount();
	assert.equal(has("course-map"), false, "the map is not on the page until asked for");
	await click("map-toggle");
	assert.ok(has("course-map") && has("skill-map"), "the map appears");
	await click("map-toggle");
	assert.equal(has("course-map"), false, "and goes away again");
});

test("a due skill carries a dot and its row opens to three figures, not a sentence", async () => {
	await mount();
	const row = byTestId("skill-b");
	assert.ok(row?.querySelector("[data-testid='skill-due-chip']"), "B is due: its row has the due dot");
	assert.equal(byTestId("skill-detail-b"), null, "the detail is closed");
	await expand("b");
	const detail = byTestId("skill-detail-b")!;
	const figures = byTestId("skill-figures-b")!;
	assert.match(figures.textContent ?? "", /2\/10/, "understanding as a number");
	assert.match(figures.textContent ?? "", /understanding/);
	assert.match(figures.textContent ?? "", /recall/);
	assert.match(figures.textContent ?? "", /now[\s\S]*due/, "due now");
	assert.match(figures.getAttribute("aria-label") ?? "", /Learned · understanding 2\/10[\s\S]*due now/, "the old sentence is the figures' accessible name");
	assert.doesNotMatch(detail.textContent ?? "", /Learned · understanding|lasts about|due for review below 90%|Rests on what/, "no sentences on the opened row");
});

test("an opened skill shows what it needs as chips with a check or a lock, a compact weight control, and a clamped statement", async () => {
	await mount();
	await expand("a"); // locked: needs B, and B is learned in this fixture
	const chips = byTestId("skill-needs-a")!;
	assert.match(chips.textContent ?? "", /needs/);
	const chip = chips.querySelector("[data-testid='prereq-chip']")!;
	assert.equal(chip.getAttribute("data-learned"), "true", "B is learned: a check");
	assert.ok(chip.querySelector("svg"), "the state is an icon, not only a colour");
	assert.equal(byTestId("skill-figures-a"), null, "an unlearned skill has no figures");
	assert.equal(byTestId("skill-state-a")?.textContent, "Locked");
	assert.ok(byTestId("weight-editor-a"), "the weight control");
	assert.match(byTestId("skill-statement-a")?.className ?? "", /max-h-/, "the statement is cut to about two lines");
	await expand("d");
	assert.equal(byTestId("skill-needs-d"), null, "a skill with no prerequisites has no chips");
});

test("More opens the rest: the full statement, the evidence behind the weight, the last lesson and the propositions", async () => {
	await mount();
	await expand("b");
	assert.equal(byTestId("skill-more-body-b"), null, "closed by default");
	assert.equal(byTestId("skill-more-b")?.textContent, "More ›");
	await click("skill-more-b");
	const body = byTestId("skill-more-body-b")!;
	assert.ok(body.querySelector("[data-testid='weight-note-b']"), "the weight evidence");
	assert.match(body.textContent ?? "", /Do b/, "the full statement");
	assert.equal(byTestId("skill-more-b")?.textContent, "Less ‹");
	await click("skill-more-b");
	assert.equal(byTestId("skill-more-body-b"), null);
});

test("the due figure reads now, tomorrow, days, or a dash", () => {
	const at = Date.parse("2026-11-14T12:00:00Z");
	assert.equal(dueShort({ learned: false, reviewAt: null }, at), "—");
	assert.equal(dueShort({ learned: true, reviewAt: "2026-11-14T10:00:00Z" }, at), "now");
	assert.equal(dueShort({ learned: true, reviewAt: "2026-11-15T10:00:00Z" }, at), "tomorrow");
	assert.equal(dueShort({ learned: true, reviewAt: "2026-11-17T12:00:00Z" }, at), "3 d");
});

test("row buttons live in the opened detail: next up gets Learn and Practice, learned-not-known gets Practice and Learn again, a known or context-check skill gets Practice (a context-check skill also Quick check)", async () => {
	// e: next up. f: from another course (contextCheck), learned and known as the server sends it. g: learned, not known. h: known.
	const extra: CoursePayload = {
		course: { id: "course_b", title: "Extra", createdAt: "t", updatedAt: "t", status: "active", skills: ["e", "f", "g", "h"] },
		skills: [
			skillView("e"),
			skillView("f", { understanding: 8, learned: true, known: true, needsReview: false, reviewAt: FUTURE }),
			skillView("g", { understanding: 3, learned: true, needsReview: true, reviewAt: PAST }),
			skillView("h", { understanding: 9, learned: true, known: true, needsReview: false, reviewAt: FUTURE }),
		],
		review: [],
		reviewBatch: 0,
		notExamined: [],
		plan: { skillsLeft: 0, reviewDue: 0, reviewBatch: 0, lessons: [] },
		nextUp: ["e"],
		learning: ["f", "g"],
		locked: [],
		known: ["f", "h"],
		contextCheck: ["f"],
		sessions: [{ id: "chat_2", title: "Learn: G", mode: "learn", updatedAt: "t" }],
		reused: {},
		drafting: false,
	};
	const calls: Array<[string, string | undefined]> = [];
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<InteractionLayersProvider><CourseBody
				data={extra}
				busy={false}
				error={null}
				onDraft={() => {}}
				onApprove={() => {}}
				onStart={(mode, skillId) => {
					calls.push([mode, skillId]);
				}}
				materialCount={1}
			/></InteractionLayersProvider>,
		);
	});

	assert.equal(has("learn-e") || has("practice-e"), false, "a closed row shows no buttons");
	await expand("e");
	assert.ok(has("learn-e") && has("practice-e"), "next up E shows Learn and Practice");
	assert.equal(has("check-e"), false, "next up E has no quick check");
	await click("learn-e");
	await click("practice-e");
	assert.deepEqual(calls, [["learn", "e"], ["practice", "e"]], "E's buttons start learn and practice on E");

	await expand("g");
	assert.ok(has("practice-g") && has("learn-g"), "learned-not-known G shows Practice and Learn again");
	assert.equal(has("check-g"), false);

	await expand("f");
	assert.ok(has("check-f"), "the context-check skill F shows Quick check");
	assert.ok(has("practice-f"), "and, being known, Practice");
	assert.equal(has("learn-f"), false, "but no Learn");
	await click("check-f");
	assert.deepEqual(calls.at(-1), ["check", "f"], "Quick check starts a check on F");
	await click("practice-f");
	assert.deepEqual(calls.at(-1), ["practice", "f"], "Practice starts a practice session on the known skill F");

	await expand("h");
	assert.ok(has("skill-h"), "the known skill row is listed");
	assert.ok(has("practice-h"), "a known skill can be practiced");
	assert.equal(has("learn-h") || has("check-h"), false, "known H has no Learn or Quick check");
	await click("practice-h");
	assert.deepEqual(calls.at(-1), ["practice", "h"], "Practice starts a practice session on H");
});

/** Tap a skill row's main button (the first row with this id on the page). */
async function tapRow(skillId: string): Promise<void> {
	const row = byTestId(`skill-${skillId}`);
	assert.ok(row, `expected the row skill-${skillId}`);
	const button = row.querySelector("button") as HTMLElement | null;
	assert.ok(button, `expected skill-${skillId} to have its row button`);
	await act(async () => {
		button.click();
	});
}

test("Choose skills: a tap ticks instead of opening, a locked skill cannot be ticked, Practice starts one session on the set", async () => {
	const sets: string[][] = [];
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<InteractionLayersProvider>
				<CourseBody
					data={data}
					busy={false}
					error={null}
					onDraft={() => {}}
					onApprove={() => {}}
					onStart={() => {}}
					onPracticeSet={(ids) => {
						sets.push(ids);
					}}
					materialCount={1}
				/>
			</InteractionLayersProvider>,
		);
	});
	assert.equal(has("choose-bar"), false, "the mode is off until asked for");
	await click("choose-toggle");
	assert.ok(has("choose-bar"));
	assert.equal(byTestId("choose-count")?.textContent, "Tap skills to practice");
	assert.equal(byTestId("choose-start")?.hasAttribute("disabled"), true, "nothing ticked yet");

	await tapRow("d"); // known
	await tapRow("c"); // learning
	assert.equal(byTestId("skill-detail-d"), null, "a tap ticks, it does not open the row");
	assert.equal(byTestId("choose-count")?.textContent, "2 skills chosen");
	assert.ok(byTestId("choose-box-d"), "each row shows a box while choosing");

	await tapRow("a"); // locked: not selectable
	assert.equal(byTestId("choose-count")?.textContent, "2 skills chosen", "a locked skill stays unticked");

	await tapRow("c"); // untick
	assert.equal(byTestId("choose-count")?.textContent, "1 skill chosen");
	await tapRow("c");
	await click("choose-start");
	assert.deepEqual(sets.map((s) => [...s].sort()), [["c", "d"]], "one session on the two ticked skills, the known one included");

	await click("choose-cancel");
	assert.equal(has("choose-bar"), false, "Cancel leaves the mode");
	await tapRow("d");
	assert.ok(byTestId("skill-detail-d"), "and a tap opens the row again");
});
