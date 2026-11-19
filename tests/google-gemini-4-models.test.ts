import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { piModels } from "../src/agent/models.ts";
import { GEMINI_4_MODELS, withGeminiFourModels } from "../src/agent/google-gemini-4.ts";
import { usesGoogleThinkingLevel } from "@earendil-works/pi-ai/api/google-shared";

describe("Gemini 4 Hydrogen and Neon on the google provider", () => {
	it("are in the catalog next to the models pi-ai ships", () => {
		const ids = piModels().getModels("google").map((m) => m.id);
		assert.ok(ids.includes("gemini-4-hydrogen"));
		assert.ok(ids.includes("gemini-4-neon"));
		assert.ok(ids.includes("gemini-2.5-flash"));
		assert.equal(new Set(ids).size, ids.length);
	});

	it("resolve through getModel with the official prices", () => {
		const hydrogen = piModels().getModel("google", "gemini-4-hydrogen");
		const neon = piModels().getModel("google", "gemini-4-neon");
		assert.deepEqual(hydrogen?.cost, { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 });
		assert.deepEqual(neon?.cost, { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 });
	});

	it("offer low, medium and high only, with no off, minimal or xhigh", () => {
		for (const id of ["gemini-4-hydrogen", "gemini-4-neon"]) {
			const model = piModels().getModel("google", id);
			assert.ok(model);
			assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high"]);
		}
	});

	it("use the thinkingLevel request path, never thinkingBudget", () => {
		for (const model of GEMINI_4_MODELS) assert.equal(usesGoogleThinkingLevel(model), true);
	});

	it("yield to an entry the catalog already has", () => {
		const own = { ...GEMINI_4_MODELS[0]!, name: "From pi-ai" };
		const provider = withGeminiFourModels({ getModels: () => [own], getAllModels: () => [own] } as never) as unknown as { getModels(): { id: string; name: string }[] };
		const hydrogen = provider.getModels().filter((m) => m.id === "gemini-4-hydrogen");
		assert.equal(hydrogen.length, 1);
		assert.equal(hydrogen[0]!.name, "From pi-ai");
	});
});
