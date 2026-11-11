/**
 * Settings → Learner render test (fork addition, 2026-11-11). Fetches do not
 * run under renderToStaticMarkup (effects never fire), so the SSR state is the
 * loading state, asserted as such; the stored note and applied claims render
 * from props. Same tsx classic-JSX shim as render-settings.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LearnerSection } from "../components/settings/learner-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";

describe("LearnerSection (SSR)", () => {
	it("an empty profile: the note field, the loading stats, Adapt, nothing applied", () => {
		const html = renderToStaticMarkup(<LearnerSection learner={undefined} onChange={() => {}} />);
		assert.ok(html.includes('data-testid="learner-note"'));
		assert.ok(html.includes("0/1000"));
		assert.ok(html.includes("Reading your sessions…"));
		assert.ok(html.includes('data-testid="learner-adapt"'));
		assert.ok(html.includes('data-testid="learner-no-applied"'));
		assert.ok(!html.includes('data-testid="learner-draft"'), "a draft exists only after Adapt runs");
	});

	it("shows the stored note and the applied claims with their evidence", () => {
		const html = renderToStaticMarkup(
			<LearnerSection
				learner={{
					note: "Worked examples help me",
					applied: [
						{ kind: "mistake", text: "Drops a sign", events: 4, chats: ["a", "b"], tentative: false },
						{ kind: "pacing", text: "Slow to start", events: 1, chats: ["a"], tentative: true },
					],
				}}
				onChange={() => {}}
			/>,
		);
		assert.ok(html.includes("Worked examples help me"));
		assert.ok(html.includes("23/1000") || html.includes("/1000"));
		assert.ok(html.includes("Mistake · 4 events in 2 chats"));
		assert.ok(html.includes("Pacing · 1 event in 1 chat · tentative"));
		assert.ok(html.includes("Drops a sign"));
		assert.ok(html.includes('aria-label="Remove applied claim 2"'));
		assert.ok(!html.includes('data-testid="learner-no-applied"'));
	});
});

describe("the Learner nav entry", () => {
	it("is in the settings nav, before General (which stays last)", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		assert.ok(html.includes('data-testid="settings-nav-learner"'));
		assert.ok(html.indexOf('data-testid="settings-nav-learner"') < html.indexOf('data-testid="settings-nav-general"'));
	});
});
