import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateClaudeCodeModelId, sanitizeUserSettings } from "../src/core/settings.ts";

// Fork additions for the move to upstream's Claude Code provider (2026-10-29): saved settings from before the merge
// keep their model picks (the CLI aliases replace the dated ids). The opt-in itself stays upstream's: off until the
// user switches it on (an existing install does that once in Settings; the Android first run writes it after sign-in).

test("a saved pick of a dated Claude Code model maps onto the CLI alias of its family; other providers are untouched", () => {
	assert.equal(migrateClaudeCodeModelId("claude-code", "claude-sonnet-5-5"), "sonnet");
	assert.equal(migrateClaudeCodeModelId("claude-code", "claude-opus-4-8"), "opus");
	assert.equal(migrateClaudeCodeModelId("claude-code", "claude-haiku-5-5"), "haiku");
	assert.equal(migrateClaudeCodeModelId("claude-code", "sonnet"), "sonnet");
	assert.equal(migrateClaudeCodeModelId("claude-code", "something-else"), "something-else");
	assert.equal(migrateClaudeCodeModelId("anthropic", "claude-sonnet-5-5"), "claude-sonnet-5-5");
});

test("settings read from disk are migrated: slots and role pins", () => {
	const settings = sanitizeUserSettings({
		version: 1,
		models: { strong: { model: { provider: "claude-code", id: "claude-sonnet-5-5" } } },
		agent: { models: { planner: { model: { provider: "claude-code", id: "claude-opus-5-5" } } } },
	});
	assert.equal(settings?.models?.strong?.model?.id, "sonnet");
	assert.equal(settings?.agent?.models?.planner?.model?.id, "opus");
});
