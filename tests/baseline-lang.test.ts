/**
 * The tutor baseline's language-dependent parts (scripts/baseline-lang.ts): the scripted learner's lines, the
 * praise/filler counter, the English-leak estimate, the tutor-prose extraction and the --compare table.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { countFiller, englishLeak, formatComparison, learnerLines, sentencesOf, stripNonProse, tutorProse } from "../scripts/baseline-lang.ts";

describe("learnerLines", () => {
	test("the en table is the original hard-coded text, so old runs stay comparable", () => {
		const en = learnerLines("en");
		assert.equal(en.defaultTopic, "the epsilon-delta definition of a limit");
		assert.equal(en.opening("X"), "I want to learn X.");
		assert.equal(en.start, "Looks good, let's start.");
		assert.equal(en.confused, "I picked it, but honestly I do not understand why it is true. I am not sure what this means.");
		assert.equal(en.guessing, "I am guessing here.");
		assert.equal(en.followsFromSaid, "That follows from what was said.");
		assert.equal(en.planOk, "ok");
		assert.equal(en.yesGoOn, "Yes, go on.");
		assert.equal(en.wrongExplain, "I think it is the other way round, but I cannot say why.");
		assert.equal(en.bestAttempt, "My best attempt.");
	});

	test("nb has a line for every field the en table has", () => {
		const en = learnerLines("en");
		const nb = learnerLines("nb");
		for (const key of Object.keys(en) as Array<keyof typeof en>) {
			assert.ok(key in nb, `nb is missing ${key}`);
			if (key !== "opening") assert.ok(String(nb[key]).length > 0, `nb ${key} is empty`);
		}
		assert.equal(nb.opening("grenseverdier"), "Jeg vil lære grenseverdier.");
		assert.notEqual(nb.confused, en.confused);
	});

	test("an unknown language is refused with the languages it has", () => {
		assert.throws(() => learnerLines("sv"), /no learner lines for language "sv" \(have: en, nb\)/);
	});
});

describe("countFiller", () => {
	test("counts whole-word praise and does not count a phrase twice", () => {
		const r = countFiller(["Great question! That is excellent.", "Nice work."], "en");
		assert.equal(r.total, 3);
		assert.deepEqual(r.byTerm, { "great question": 1, excellent: 1, "nice work": 1 });
	});

	test("matches Norwegian terms, including æøå, ignoring case", () => {
		const r = countFiller(["Flott! Bra jobbet. Dette er et godt spørsmål.", "STRÅLENDE."], "nb");
		assert.equal(r.total, 4);
		assert.deepEqual(r.byTerm, { flott: 1, "bra jobbet": 1, "godt spørsmål": 1, strålende: 1 });
	});

	test("a longer word that merely contains a term is not a hit", () => {
		assert.equal(countFiller(["Det er en flottere løsning, og perfektsjonisme er noe annet."], "nb").total, 0);
		assert.equal(countFiller(["Greatly different."], "en").total, 0);
	});

	test("a language without a list counts nothing", () => {
		assert.deepEqual(countFiller(["Great!"], "sv"), { total: 0, byTerm: {} });
	});
});

describe("englishLeak", () => {
	test("is null unless the lesson is nb", () => {
		assert.equal(englishLeak(["The limit exists because the function is close."], "en"), null);
	});

	test("flags an English sentence and not a Norwegian one", () => {
		const r = englishLeak(["The limit exists because the function is close to the value.", "Grensen finnes fordi funksjonen er nær verdien som vi ser på."], "nb");
		assert.ok(r);
		assert.equal(r.sentences, 2);
		assert.equal(r.flagged, 1);
		assert.equal(r.share, 0.5);
		assert.deepEqual(r.samples, ["The limit exists because the function is close to the value."]);
	});

	test("code, math and links do not count, and sentences under five words are skipped", () => {
		const r = englishLeak(["Vi bruker $\\varepsilon$ og $\\delta$ for å vise det.\n```\nif x is not the value then return it\n```\nSe https://example.com/the-limit-of-it.", "It is the limit."], "nb");
		assert.ok(r);
		assert.equal(r.flagged, 0);
		assert.equal(r.sentences, 1);
	});

	test("no judgeable sentence gives a null share", () => {
		const r = englishLeak(["Ok."], "nb");
		assert.ok(r);
		assert.equal(r.sentences, 0);
		assert.equal(r.share, null);
	});

	test("keeps at most five samples", () => {
		const s = "The limit exists because the function is close to the value.";
		const r = englishLeak([Array(8).fill(s).join(" ")], "nb");
		assert.ok(r);
		assert.equal(r.flagged, 8);
		assert.equal(r.samples.length, 5);
	});
});

describe("stripNonProse / sentencesOf", () => {
	test("drops fenced and inline code, display and inline math, and URLs", () => {
		const out = stripNonProse("a `b` c ```x\ny``` d $$e$$ f $g$ h \\(i\\) j https://x.y/z k");
		assert.equal(out.replace(/\s+/g, " ").trim(), "a c d f h j k");
	});

	test("splits on sentence ends and newlines", () => {
		assert.deepEqual(sentencesOf("En. To!\nTre? Fire"), ["En.", "To!", "Tre?", "Fire"]);
	});
});

describe("tutorProse", () => {
	test("collects assistant text, a question's lead and a send_to_user message, and nothing else", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "learner words" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private" },
					{ type: "text", text: "  Prose.  " },
					{ type: "toolCall", name: "quiz", arguments: { lead: "A lead.", question: "Q?" } },
					{ type: "toolCall", name: "send_to_user", arguments: { message: "Sent." } },
					{ type: "toolCall", name: "visual", arguments: { brief: "not prose" } },
				],
			},
			{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		];
		assert.deepEqual(tutorProse(messages), ["Prose.", "A lead.", "Sent."]);
	});

	test("an assistant message without a content array is ignored", () => {
		assert.deepEqual(tutorProse([{ role: "assistant", content: "x" }, null]), []);
	});
});

describe("formatComparison", () => {
	const a = { language: "nb", thinking: "medium", model: "claude-code/sonnet", questions: 14, avgProseCharsAfterMiss: 300, avgSecondsPerTurn: 40, refusals: { prose: 2 }, otherErrors: 0, pictureJobs: 1, pictureBeforeFirstTeachQuestion: true, proseCharsTotal: 9000, fillerHits: 6, fillerPer1kChars: 0.67, englishLeak: { sentences: 50, flagged: 5, share: 0.1, samples: ["The limit is close to the value."] } };
	const b = { language: "nb", thinking: "medium", model: "claude-code/sonnet", questions: 14, avgProseCharsAfterMiss: 420, avgSecondsPerTurn: 38, refusals: { prose: 1, "lead-floor": 3 }, otherErrors: 0, pictureJobs: 2, pictureBeforeFirstTeachQuestion: false, proseCharsTotal: 9500, fillerHits: 1, fillerPer1kChars: 0.11, englishLeak: { sentences: 52, flagged: 1, share: 0.019, samples: [] } };

	test("prints a row per metric with the b − a delta", () => {
		const out = formatComparison(a, b, "before.json", "after.json");
		const row = (label: string) => out.split("\n").find((l) => l.startsWith(label)) ?? "";
		assert.match(out, /^metric\s+before\.json\s+after\.json\s+Δ \(b − a\)/);
		assert.match(row("avg prose chars after a miss"), /300\s+420\s+\+120$/);
		assert.match(row("avg seconds per turn"), /40\s+38\s+-2$/);
		assert.match(row("refused: prose"), /2\s+1\s+-1$/);
		assert.match(row("refused: lead-floor"), /0\s+3\s+\+3$/);
		assert.match(row("praise/filler hits"), /6\s+1\s+-5$/);
		assert.match(row("English-leak sentences (nb)"), /5\s+1\s+-4$/);
		assert.match(row("picture before first question"), /yes\s+no$/);
		assert.match(out, /English-looking sentences in before\.json:\n {2}- The limit is close to the value\./);
		assert.doesNotMatch(out, /English-looking sentences in after\.json/);
	});

	test("fields an older report lacks show as a dash", () => {
		const old = { chatId: "x", questions: 14, refusals: {}, avgProseCharsAfterMiss: 300 };
		const out = formatComparison(old, a, "old.json", "new.json");
		const row = (label: string) => out.split("\n").find((l) => l.startsWith(label)) ?? "";
		assert.match(row("language"), /–\s+nb$/);
		assert.match(row("praise/filler hits"), /–\s+6$/);
		assert.match(row("refused: prose"), /0\s+2\s+\+2$/);
	});
});
