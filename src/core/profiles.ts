import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelProfile, ModelsSettings, ProfilesSettings, UserSettings } from "./settings.ts";

/**
 * Model profiles (fork addition, 2026-11): named sets of the three model slots
 * plus the per-role overrides — models only. PURE — the settings routes apply
 * these to the record, the Agent page describes them from the same data.
 *
 * Invariant (kept server-side by `syncActiveProfile` after every models or
 * agent write): the ACTIVE profile mirrors the live `models` section and
 * `agent.models`, which the engine keeps reading as before. Switching a
 * profile copies its contents into those two places.
 *
 * Built-in "Claude subscription" (was the one-way preset): read-only. Editing a
 * model while it is active forks it into a user profile "Claude subscription
 * (copy)" and the edit lands there. Its extraction-batch and compaction tuning
 * is NOT part of a profile.
 *
 *   strong (prober, teacher, practice)  Sonnet, medium — every learner turn
 *   planner (the planning turn only)    Opus, medium — one turn a lesson, and
 *                                       the whole lesson follows its plan
 *   cheap (researcher, extractor,       Haiku, low — summarizing and
 *          auditor)                     structuring, the most frequent calls
 *   demoBuilder                         Sonnet, low — it writes working code
 *   checker (answer keys)               follows strong (Sonnet)
 *   vision (visual maker, PDF reader,   Sonnet, low — math pages and figures
 *           source-material profiles)
 */

export const DEFAULT_PROFILE_NAME = "Default";
export const CLAUDE_PROFILE_NAME = "Claude subscription";
export const PROFILE_NAME_MAX = 60;

const pick = (id: string, thinkingLevel: ThinkingLevel) => ({ model: { provider: "claude-code", id }, thinkingLevel });

export const BUILTIN_PROFILES: Readonly<Record<string, ModelProfile>> = {
	[CLAUDE_PROFILE_NAME]: {
		models: {
			strong: pick("sonnet", "medium"),
			cheap: pick("haiku", "low"),
			vision: pick("sonnet", "low"),
		},
		roles: {
			planner: pick("opus", "medium"),
			demoBuilder: pick("sonnet", "low"),
		},
	},
};

export type ProfileResult = { ok: true; record: UserSettings } | { ok: false; error: string };

export function isBuiltinProfile(name: string): boolean {
	return Object.hasOwn(BUILTIN_PROFILES, name);
}

function userItems(record: UserSettings | null): Record<string, ModelProfile> {
	return record?.profiles?.items ?? {};
}

