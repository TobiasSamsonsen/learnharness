import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatsBar } from "../components/stats-bar.tsx";
import { LanguageControl } from "../components/language-control.tsx";
import { Composer } from "../components/composer.tsx";
import { LanguageSection } from "../components/settings/language-section.tsx";

// The lesson-language surfaces (fork addition, 2026-10-24): the language
// control (on the composer shell's edge since 2026-10-25), and Settings → General's language +
// dictation groups. Server render = the first paint, before any fetch.

describe("lesson language — render", () => {
	it("the declutter (2026-10-25): language and sources ride the composer's edge; the stats bar keeps the model", () => {
		const bar = renderToStaticMarkup(<StatsBar turns={[]} />);
		assert.match(bar, /data-testid="model-control"/);
		assert.doesNotMatch(bar, /data-testid="language-control"|data-testid="materials-control"|data-testid="dictation-toggle"/);
		const composer = renderToStaticMarkup(
			<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} edge={{ mic: <span data-testid="mic" /> }} />,
		);
		assert.match(
			composer,
			/<textarea[\s\S]*data-testid="composer-edge"[\s\S]*data-testid="stats-materials"[\s\S]*data-testid="stats-language"[\s\S]*data-testid="mic"[\s\S]*aria-label="Send"/,
			"textarea, then the edge: sources, language, the mic, send",
		);
		const plain = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} />);
		assert.doesNotMatch(plain, /composer-edge/, "no edge unless asked for");
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
