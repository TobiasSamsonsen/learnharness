/**
 * The learner profile's stored shape (fork addition, 2026-11-11): the claim
 * parser, the sanitizer's clamp-never-reject side, the section PUT parser and
 * its route registration, and sync portability (the note and the applied
 * claims merge as separate keys).
 *
 * LH_DATA_DIR is set before the first import that loads config.ts, so the app
 * modules are imported dynamically (the difficulty test's discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-"));
process.env.LH_DATA_DIR = TMP_DATA;

const {
	LEARNER_CLAIMS_MAX,
	LEARNER_CLAIM_CHATS_MAX,
	LEARNER_CLAIM_TEXT_MAX,
	LEARNER_NOTE_MAX,
	parseLearnerApplied,
	parseLearnerClaim,
	sanitizeLearner,
} = await import("../src/core/learner.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { applyPortableSettings, mergeFile, portableSettings } = await import("../src/core/sync-merge.ts");
const { SETTINGS_SECTIONS, parseLearnerSettingsBody } = await import("../src/server/settings-body.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const claim = (over: Record<string, unknown> = {}) => ({
	kind: "mistake",
	text: "Drops a sign when moving a term across the equals sign",
	events: 4,
	chats: ["chat_a", "chat_b"],
	tentative: false,
	...over,
});

describe("parseLearnerClaim", () => {
	it("accepts a well-formed claim and trims and de-duplicates", () => {
		const r = parseLearnerClaim(claim({ text: "  padded  ", chats: ["chat_a", " chat_a ", "chat_b"] }));
		assert.ok(r.ok);
		assert.deepEqual(r.claim, { kind: "mistake", text: "padded", events: 4, chats: ["chat_a", "chat_b"], tentative: false });
	});

	it("drops unknown keys", () => {
		const r = parseLearnerClaim(claim({ extra: 1 }));
		assert.ok(r.ok);
		assert.equal("extra" in r.claim, false);
	});

	for (const [name, over] of [
		["an unknown kind", { kind: "style" }],
		["blank text", { text: "   " }],
		["over-long text", { text: "x".repeat(LEARNER_CLAIM_TEXT_MAX + 1) }],
		["zero events", { events: 0 }],
		["fractional events", { events: 1.5 }],
		["chats that are not strings", { chats: [1] }],
		["a blank chat id", { chats: [" "] }],
		["too many chats", { chats: Array.from({ length: LEARNER_CLAIM_CHATS_MAX + 1 }, (_, i) => `c${i}`) }],
		["tentative that is not a boolean", { tentative: "yes" }],
	] as const) {
		it(`rejects ${name}`, () => {
			assert.equal(parseLearnerClaim(claim(over)).ok, false);
		});
	}

	it("rejects a non-object", () => {
		assert.equal(parseLearnerClaim("x").ok, false);
		assert.equal(parseLearnerClaim(null).ok, false);
		assert.equal(parseLearnerClaim([]).ok, false);
	});
});

describe("parseLearnerApplied", () => {
	it("treats an empty list as no claims", () => {
		const r = parseLearnerApplied([]);
		assert.ok(r.ok);
		assert.equal(r.applied, undefined);
	});

	it("rejects more than the cap, a bad claim, and a non-list", () => {
		assert.equal(parseLearnerApplied(Array.from({ length: LEARNER_CLAIMS_MAX + 1 }, () => claim())).ok, false);
		assert.equal(parseLearnerApplied([claim(), claim({ events: 0 })]).ok, false);
		assert.equal(parseLearnerApplied({}).ok, false);
	});
});

describe("sanitizeLearner (the file on disk)", () => {
	it("keeps good claims, drops bad ones, and cuts the extras", () => {
		const out = sanitizeLearner({
			note: "  I like worked examples  ",
			applied: [
				claim(),
				claim({ events: 0 }),
				"junk",
				claim({ chats: Array.from({ length: 20 }, (_, i) => `c${i}`) }),
			],
		});
		assert.equal(out.note, "I like worked examples");
		assert.equal(out.applied?.length, 2);
		assert.equal(out.applied?.[1]?.chats.length, LEARNER_CLAIM_CHATS_MAX);
	});

	it("cuts a long note and caps the claim count", () => {
		const out = sanitizeLearner({
			note: "n".repeat(LEARNER_NOTE_MAX + 50),
			applied: Array.from({ length: LEARNER_CLAIMS_MAX + 5 }, () => claim()),
		});
		assert.equal(out.note?.length, LEARNER_NOTE_MAX);
		assert.equal(out.applied?.length, LEARNER_CLAIMS_MAX);
	});

	it("yields an empty section for junk and drops unknown keys", () => {
		assert.deepEqual(sanitizeLearner({ note: 5, applied: "x", other: 1 }), {});
	});

	it("rides through sanitizeUserSettings and survives a round trip", () => {
		const raw = { version: 1, learner: { note: "visual", applied: [claim()] } };
		const once = sanitizeUserSettings(raw);
		assert.deepEqual(once?.learner, raw.learner);
		assert.deepEqual(sanitizeUserSettings(JSON.parse(JSON.stringify(once)))?.learner, raw.learner);
		// A non-object value is not sanitized into a section: like any unknown key it rides along untouched.
		assert.deepEqual(sanitizeUserSettings({ version: 1, learner: [] })?.learner, []);
	});
});

describe("the learner section PUT parser", () => {
	it("is registered as a settings section", () => {
		assert.equal((SETTINGS_SECTIONS as Record<string, unknown>).learner, parseLearnerSettingsBody);
	});

	it("accepts a note and claims, and treats blank/empty as absent", () => {
		const r = parseLearnerSettingsBody({ note: "  proofs help  ", applied: [claim()] });
		assert.ok(r.ok);
		assert.equal(r.settings.note, "proofs help");
		assert.equal(r.settings.applied?.length, 1);
		const empty = parseLearnerSettingsBody({ note: "   ", applied: [] });
		assert.ok(empty.ok);
		assert.deepEqual(empty.settings, {});
		const clear = parseLearnerSettingsBody({});
		assert.ok(clear.ok);
		assert.deepEqual(clear.settings, {});
	});

	it("rejects bad shapes with a 400 message", () => {
		assert.equal(parseLearnerSettingsBody(null).ok, false);
		assert.equal(parseLearnerSettingsBody([]).ok, false);
		assert.equal(parseLearnerSettingsBody({ note: 3 }).ok, false);
		const tooLong = parseLearnerSettingsBody({ note: "n".repeat(LEARNER_NOTE_MAX + 1) });
		assert.equal(tooLong.ok, false);
		assert.match(tooLong.ok ? "" : tooLong.error, /at most 1000/);
		assert.equal(parseLearnerSettingsBody({ applied: [claim({ kind: "x" })] }).ok, false);
	});

	it("accepts a note of exactly the cap", () => {
		assert.ok(parseLearnerSettingsBody({ note: "n".repeat(LEARNER_NOTE_MAX) }).ok);
	});
});

describe("learner profile sync", () => {
	const settings = { version: 1, general: { language: "no" }, learner: { note: "examples", applied: [claim()] }, dictation: { language: "en" } };

	it("travels with the portable part and applies to another device", () => {
		const out = JSON.parse(portableSettings(JSON.stringify(settings)) ?? "null") as Record<string, unknown>;
		assert.deepEqual(out.learner, settings.learner);
		const local = JSON.stringify({ version: 1, dictation: { language: "nb" } });
		const applied = JSON.parse(applyPortableSettings(local, JSON.stringify(out))) as Record<string, unknown>;
		assert.deepEqual(applied.learner, settings.learner);
		assert.deepEqual(applied.dictation, { language: "nb" });
	});

	it("merges the note and the applied claims as separate keys", () => {
		const base = JSON.stringify({ version: 1, learner: { note: "a", applied: [claim()] } });
		const local = JSON.stringify({ version: 1, learner: { note: "a edited here", applied: [claim()] } });
		const remote = JSON.stringify({ version: 1, learner: { note: "a", applied: [claim({ text: "edited there" })] } });
		const merged = mergeFile({ path: "settings.json", base, local, remote, prefer: "local" });
		const out = JSON.parse(merged.content ?? "null") as { learner: { note: string; applied: Array<{ text: string }> } };
		assert.equal(out.learner.note, "a edited here");
		assert.equal(out.learner.applied[0]?.text, "edited there");
	});
});
