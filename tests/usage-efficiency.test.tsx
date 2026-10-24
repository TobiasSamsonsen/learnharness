/**
 * Usage efficiency for a Claude plan (fork addition, 2026-10-24): the
 * subscription preset (every model it names exists in the claude-code
 * catalog at a level it supports; merging keeps the rest of the record),
 * and the plan meter's formatting. The live-session transport itself is
 * pinned in claude-code.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { CLAUDE_SUBSCRIPTION_PRESET, withClaudeSubscriptionPreset } from "../src/core/presets.ts";
import { claudeCodeModels } from "../src/agent/claude-code.ts";
import { pct, planUsageHint } from "../components/plan-usage.tsx";

test("every preset model exists in the claude-code catalog at a supported level", () => {
	const catalog = claudeCodeModels();
	const picks = [...Object.values(CLAUDE_SUBSCRIPTION_PRESET.models), ...Object.values(CLAUDE_SUBSCRIPTION_PRESET.roles)];
	for (const p of picks) {
		const model = catalog.find((m) => m.id === p.model.id);
		assert.ok(model, `${p.model.id} is in the catalog`);
		assert.ok(getSupportedThinkingLevels(model).includes(p.thinkingLevel), `${p.model.id} supports ${p.thinkingLevel}`);
	}
});

test("the routing: Sonnet teaches, Opus only plans, Haiku does the cheap tier", () => {
	const { models, roles } = CLAUDE_SUBSCRIPTION_PRESET;
	assert.equal(models.strong.model.id, "claude-sonnet-5-5");
	assert.equal(models.cheap.model.id, "claude-haiku-5-5");
	assert.equal(roles.planner.model.id, "claude-opus-5-5");
	const opusUses = [...Object.values(models), ...Object.values(roles)].filter((p) => p.model.id.includes("opus"));
	assert.equal(opusUses.length, 1, "Opus appears exactly once: the planning turn");
});

test("applying the preset keeps every other setting", () => {
	const merged = withClaudeSubscriptionPreset({
		version: 1,
		general: { language: "nb" },
		agent: { tools: { demo: false }, models: { researcher: { thinkingLevel: "high" } } },
		graph: { enabled: false },
	});
	assert.equal(merged.general?.language, "nb");
	assert.deepEqual(merged.agent?.tools, { demo: false });
	assert.equal(merged.agent?.models?.researcher?.thinkingLevel, "high", "a role the preset doesn't set is kept");
	assert.equal(merged.agent?.models?.planner?.model?.id, "claude-opus-5-5");
	assert.equal(merged.graph?.enabled, false);
	assert.equal(merged.graph?.extractionChunkTokens, 12_288);
	assert.equal(merged.compaction?.thresholdTokens, 100_000);
	assert.equal(withClaudeSubscriptionPreset(null).models?.strong?.model?.id, "claude-sonnet-5-5", "a first-boot record works too");
});

test("the plan meter's text", () => {
	const now = Date.parse("2026-10-24T12:00:00Z");
	assert.equal(pct({ utilization: 0.584, resetsAt: 0 }), "58%");
	assert.equal(
		planUsageHint({ fiveHour: { utilization: 0.58, resetsAt: now + 45 * 60_000 }, sevenDay: { utilization: 0.34, resetsAt: now + 3 * 86_400_000 }, at: now }, now),
		"Claude plan usage — 5-hour window 58% (resets in 45 min) · week 34% (resets in 3 days)",
	);
});
