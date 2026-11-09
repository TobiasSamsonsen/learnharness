/**
 * The course page's skill list in a real client mount (linkedom + react-dom):
 * the Sections default, the By understanding flat list and its sort direction
 * (persisted in localStorage "lh:skill-view"), the header strip and due
 * timeline narrowing it, and the filter chips. The rules themselves are pure in
 * src/core/skill-visual.ts (tests/skill-visual.test.ts); this pins the wiring.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CourseBody, type CoursePayload } from "../components/course-page.tsx";

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
			<CourseBody
				data={data}
				busy={false}
				error={null}
				onDraft={() => {}}
				onApprove={() => {}}
				onStart={() => {}}
				materialCount={1}
			/>,
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

function persisted(): unknown {
	const raw = store.get("lh:skill-view");
	return raw === undefined ? undefined : JSON.parse(raw);
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

test("default view is Sections: the review section shows and the flat list does not", async () => {
	await mount();
	assert.ok(has("course-review"), "the Sections view shows the due-for-review section");
	assert.equal(has("course-flat"), false, "the flat list is not shown by default");
	assert.equal(persisted(), undefined, "a default mount writes nothing to localStorage");
});

test("By understanding lists weakest first; sort-direction flips it and both choices persist", async () => {
	await mount();
	await click("view-understanding");
	assert.ok(has("course-flat"), "the flat list appears");
	assert.deepEqual(listed("course-flat"), ["a", "b", "c", "d"], "weakest first");
	assert.deepEqual(persisted(), { view: "understanding", weakestFirst: true });

	await click("sort-direction");
	assert.deepEqual(listed("course-flat"), ["d", "c", "b", "a"], "strongest first after the flip");
	assert.deepEqual(persisted(), { view: "understanding", weakestFirst: false });
});

test("the header strip's band narrows the Sections view to the flat list; clear-band restores all four", async () => {
	await mount();
	await click("strip-known");
	assert.ok(has("course-flat"), "tapping a band switches to the flat view");
	assert.equal(has("course-review"), false, "the Sections view is gone");
	assert.deepEqual(listed("course-flat"), ["d"], "only the 6-and-up skill is listed");
	assert.ok(has("clear-band"), "the active band is shown as a clearable chip");

	await click("clear-band");
	assert.deepEqual(listed("course-flat"), ["a", "b", "c", "d"], "clearing the band lists all four again");
	assert.equal(has("clear-band"), false);
});

test("the filter chips narrow the flat list: due, locked, learning, known", async () => {
	await mount();
	await click("view-understanding");

	await click("chip-due");
	assert.deepEqual(listed("course-flat"), ["b"], "due: only B is past its review line");

	await click("chip-locked");
	assert.deepEqual(listed("course-flat"), ["a"], "locked: only A");

	await click("chip-learning");
	assert.deepEqual(listed("course-flat"), ["b", "c"], "learning: learned but not known");

	await click("chip-known");
	assert.deepEqual(listed("course-flat"), ["d"], "known: only D");
});

test("the due timeline's Now bucket switches to the flat view showing only the due skill", async () => {
	await mount();
	assert.equal(has("course-flat"), false);
	await click("timeline-now");
	assert.ok(has("course-flat"), "tapping a timeline bucket switches to the flat view");
	assert.deepEqual(listed("course-flat"), ["b"], "only B is due now");
	assert.deepEqual(persisted(), { view: "understanding", weakestFirst: true });
	assert.equal(listedAnywhere().length, 1, "no other skill row is on the page");
});

test("the flat view's row buttons: next up gets Learn and Practice, learned-not-known gets Practice and Learn again, a context-check skill gets Quick check, a known skill gets none", async () => {
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
			<CourseBody
				data={extra}
				busy={false}
				error={null}
				onDraft={() => {}}
				onApprove={() => {}}
				onStart={(mode, skillId) => {
					calls.push([mode, skillId]);
				}}
				materialCount={1}
			/>,
		);
	});
	await click("view-understanding");
	assert.ok(has("course-flat"), "the flat list appears");

	assert.ok(has("learn-e") && has("practice-e"), "next up E shows Learn and Practice");
	assert.equal(has("check-e"), false, "next up E has no quick check");
	await click("learn-e");
	await click("practice-e");
	assert.deepEqual(calls, [["learn", "e"], ["practice", "e"]], "E's buttons start learn and practice on E");

	assert.ok(has("practice-g") && has("learn-g"), "learned-not-known G shows Practice and Learn again");
	assert.equal(has("check-g"), false);

	assert.ok(has("check-f"), "the context-check skill F shows Quick check");
	assert.equal(has("learn-f") || has("practice-f"), false, "F shows only the quick check");
	await click("check-f");
	assert.deepEqual(calls.at(-1), ["check", "f"], "Quick check starts a check on F");

	assert.ok(has("skill-h"), "the known skill row is listed");
	assert.equal(has("learn-h") || has("practice-h") || has("check-h"), false, "known H has no learn, practice or check button");
});
