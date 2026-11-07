import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PracticeSection } from "../components/settings/practice-section.tsx";

describe("Settings → General → Practice: the default problem difficulty", () => {
	const html = (general?: Parameters<typeof PracticeSection>[0]["general"]) => renderToStaticMarkup(<PracticeSection general={general} onChange={() => {}} />);

	it("offers the four levels, Short first, and defaults to Short", () => {
		const out = html();
		assert.match(out, /data-testid="group-practice"/);
		assert.match(out, /data-testid="select-default-difficulty"/);
		for (const label of ["Short", "Medium", "Long", "Exam"]) assert.match(out, new RegExp(`>${label}<`));
		assert.ok(out.indexOf(">Short<") < out.indexOf(">Medium<") && out.indexOf(">Medium<") < out.indexOf(">Long<") && out.indexOf(">Long<") < out.indexOf(">Exam<"));
		assert.match(out, /One skill, about 3 minutes/, "the hint names the current level");
	});

	it("shows the stored default", () => {
		const out = html({ difficulty: "exam" } as never);
		assert.match(out, /Exam-level, four to six skills/);
	});
});
