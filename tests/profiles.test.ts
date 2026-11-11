import test from "node:test";
import assert from "node:assert/strict";
import {
	CLAUDE_PROFILE_NAME,
	DEFAULT_PROFILE_NAME,
	activeProfileName,
	applyProfile,
	createProfile,
	deleteProfile,
	profileList,
	profileMissingProviders,
	renameProfile,
	sanitizeUserSettings,
	syncActiveProfile,
	type UserSettings,
} from "../src/core/index.ts";

const m = (provider: string, id: string) => ({ model: { provider, id } });
const base = (): UserSettings => ({
	version: 1,
	models: { strong: m("anthropic", "a"), cheap: m("openai", "b") },
	agent: { tools: { demo: false }, models: { planner: m("anthropic", "c") } },
});

test("no profiles yet: Default is seeded from the live models", () => {
	assert.equal(activeProfileName(base()), DEFAULT_PROFILE_NAME);
	assert.deepEqual(profileList(base()), [{ name: "Default", builtin: false }, { name: CLAUDE_PROFILE_NAME, builtin: true }]);
});

test("create, switch, and the active profile mirrors later edits", () => {
	const created = createProfile(base(), "Work");
	assert.ok(created.ok);
	assert.equal(created.record.profiles?.active, "Work");
	const edited = { ...created.record, models: { strong: m("google", "z") } };
	const synced = syncActiveProfile(created.record, edited);
	assert.equal(synced.profiles?.items?.Work?.models?.strong?.model?.id, "z");
	assert.equal(synced.profiles?.items?.Default?.models?.strong?.model?.id, "a", "other profiles untouched");
	const back = applyProfile(synced, "Default");
	assert.ok(back.ok);
	assert.equal(back.record.models?.strong?.model?.id, "a");
	assert.equal(back.record.agent?.models?.planner?.model?.id, "c");
	assert.deepEqual(back.record.agent?.tools, { demo: false }, "non-model agent settings kept");
});

test("editing under the built-in profile forks a copy", () => {
	const applied = applyProfile(base(), CLAUDE_PROFILE_NAME);
	assert.ok(applied.ok);
	const edited = { ...applied.record, models: { ...applied.record.models, cheap: m("openai", "q") } };
	const synced = syncActiveProfile(applied.record, edited);
	assert.equal(synced.profiles?.active, `${CLAUDE_PROFILE_NAME} (copy)`);
	assert.equal(synced.profiles?.items?.[`${CLAUDE_PROFILE_NAME} (copy)`]?.models?.cheap?.model?.id, "q");
	assert.equal(applyProfile(synced, CLAUDE_PROFILE_NAME).ok, true);
	const unchanged = syncActiveProfile(applied.record, applied.record);
	assert.equal(unchanged, applied.record, "no change, no fork");
});

test("names: unique, non-empty, built-in reserved; rename and delete rules", () => {
	assert.equal(createProfile(base(), "  ").ok, false);
	assert.equal(createProfile(base(), CLAUDE_PROFILE_NAME.toLowerCase()).ok, false);
	assert.equal(createProfile(base(), "default").ok, false);
	const two = createProfile(base(), "Work");
	assert.ok(two.ok);
	assert.equal(renameProfile(two.record, CLAUDE_PROFILE_NAME, "x").ok, false);
	const renamed = renameProfile(two.record, "Work", "Study");
	assert.ok(renamed.ok);
	assert.equal(renamed.record.profiles?.active, "Study");
	const deleted = deleteProfile(renamed.record, "Study");
	assert.ok(deleted.ok);
	assert.equal(deleted.record.profiles?.active, "Default");
	assert.equal(deleted.record.models?.strong?.model?.id, "a");
	assert.equal(deleteProfile(deleted.record, "Default").ok, false, "last profile stays");
	assert.equal(deleteProfile(deleted.record, CLAUDE_PROFILE_NAME).ok, false);
});

test("missing providers are reported, never blocking", () => {
	const applied = applyProfile(base(), CLAUDE_PROFILE_NAME);
	assert.ok(applied.ok);
	const profile = { models: applied.record.models };
	assert.deepEqual(profileMissingProviders(profile, new Set(["anthropic"])), ["claude-code"]);
	assert.deepEqual(profileMissingProviders(profile, new Set(["claude-code"])), []);
});

test("the profiles section survives the sanitizer", () => {
	const created = createProfile(base(), "Work");
	assert.ok(created.ok);
	const clean = sanitizeUserSettings(JSON.parse(JSON.stringify({ ...created.record, profiles: { ...created.record.profiles, junk: 1 } })));
	assert.equal(clean?.profiles?.active, "Work");
	assert.equal(clean?.profiles?.items?.Work?.roles?.planner?.model?.id, "c");
});
