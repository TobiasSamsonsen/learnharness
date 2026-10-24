import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatsBar } from "../components/stats-bar.tsx";
import { LanguageControl } from "../components/language-control.tsx";
import { LanguageSection } from "../components/settings/language-section.tsx";

// The lesson-language surfaces (fork addition, 2026-10-24): the stats-bar
// pill beside the model control, and Settings → General's language +
// dictation groups. Server render = the first paint, before any fetch.

describe("lesson language — render", () => {
	it("the stats bar carries the language pill next to the model control", () => {
		const html = renderToStaticMarkup(<StatsBar turns={[]} />);
		assert.match(html, /data-testid="language-control"/);
		assert.match(html, /data-testid="stats-language"[\s\S]*data-testid="model-control"/, "language sits before the model");
	});

	it("the pill shows the factory language until the records load", () => {
		const html = renderToStaticMarkup(<LanguageControl chatId="chat_x" />);
		assert.match(html, /aria-label="Lesson language: English"/);
		assert.match(html, /data-testid="stats-language"[^>]*>\s*<span[^>]*>EN<\/span>/);
	});

	it("settings: default language + engine selects reflect the record", () => {
		const html = renderToStaticMarkup(
			<LanguageSection general={{ language: "nb", dictationEngine: "local" }} onChange={() => {}} />,
		);
		assert.match(html, /data-testid="select-default-language"/);
		assert.match(html, /<option value="nb" selected="">Norsk \(bokmål\)<\/option>/);
		assert.match(html, /<option value="local" selected="">Local<\/option>/);
		assert.match(html, /audio never leaves the machine/);
	});

	it("settings: the Deepgram engine explains its key requirement", () => {
		const html = renderToStaticMarkup(<LanguageSection general={{ dictationEngine: "deepgram" }} onChange={() => {}} />);
		assert.match(html, /<option value="deepgram" selected="">/);
		assert.match(html, /needs a Deepgram key/);
		assert.match(html, /<option value="en" selected="">English<\/option>/, "absent language = English");
	});
});
