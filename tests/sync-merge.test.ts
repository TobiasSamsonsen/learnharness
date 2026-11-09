/**
 * GitHub sync, the merge rules (src/core/sync-merge.ts). Pinned: messages are
 * append-only so one copy is normally a prefix of the other; a chat continued
 * on both devices keeps the newer and saves the other; deleted graph ids stay
 * deleted; a delete against an edit keeps the edit; settings travel only their
 * portable part; every loser is returned for a .conflict copy, never dropped.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPortableSettings, mergeFile, portableSettings, type MergeInput } from "../src/core/sync-merge.ts";

const j = (v: unknown) => JSON.stringify(v, null, "\t");
const lines = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const merge = (path: string, p: Partial<MergeInput> & { local: string | null; remote: string | null }) =>
	mergeFile({ path, base: null, prefer: "local", ...p });
const parse = (text: string | null) => JSON.parse(text ?? "null") as Record<string, unknown>;

const msg = (id: string) => ({ id, role: "user", content: id, timestamp: 1 });
const chat = (over: Record<string, unknown>) => ({
	id: "chat_1",
	title: "T",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	messages: [],
	version: 1,
	...over,
});

describe("mergeFile: shared rules", () => {
	it("is a no-op for identical copies", () => {
		const r = merge("chats/a.json", { local: "x", remote: "x" });
		assert.equal(r.content, "x");
		assert.equal(r.loser, null);
	});

	it("keeps the edited copy against a delete, on either side", () => {
		for (const path of ["chats/a.json", "courses/c.json", "materials/c/index.json", "prompts/x.md"]) {
			assert.equal(merge(path, { local: null, remote: "edited" }).content, "edited", path);
			assert.equal(merge(path, { local: "edited", remote: null }).content, "edited", path);
		}
	});

	it("falls back to the preferred copy, keeping the other, for files with no rule", () => {
		const r = merge("prompts/system-prompt.md", { local: "mine", remote: "theirs", prefer: "remote" });
		assert.equal(r.content, "theirs");
		assert.equal(r.loser, "mine");
	});
});

describe("mergeFile: chats", () => {
	it("takes the longer message list when one is a prefix of the other, and unions the usage log", () => {
		const local = chat({ updatedAt: "2026-01-02T00:00:00Z", messages: [msg("m1"), msg("m2")], turns: [{ id: "t1", at: "1" }] });
		const remote = chat({ updatedAt: "2026-01-03T00:00:00Z", messages: [msg("m1"), msg("m2"), msg("m3")], turns: [{ id: "t2", at: "2" }] });
		const r = merge("chats/chat_1.json", { local: j(local), remote: j(remote) });
		const out = parse(r.content);
		assert.deepEqual((out.messages as { id: string }[]).map((m) => m.id), ["m1", "m2", "m3"]);
		assert.deepEqual((out.turns as { id: string }[]).map((t) => t.id), ["t1", "t2"]);
		assert.equal(out.updatedAt, "2026-01-03T00:00:00Z");
		assert.equal(r.loser, null);
	});

	it("keeps the newer chat whole when both devices continued it, and returns the other as the loser", () => {
		const local = chat({ updatedAt: "2026-01-02T00:00:00Z", messages: [msg("m1"), msg("a")] });
		const remote = chat({ updatedAt: "2026-01-03T00:00:00Z", messages: [msg("m1"), msg("b")] });
		const r = merge("chats/chat_1.json", { local: j(local), remote: j(remote) });
		assert.deepEqual((parse(r.content).messages as { id: string }[]).map((m) => m.id), ["m1", "b"]);
		assert.equal(r.loser, j(local));
		assert.match(r.notes.join(" "), /both devices/);
	});

	it("takes a title changed on one side only, even though a rename does not bump updatedAt", () => {
		const base = chat({ title: "Old", messages: [msg("m1")] });
		const local = chat({ title: "Renamed here", messages: [msg("m1")] });
		const remote = chat({ title: "Old", updatedAt: "2026-02-01T00:00:00Z", messages: [msg("m1"), msg("m2")] });
		const r = merge("chats/chat_1.json", { base: j(base), local: j(local), remote: j(remote) });
		const out = parse(r.content);
		assert.equal(out.title, "Renamed here");
		assert.equal((out.messages as unknown[]).length, 2);
		assert.equal(r.loser, null);
	});

	it("keeps the newer title and the other copy when both renamed it", () => {
		const base = chat({ title: "Old" });
		const local = chat({ title: "A" });
		const remote = chat({ title: "B", updatedAt: "2026-02-01T00:00:00Z" });
		const r = merge("chats/chat_1.json", { base: j(base), local: j(local), remote: j(remote) });
		assert.equal(parse(r.content).title, "B");
		assert.equal(r.loser, j(local));
	});

	it("unions clarify threads by id and their entries by entry id", () => {
		const t = (entries: unknown[]) => ({ id: "th1", anchor: {}, quote: "q", startedAt: "s", entries });
		const local = chat({ clarifyThreads: [t([{ id: "e1", at: "1" }])] });
		const remote = chat({ clarifyThreads: [t([{ id: "e1", at: "1" }, { id: "e2", at: "2" }])] });
		const out = parse(merge("chats/chat_1.json", { local: j(local), remote: j(remote) }).content);
		assert.equal(((out.clarifyThreads as { entries: unknown[] }[])[0] as { entries: unknown[] }).entries.length, 2);
	});

	it("leaves a chat from a newer app version alone", () => {
		const r = merge("chats/chat_1.json", { local: j(chat({})), remote: j(chat({ version: 2, title: "x" })) });
		assert.ok(r.skipped);
	});

	it("falls back to the preferred copy for unreadable JSON", () => {
		const r = merge("chats/chat_1.json", { local: "{torn", remote: j(chat({})), prefer: "remote" });
		assert.equal(r.content, j(chat({})));
		assert.equal(r.loser, "{torn");
	});
});

describe("mergeFile: courses", () => {
	const course = (over: Record<string, unknown>) => ({
		id: "course_1",
		title: "C",
		createdAt: "1",
		updatedAt: "2026-01-01T00:00:00Z",
		status: "draft",
		skills: [],
		version: 1,
		...over,
	});

	it("takes a title edit from one device and an approval from the other", () => {
		const base = course({});
		const local = course({ title: "New title", updatedAt: "2026-01-02T00:00:00Z" });
		const remote = course({ status: "active", skills: ["sk_1"], updatedAt: "2026-01-03T00:00:00Z" });
		const r = merge("courses/course_1.json", { base: j(base), local: j(local), remote: j(remote) });
		const out = parse(r.content);
		assert.equal(out.title, "New title");
		assert.equal(out.status, "active");
		assert.deepEqual(out.skills, ["sk_1"]);
		assert.equal(out.updatedAt, "2026-01-03T00:00:00Z");
		assert.equal(r.loser, null);
	});

	it("keeps the newer approval state when both approved, and returns the other", () => {
		const base = course({});
		const local = course({ status: "active", skills: ["a"], updatedAt: "2026-01-02T00:00:00Z" });
		const remote = course({ status: "active", skills: ["b"], updatedAt: "2026-01-03T00:00:00Z" });
		const r = merge("courses/course_1.json", { base: j(base), local: j(local), remote: j(remote) });
		assert.deepEqual(parse(r.content).skills, ["b"]);
		assert.equal(r.loser, j(local));
	});

	it("keeps a default pace set on one device only, when the base had none", () => {
		const base = course({});
		const local = course({ pace: "crash", updatedAt: "2026-01-02T00:00:00Z" });
		const remote = course({ status: "active", skills: ["sk_1"], updatedAt: "2026-01-03T00:00:00Z" });
		const out = parse(merge("courses/course_1.json", { base: j(base), local: j(local), remote: j(remote) }).content);
		assert.equal(out.pace, "crash");
		assert.equal(out.status, "active");
	});

	it("unions draft usage by startedAt", () => {
		const local = course({ drafts: [{ startedAt: "1" }] });
		const remote = course({ drafts: [{ startedAt: "1" }, { startedAt: "2" }] });
		assert.equal((parse(merge("courses/course_1.json", { local: j(local), remote: j(remote) }).content).drafts as unknown[]).length, 2);
	});
});

describe("mergeFile: graph ledgers", () => {
	const node = (id: string, over: Record<string, unknown> = {}) => ({
		id,
		name: id,
		statement: "s",
		aliases: [],
		createdAt: "2026-01-01T00:00:00Z",
		provenance: [],
		...over,
	});

	it("is a plain union when there is no base, each line once", () => {
		const a = node("n_a");
		const b = node("n_b");
		const c = node("n_c");
		const r = merge("graph/nodes.jsonl", { local: lines(a, b), remote: lines(b, c) });
		assert.deepEqual(r.content?.trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id), ["n_a", "n_b", "n_c"]);
	});

	it("keeps a deleted node deleted even when the other side added a link line to it", () => {
		const keep = node("n_keep");
		const dead = node("n_dead");
		const base = lines(keep, dead);
		const local = lines(keep); // deleted n_dead
		const remote = lines(keep, dead, node("n_dead", { aliases: ["alias"] }), node("n_new")); // linked it, added another
		const r = merge("graph/nodes.jsonl", { base, local, remote });
		const ids = r.content?.trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id);
		assert.deepEqual(ids, ["n_keep", "n_new"]);
		assert.match(r.notes.join(" "), /stayed deleted/);
	});

	it("takes the stripped line a source deletion left, not the original it replaced", () => {
		const original = node("n_a", { provenance: [{ chatId: "c1", messageId: "m1" }, { chatId: "c2", messageId: "m2" }] });
		const stripped = node("n_a", { provenance: [{ chatId: "c2", messageId: "m2" }] });
		const base = lines(original);
		const r = merge("graph/nodes.jsonl", { base, local: lines(stripped), remote: lines(original, node("n_b")) });
		const out = r.content?.trim().split("\n").map((l) => JSON.parse(l) as { id: string; provenance: unknown[] });
		assert.deepEqual(out?.map((x) => x.id), ["n_a", "n_b"]);
		assert.equal(out?.[0]?.provenance.length, 1);
	});

	it("keeps each id's defining (oldest) line first even when a rewritten line is assembled last", () => {
		const create = node("n_a", { createdAt: "2026-01-01T00:00:00Z", name: "first" });
		const link = node("n_a", { createdAt: "2026-01-05T00:00:00Z", name: "later", aliases: ["x"] });
		const stripped = node("n_a", { createdAt: "2026-01-01T00:00:00Z", name: "first", provenance: [] });
		const base = lines(create, link);
		// local rewrote the create line (strip); remote kept both and added nothing
		const r = merge("graph/nodes.jsonl", { base, local: lines(stripped, link), remote: lines(create, link), prefer: "remote" });
		const first = JSON.parse((r.content ?? "").split("\n")[0] ?? "{}") as { name: string };
		assert.equal(first.name, "first");
	});

	it("skips torn lines the way the readers do", () => {
		const r = merge("graph/nodes.jsonl", { local: `${JSON.stringify(node("n_a"))}\n{"id":"n_b","na`, remote: lines(node("n_c")) });
		assert.equal(r.content?.trim().split("\n").length, 2);
	});

	it("keeps the later row per chat in coverage.jsonl", () => {
		const row = (fp: string, foldedAt: string) => ({ chatId: "c1", fp, tokens: 1, foldedAt });
		const r = merge("graph/coverage.jsonl", { local: lines(row("old", "2026-01-01")), remote: lines(row("new", "2026-02-01")) });
		assert.equal((JSON.parse(r.content ?? "") as { fp: string }).fp, "new");
	});

	it("takes the newer positions.json whole and the higher format version", () => {
		const p = (updatedAt: string) => j({ positions: {}, updatedAt });
		assert.equal(merge("graph/positions.json", { local: p("2026-01-01"), remote: p("2026-02-01") }).content, p("2026-02-01"));
		const f = (version: number) => j({ version });
		assert.equal(merge("graph/format.json", { local: f(1), remote: f(2), prefer: "local" }).content, f(2));
	});
});

describe("mergeFile: settings sections", () => {
	it("takes each section from whichever device changed it", () => {
		const base = j({ version: 1, models: { strong: "a" }, graph: { enabled: true } });
		const local = j({ version: 1, models: { strong: "b" }, graph: { enabled: true } });
		const remote = j({ version: 1, models: { strong: "a" }, graph: { enabled: false } });
		const r = merge("settings.json", { base, local, remote });
		const out = parse(r.content);
		assert.deepEqual(out.models, { strong: "b" });
		assert.deepEqual(out.graph, { enabled: false });
		assert.equal(r.loser, null);
	});

	it("goes key by key inside a section, so language and pace merge independently", () => {
		const base = j({ general: { language: "en", pace: "steady" } });
		const local = j({ general: { language: "no", pace: "steady" } });
		const remote = j({ general: { language: "en", pace: "fast" } });
		assert.deepEqual(parse(merge("settings.json", { base, local, remote }).content).general, { language: "no", pace: "fast" });
	});

	it("with no base, keeps a setting only one device has", () => {
		const r = merge("settings.json", { local: j({ version: 1 }), remote: j({ version: 1, models: { strong: "a" } }) });
		assert.deepEqual(parse(r.content).models, { strong: "a" });
		assert.equal(r.loser, null);
	});

	it("keeps the preferred value and returns the other when both changed the same setting", () => {
		const base = j({ models: { strong: "a" } });
		const r = merge("settings.json", { base, local: j({ models: { strong: "b" } }), remote: j({ models: { strong: "c" } }), prefer: "remote" });
		assert.deepEqual(parse(r.content).models, { strong: "c" });
		assert.equal(r.loser, j({ models: { strong: "b" } }));
	});
});

describe("portable settings", () => {
	const full = {
		version: 1,
		general: { language: "no", pace: "fast", dictationEngine: "local", autoUpdate: true },
		models: { strong: { model: { provider: "p", id: "m" } } },
		agent: { tools: { search: false } },
		graph: { enabled: true },
		compaction: { enabled: true },
		customProvider: { baseUrl: "http://localhost:11434" },
		claudeCode: { enabled: true },
		dictation: { language: "en" },
		appearance: { fontFamily: "Inter", mode: "dark" },
		notices: { dismissedUpstreamVersion: "0.4.1" },
		somethingNew: 1,
	};

	it("keeps only the portable part, in a stable order", () => {
		const out = JSON.parse(portableSettings(JSON.stringify(full)) ?? "null") as Record<string, unknown>;
		assert.deepEqual(Object.keys(out), ["agent", "compaction", "general", "graph", "models", "version"]);
		assert.deepEqual(out.general, { language: "no", pace: "fast" });
		// the same settings in another key order give the same bytes
		const shuffled = Object.fromEntries(Object.entries(full).reverse());
		assert.equal(portableSettings(JSON.stringify(shuffled)), portableSettings(JSON.stringify(full)));
	});

	it("applies incoming portable settings without touching this device's own", () => {
		const incoming = portableSettings(JSON.stringify({ version: 1, models: { strong: "new" }, general: { language: "en" } })) as string;
		const local = JSON.stringify(full);
		const out = JSON.parse(applyPortableSettings(local, incoming)) as typeof full & Record<string, unknown>;
		assert.deepEqual(out.models, { strong: "new" });
		assert.equal(out.agent, undefined, "a portable section the other device lacks is removed");
		assert.deepEqual(out.general, { language: "en", dictationEngine: "local", autoUpdate: true });
		assert.deepEqual(out.customProvider, full.customProvider);
		assert.deepEqual(out.claudeCode, full.claudeCode);
		assert.deepEqual(out.appearance, full.appearance);
		assert.equal(out.somethingNew, 1);
	});

	it("creates a settings file from nothing", () => {
		const incoming = portableSettings(JSON.stringify({ version: 1, models: { strong: "x" } })) as string;
		assert.deepEqual(JSON.parse(applyPortableSettings(null, incoming)), { version: 1, models: { strong: "x" } });
	});

	it("reads non-JSON as nothing portable", () => {
		assert.equal(portableSettings("{torn"), null);
	});
});

describe("mergeFile: materials", () => {
	const mat = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "pdf", name: id, file: "source.pdf", bytes: 1, addedAt: "1", status: "ready", ...over });

	it("unions materials added on each device", () => {
		const r = merge("materials/c1/index.json", { local: j([mat("m1")]), remote: j([mat("m2")]) });
		assert.deepEqual((JSON.parse(r.content ?? "[]") as { id: string }[]).map((m) => m.id), ["m1", "m2"]);
	});

	it("keeps the further-along status and a reading profile", () => {
		const local = j([mat("m1", { status: "reading" })]);
		const remote = j([mat("m1", { status: "ready", profile: "# notes" })]);
		const out = JSON.parse(merge("materials/c1/index.json", { local, remote }).content ?? "[]") as Record<string, unknown>[];
		assert.equal(out[0]?.status, "ready");
		assert.equal(out[0]?.profile, "# notes");
	});

	it("drops a material one device removed when the other did not touch it, but keeps it if it was edited", () => {
		const base = j([mat("m1"), mat("m2")]);
		const removedLocally = j([mat("m2")]);
		const untouched = j([mat("m1"), mat("m2", { name: "other change" })]);
		const r1 = merge("materials/c1/index.json", { base, local: removedLocally, remote: untouched });
		assert.deepEqual((JSON.parse(r1.content ?? "[]") as { id: string }[]).map((m) => m.id), ["m2"]);
		const editedRemotely = j([mat("m1", { profile: "edited" }), mat("m2")]);
		const r2 = merge("materials/c1/index.json", { base, local: removedLocally, remote: editedRemotely });
		assert.deepEqual((JSON.parse(r2.content ?? "[]") as { id: string }[]).map((m) => m.id), ["m1", "m2"]);
	});
});
