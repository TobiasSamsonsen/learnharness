import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PaceSection } from "../components/settings/pace-section.tsx";

describe("Settings → General → Pace: the default lesson pace", () => {
	const html = (general?: Parameters<typeof PaceSection>[0]["general"]) => renderToStaticMarkup(<PaceSection general={general} onChange={() => {}} />);

	it("offers the three levels, Thorough first, and defaults to Thorough", () => {
		const out = html();
		assert.match(out, /data-testid="group-pace"/);
		assert.match(out, /data-testid="select-default-pace"/);
		for (const label of ["Thorough", "Efficient", "Crash course"]) assert.match(out, new RegExp(`>${label}<`));
		assert.ok(out.indexOf(">Thorough<") < out.indexOf(">Efficient<") && out.indexOf(">Efficient<") < out.indexOf(">Crash course<"));
		assert.match(out, /Mastery before moving on/, "the hint names the current level");
	});

	it("shows the stored default", () => {
		const out = html({ pace: "crash" } as never);
		assert.match(out, /Key idea and procedure per concept/);
	});
});