/** The live models as a profile snapshot. */
export function liveProfile(record: UserSettings | null): ModelProfile {
	const out: ModelProfile = {};
	if (record?.models && Object.keys(record.models).length) out.models = structuredClone(record.models);
	if (record?.agent?.models && Object.keys(record.agent.models).length) out.roles = structuredClone(record.agent.models);
	return out;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function sameProfile(a: ModelProfile, b: ModelProfile): boolean {
	return canonical({ models: a.models ?? {}, roles: a.roles ?? {} }) === canonical({ models: b.models ?? {}, roles: b.roles ?? {} });
}

/** The profile named `name`: a user profile, else a built-in. */
export function getProfile(record: UserSettings | null, name: string): ModelProfile | null {
	const items = userItems(record);
	if (Object.hasOwn(items, name)) return items[name]!;
	return isBuiltinProfile(name) ? BUILTIN_PROFILES[name]! : null;
}

/** The profiles section, with "Default" seeded from the live models when no
 *  saved profile exists yet (or the active name points at nothing). Pure. */
export function ensureProfiles(record: UserSettings | null): ProfilesSettings {
	const items = { ...userItems(record) };
	let active = record?.profiles?.active;
	if (!active || (!Object.hasOwn(items, active) && !isBuiltinProfile(active))) {
		active = Object.keys(items)[0] ?? DEFAULT_PROFILE_NAME;
	}
	if (active === DEFAULT_PROFILE_NAME && !Object.hasOwn(items, DEFAULT_PROFILE_NAME)) {
		items[DEFAULT_PROFILE_NAME] = liveProfile(record);
	}
	return { active, items };
}

export function activeProfileName(record: UserSettings | null): string {
	return ensureProfiles(record).active!;
}

/** The names for the switcher: user profiles in saved order, then built-ins. */
export function profileList(record: UserSettings | null): { name: string; builtin: boolean }[] {
	const { items } = ensureProfiles(record);
	return [
		...Object.keys(items ?? {}).map((name) => ({ name, builtin: false })),
		...Object.keys(BUILTIN_PROFILES).map((name) => ({ name, builtin: true })),
	];
}

/** The providers a profile names (slots + roles). */
export function profileProviders(profile: ModelProfile): string[] {
	const out = new Set<string>();
	for (const slot of Object.values(profile.models ?? {})) if (slot?.model) out.add(slot.model.provider);
	for (const role of Object.values(profile.roles ?? {})) if (role?.model) out.add(role.model.provider);
	return [...out];
}

/** Providers the profile uses that are not connected (no key / CLI). Pure. */
export function profileMissingProviders(profile: ModelProfile, available: ReadonlySet<string>): string[] {
	return profileProviders(profile).filter((p) => !available.has(p));
}

/** Validate a new/renamed profile name. Returns the trimmed name or an error. */
export function checkProfileName(record: UserSettings | null, raw: string, except?: string): { ok: true; name: string } | { ok: false; error: string } {
	const name = raw.trim();
	if (!name) return { ok: false, error: "Enter a profile name." };
	if (name.length > PROFILE_NAME_MAX) return { ok: false, error: `Profile names are at most ${PROFILE_NAME_MAX} characters.` };
	const lower = name.toLowerCase();
	const taken = [...Object.keys(ensureProfiles(record).items ?? {}), ...Object.keys(BUILTIN_PROFILES)]
		.filter((n) => n !== except)
		.some((n) => n.toLowerCase() === lower);
	if (taken) return { ok: false, error: `A profile named "${name}" already exists.` };
	return { ok: true, name };
}

function withProfile(record: UserSettings | null, name: string, profile: ModelProfile): UserSettings {
	const r: UserSettings = record ?? { version: 1 };
	const agent = { ...r.agent };
	if (profile.roles && Object.keys(profile.roles).length) agent.models = structuredClone(profile.roles);
	else delete agent.models;
	const next: UserSettings = { ...r, agent, profiles: { ...ensureProfiles(r), active: name } };
	const models: ModelsSettings | undefined = profile.models && Object.keys(profile.models).length ? structuredClone(profile.models) : undefined;
	if (models) next.models = models;
	else delete next.models;
	return next;
}

/** Switch to a profile: its models replace the live ones. Pure. */
export function applyProfile(record: UserSettings | null, name: string): ProfileResult {
	const profile = getProfile(ensureProfilesRecord(record), name);
	if (!profile) return { ok: false, error: `Unknown profile "${name}".` };
	return { ok: true, record: withProfile(ensureProfilesRecord(record), name, profile) };
}

function ensureProfilesRecord(record: UserSettings | null): UserSettings {
	const r: UserSettings = record ?? { version: 1 };
	return { ...r, profiles: ensureProfiles(r) };
}

/** New profile from the live models; becomes active. */
export function createProfile(record: UserSettings | null, raw: string): ProfileResult {
	const checked = checkProfileName(record, raw);
	if (!checked.ok) return checked;
	const base = ensureProfilesRecord(record);
	const profiles = { items: { ...base.profiles!.items, [checked.name]: liveProfile(base) }, active: checked.name };
	return { ok: true, record: { ...base, profiles } };
}

/** Rename a user profile (built-ins cannot be renamed). */
export function renameProfile(record: UserSettings | null, from: string, raw: string): ProfileResult {
	if (isBuiltinProfile(from)) return { ok: false, error: "The built-in profile cannot be renamed." };
	const base = ensureProfilesRecord(record);
	const items = base.profiles!.items!;
	if (!Object.hasOwn(items, from)) return { ok: false, error: `Unknown profile "${from}".` };
	const checked = checkProfileName(base, raw, from);
	if (!checked.ok) return checked;
	const renamed: Record<string, ModelProfile> = {};
	for (const [name, profile] of Object.entries(items)) renamed[name === from ? checked.name : name] = profile;
	const active = base.profiles!.active === from ? checked.name : base.profiles!.active;
	return { ok: true, record: { ...base, profiles: { active, items: renamed } } };
}

/** Delete a user profile. The last user profile cannot go; deleting the active one switches
 *  to "Default" (else the first remaining). */
export function deleteProfile(record: UserSettings | null, name: string): ProfileResult {
	if (isBuiltinProfile(name)) return { ok: false, error: "The built-in profile cannot be deleted." };
	const base = ensureProfilesRecord(record);
	const items = { ...base.profiles!.items! };
	if (!Object.hasOwn(items, name)) return { ok: false, error: `Unknown profile "${name}".` };
	if (Object.keys(items).length <= 1) return { ok: false, error: "The last profile cannot be deleted." };
	delete items[name];
	const profiles = { active: base.profiles!.active, items };
	if (profiles.active !== name) return { ok: true, record: { ...base, profiles } };
	const fallback = Object.hasOwn(items, DEFAULT_PROFILE_NAME) ? DEFAULT_PROFILE_NAME : Object.keys(items)[0]!;
	return applyProfile({ ...base, profiles }, fallback);
}

function uniqueCopyName(record: UserSettings, base: string): string {
	let name = `${base} (copy)`;
	for (let n = 2; !checkProfileName(record, name).ok; n++) name = `${base} (copy ${n})`;
	return name;
}

/** After a write to `models` or `agent.models`: keep the active profile in step with the live
 *  models. A built-in active profile forks into a user copy instead. Unchanged live models
 *  return `next` as is. Pure. */
export function syncActiveProfile(prev: UserSettings | null, next: UserSettings): UserSettings {
	if (sameProfile(liveProfile(prev), liveProfile(next))) return next;
	const base = ensureProfilesRecord(next);
	const profiles = base.profiles!;
	const items = { ...profiles.items };
	let active = profiles.active!;
	if (isBuiltinProfile(active)) active = uniqueCopyName(base, active);
	items[active] = liveProfile(next);
	return { ...next, profiles: { active, items } };
}
