/**
 * Rendered names and statements on the fork's own surfaces (owner, 2026-11-12): the skill card's "Rests on" list, the
 * graph context card, the course page and the collapsed practice dock. Upstream v0.6.1 renders math in the graph node
 * card and the chains view; components/rich-text.tsx carries the same technique to these places.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { RichLine, RichText, richLineSource } from "../components/rich-text.tsx";
import { SkillDetail } from "../components/graph-view.tsx";
import { GraphContextCard } from "../components/graph-context-card.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";

const formulas = (html: string) => html.split('class="katex"').length - 1;
const UI_FONT = "[--font-prose:var(--font-ui)]";

describe("RichText: a rendered block that keeps the host's type", () => {
	it("renders inline and display math and leaves plain text alone", () => {
		const html = renderToStaticMarkup(<RichText>{"For real $x$:\n\n$$\ne^{ix}=\\cos x+i\\sin x\n$$"}</RichText>);
		assert.equal(formulas(html), 2);
		assert.ok(html.includes("katex-display"));
		const plain = renderToStaticMarkup(<RichText>A list can be changed after it is made.</RichText>);
		assert.equal(formulas(plain), 0);
		assert.ok(plain.includes("A list can be changed after it is made."));
	});

	it("stays in the UI font with the caller's size, and takes the chat font only when asked", () => {
		const ui = renderToStaticMarkup(<RichText className="[--lh-prose-size:var(--text-xs)]">Statement `x`</RichText>);
		assert.ok(ui.includes(UI_FONT) && ui.includes("[--lh-prose-size:var(--text-xs)]"));
		assert.ok(ui.includes("[&amp;_[data-streamdown=inline-code]]:[font-size:inherit]"), "inline code follows the line's size");
		const prose = renderToStaticMarkup(<RichText prose>Statement</RichText>);
		assert.ok(!prose.includes(UI_FONT));
	});

	it("blocks remote images like every other tool text", () => {
		const html = renderToStaticMarkup(<RichText>{"![untrusted](https://example.invalid/image.png)"}</RichText>);
		assert.equal(parseHTML(html).document.querySelector("img"), null);
		assert.ok(html.includes("[Image blocked: untrusted]"));
	});
});

describe("RichLine: the first line on one row", () => {
	it("takes the first line that is not blank, after the display repair", () => {
		assert.equal(richLineSource("Find $x$.\n\nThen explain."), "Find $x$.");
		assert.equal(richLineSource("\n\n  \nSecond thought"), "Second thought");
		assert.equal(richLineSource(""), "");
		// two encoded line breaks are layout evidence: the repaired text is several lines, the row shows the first
		assert.equal(richLineSource("Find $x$.\\n\\nThen explain."), "Find $x$.");
	});

	it("renders that line's math in one clipped row and nothing after it", () => {
		const html = renderToStaticMarkup(<RichLine>{"Find $\\frac{dy}{dx}$ for $y=\\sin x$.\n\nA second paragraph with $z$."}</RichLine>);
		assert.equal(formulas(html), 2);
		assert.ok(!html.includes("second paragraph"));
		const { document } = parseHTML(html);
		const row = document.querySelector("[data-rich-line] > .lh-prose")!;
		for (const token of ["overflow-hidden", "whitespace-nowrap", "[&_p]:truncate"]) assert.ok(row.classList.contains(token), token);
		assert.ok(document.querySelector("[data-rich-line]")!.classList.contains("min-w-0"));
	});

	it("nests nothing interactive: a link is text, code and display math carry no copy button", () => {
		for (const source of ["See [the notes](https://example.invalid/) and `code`.", "$$x^2$$", "```python"]) {
			const { document } = parseHTML(renderToStaticMarkup(<RichLine>{source}</RichLine>));
			assert.equal(document.querySelectorAll("a, button").length, 0, source);
		}
		const html = renderToStaticMarkup(<RichLine>{"See [the notes](https://example.invalid/)."}</RichLine>);
		assert.ok(html.includes("the notes") && !html.includes("example.invalid"));
	});

	it("passes a value that is not a string through as plain truncated text", () => {
		const { document } = parseHTML(renderToStaticMarkup(<RichLine className="flex-1">{17}</RichLine>));
		assert.equal(document.querySelector("span.truncate")!.textContent, "17");
		assert.equal(document.querySelector(".lh-prose"), null);
	});
});

describe("the fork's surfaces render math", () => {
	it("skill card: each 'Rests on' name is one rendered row", () => {
		const skill = { id: "sk_a", name: "A", statement: "Do a", understanding: 2, known: false, needsReview: false, courses: [], propositions: ["n_1", "n_2"] };
		const names: Record<string, string> = { n_1: "Euler's formula $e^{ix}$", n_2: "Lists are mutable" };
		const html = renderToStaticMarkup(<SkillDetail skill={skill} propositionName={(id) => names[id]} />);
		const { document } = parseHTML(html);
		assert.equal(document.querySelectorAll("[data-rich-line]").length, 2);
		assert.equal(formulas(html), 1);
		assert.ok(!html.includes("$"), "no raw dollar delimiters remain");
		assert.match(html, /Rests on[\s\S]*Lists are mutable/);
	});

	it("collapsed practice dock: the bar shows the statement's first line with its math, inside the button", () => {
		const statement = "Find $\\frac{dy}{dx}$ for $y=\\sin(x^2)$.\n\nShow each step.";
		const html = renderToStaticMarkup(
			<PracticeDock chatId="chat-1" problemCallId="call_math" input={{ statement }} expanded={false} onExpand={() => {}} onSubmit={() => {}} />,
		);
		const { document } = parseHTML(html);
		const bar = document.querySelector('[data-testid="practice-dock-bar"]')!;
		assert.equal(bar.tagName, "BUTTON");
		assert.equal(bar.querySelectorAll(".katex").length, 2);
		assert.ok(!bar.textContent!.includes("Show each step"));
		assert.equal(bar.querySelectorAll("a, button").length, 0);
	});

	it("graph context card: skills and propositions are a name over a statement, both rendered; chain lines stay plain", async () => {
		const { window, document } = parseHTML("<html><body></body></html>");
		const saved = Object.getOwnPropertyDescriptors(globalThis);
		const keys = ["window", "document", "Element", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"];
		Object.assign(globalThis, { window, document, Element: window.Element, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			const data = {
				propositions: [{ id: "n_1", name: "Chain rule $f\\circ g$", statement: "If $y=f(g(x))$ then $y'=f'(g(x))g'(x)$." }],
				chains: ["n_1 → $n_2$"],
				course: { id: "course_1", title: "Calculus", mode: "learn", skills: [{ id: "sk_1", name: "Differentiate $\\sin$", statement: "Find $\\frac{d}{dx}\\sin x$." }] },
			};
			await act(async () => root.render(<GraphContextCard data={data as never} />));
			assert.equal(host.querySelector('[data-testid="graph-context-body"]'), null, "collapsed by default");
			await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="graph-context-toggle"]')!.click());
			const skill = host.querySelector('[data-testid="graph-context-skill-sk_1"]')!;
			const prop = host.querySelector('[data-testid="graph-context-prop-n_1"]')!;
			for (const [item, count] of [[skill, 2], [prop, 3]] as const) {
				const lines = [...item.querySelectorAll(".lh-prose")];
				assert.equal(lines.length, 2, "a name line and a statement line");
				assert.ok(lines[0]!.classList.contains("font-medium") && lines[1]!.classList.contains("text-muted-foreground"));
				assert.equal(item.querySelectorAll(".katex").length, count);
				assert.ok(!item.textContent!.includes(" — "), "no dash-joined line");
			}
			const body = host.querySelector('[data-testid="graph-context-body"]')!;
			assert.ok(body.textContent!.includes("n_1 → $n_2$"), "a chain line is not rendered");
		} finally {
			await act(async () => root.unmount());
			host.remove();
			for (const key of keys) {
				if (saved[key]) Object.defineProperty(globalThis, key, saved[key]!);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});
});
