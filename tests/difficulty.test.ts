/**
 * Problem difficulty (fork addition, 2026-11-07): the pure core, the request
 * parsers and sanitizer, the sync portability, the prompt seam (practice only),
 * the birth stamp and creation request, and the problem tool's skill cap.
 *
 * The routes and stores run under an isolated LH_DATA_DIR, which must be set
 * before the first import that loads config.ts, so the app-module imports
 * below are dynamic (the pace test's discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-difficulty-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { DIFFICULTIES, DEFAULT_DIFFICULTY, difficultySection, isDifficulty, maxSkillsFor, resolveDifficulty } = await import("../src/core/difficulty.ts");
const { languageDirective } = await import("../src/core/language.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { applyPortableSettings, portableSettings } = await import("../src/core/sync-merge.ts");
const { parseGeneralSettingsBody, parseSettingsBody, parseDifficultyField } = await import("../src/server/settings-body.ts");
const { createTeacherAgent, createPracticeAgent, createProberAgent } = await import("../src/agent/teacher-agent.ts");
const { problemTool, practiceTools } = await import("../src/agent/tools/practice.ts");
const { POST } = await import("../app/api/chats/route.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("the difficulty core", () => {
	it("defaults to Short, lists four levels, and resolves a missing stamp to Short", () => {
		assert.equal(DEFAULT_DIFFICULTY, "short");
		assert.deepEqual(DIFFICULTIES.map((d) => d.id), ["short", "medium", "long", "exam"]);
		assert.equal(resolveDifficulty(undefined), "short");
		assert.equal(resolveDifficulty({}), "short");
		assert.equal(resolveDifficulty({ difficulty: "long" }), "long");
		assert.ok(isDifficulty("exam") && !isDifficulty("hard") && !isDifficulty(undefined));
	});

	it("caps the skills per problem at each level", () => {
		assert.equal(maxSkillsFor("short"), 1);
		assert.equal(maxSkillsFor("medium"), 2);
		assert.equal(maxSkillsFor("long"), 4);
		assert.equal(maxSkillsFor("exam"), 6);
	});

	it("each level's section names the level, its minutes, and the one-question rule", () => {
		for (const d of DIFFICULTIES) {
			const section = difficultySection(d.id);
			assert.match(section, /^<difficulty>\n/);
			assert.match(section, /<\/difficulty>$/);
			assert.ok(section.includes(d.label.toUpperCase()), `${d.id} names its label`);
			assert.ok(section.includes(`about ${d.minutes} minutes`), `${d.id} names its minutes`);
			assert.ok(section.includes("ONE question"), `${d.id} says one question`);
		}
		assert.match(difficultySection("short"), /ONE skill/);
		assert.match(difficultySection("exam"), /past exams/);
		assert.doesNotMatch(difficultySection("long"), /past exams/);
	});

	it("a bad value is refused by the request parsers and dropped by the sanitizer", () => {
		assert.deepEqual(parseSettingsBody({ difficulty: "long" }), { ok: true, settings: { difficulty: "long" } });
		const bad = parseSettingsBody({ difficulty: "hard" });
		assert.ok(!bad.ok && /difficulty must be one of: short, medium, long, exam/.test(bad.error));
		assert.ok(!parseDifficultyField(undefined).ok);
		assert.deepEqual(parseGeneralSettingsBody({ difficulty: "exam" }), { ok: true, settings: { difficulty: "exam" } });
		assert.ok(!parseGeneralSettingsBody({ difficulty: 3 }).ok);
		assert.deepEqual(sanitizeUserSettings({ general: { difficulty: "medium", language: "nb" } })?.general, { difficulty: "medium", language: "nb" });
		assert.deepEqual(sanitizeUserSettings({ general: { difficulty: "nope" } })?.general, {});
		assert.equal(resolveSettings(null).general.difficulty, "short");
		assert.equal(resolveSettings({ version: 1, general: { difficulty: "exam" } }).general.difficulty, "exam");
	});

	it("travels between devices like the pace, and only the portable part", () => {
		const full = JSON.stringify({ version: 1, general: { language: "no", pace: "crash", difficulty: "long", dictationEngine: "deepgram" } });
		const portable = JSON.parse(portableSettings(full) ?? "null") as { general: Record<string, unknown> };
		assert.deepEqual(portable.general, { language: "no", pace: "crash", difficulty: "long" });
		const local = JSON.stringify({ version: 1, general: { language: "en", difficulty: "short", dictationEngine: "local" } });
		const applied = JSON.parse(applyPortableSettings(local, JSON.stringify(portable)));
		assert.deepEqual(applied.general, { language: "no", pace: "crash", difficulty: "long", dictationEngine: "local" });
	});
});

describe("the prompt seam: only the practice agent is sized", () => {
	const engine = () => {
		const faux = createFauxCore({});
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	};

	it("the practice prompt ends with the difficulty section, then the language directive", () => {
		const prompt = createPracticeAgent({ chatId: "chat_x", chatStore: undefined as never } as never, { engine: engine(), tools: {}, difficulty: "long" }).state.systemPrompt;
		const section = difficultySection("long");
		assert.ok(prompt.includes(section));
		assert.ok(prompt.endsWith(`${section}\n\n${languageDirective("en", "conversation")}`));
	});

	it("a practice prompt without a difficulty has no section", () => {
		const bare = createPracticeAgent({ chatId: "chat_x", chatStore: undefined as never } as never, { engine: engine(), tools: {} }).state.systemPrompt;
		const exam = createPracticeAgent({ chatId: "chat_x", chatStore: undefined as never } as never, { engine: engine(), tools: {}, difficulty: "exam" }).state.systemPrompt;
		assert.notEqual(exam, bare);
		assert.doesNotMatch(bare, /<difficulty>/);
	});

	it("the teacher and the prober never get the section", () => {
		const teacherNone = createTeacherAgent(undefined, { engine: engine() }).state.systemPrompt;
		assert.equal(createTeacherAgent(undefined, { engine: engine(), difficulty: "exam" }).state.systemPrompt, teacherNone);
		const proberNone = createProberAgent({ chatId: "chat_x", chatStore: undefined as never, deliver: () => {} } as never, { engine: engine() }).state.systemPrompt;
		const proberExam = createProberAgent({ chatId: "chat_x", chatStore: undefined as never, deliver: () => {} } as never, { engine: engine(), difficulty: "exam" }).state.systemPrompt;
		assert.equal(proberExam, proberNone);
		assert.doesNotMatch(proberExam, /<difficulty>/);
	});
});

describe("the problem tool's skill cap (course sessions)", () => {
	const skills = () => ["a", "b", "c", "d", "e", "f"].map((id) => ({ id: `sk_${id}`, name: `Skill ${id}` }));
	const pose = { statement: "S", mode: "recall", modelSolution: "M" };
	const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("");
	const tagged = (n: number) => skills().slice(0, n).map((s) => s.id);

	it("rejects two tags at Short, and accepts one", async () => {
		const gate = { problemActive: false };
		const tool = problemTool(gate, undefined, skills, "short");
		const over = await tool.execute("t1", { ...pose, skills: tagged(2) } as never);
		assert.match(text(over), /difficulty is Short: tag at most 1 skill\(s\) per problem \(you tagged 2\)/);
		assert.equal(gate.problemActive, false);
		await tool.execute("t2", { ...pose, skills: tagged(1) } as never);
		assert.equal(gate.problemActive, true);
	});

	it("rejects five tags at Long, and accepts four", async () => {
		const over = await problemTool({ problemActive: false }, undefined, skills, "long").execute("t3", { ...pose, skills: tagged(5) } as never);
		assert.match(text(over), /difficulty is Long: tag at most 4 skill\(s\) per problem \(you tagged 5\)/);
		const gate = { problemActive: false };
		const ok = await problemTool(gate, undefined, skills, "long").execute("t4", { ...pose, skills: tagged(4) } as never);
		assert.doesNotMatch(text(ok), /difficulty/);
		assert.equal(gate.problemActive, true);
	});

	it("accepts any count when no difficulty is given, and the registry wires it through", async () => {
		const gate = { problemActive: false };
		await problemTool(gate, undefined, skills).execute("t5", { ...pose, skills: tagged(5) } as never);
		assert.equal(gate.problemActive, true);
		const tools = practiceTools({ chatId: "x", chatStore: { getChat: () => ({ messages: [] }) }, courseSkills: skills, difficulty: "short" });
		const wired = await tools.problem!.execute("t6", { ...pose, skills: tagged(2) } as never);
		assert.match(text(wired), /difficulty is Short/);
	});
});

describe("the birth stamp and the creation request", () => {
	const post = (body: unknown) =>
		POST(new Request("http://test/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

	it("a new session is stamped Short by default, and from the default (general.difficulty) once one is set", async () => {
		writeSettings({ version: 1 });
		const first = (await (await post({ title: "limits" })).json()) as { id: string };
		assert.equal(chatStore.getChat(first.id)?.settings?.difficulty, "short");
		writeSettings({ version: 1, general: { difficulty: "long" } });
		const second = (await (await post({ title: "limits again" })).json()) as { id: string };
		assert.equal(chatStore.getChat(second.id)?.settings?.difficulty, "long");
		assert.equal(chatStore.getChat(first.id)?.settings?.difficulty, "short", "a later default never reaches an existing session");
	});

	it("a bad difficulty is refused before any session exists", async () => {
		const before = chatStore.listChats().length;
		assert.equal((await post({ title: "x", difficulty: "hard" })).status, 400);
		assert.equal(chatStore.listChats().length, before, "no orphan chat");
	});
});
