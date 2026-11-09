/**
 * THE WHITEHEAD INCIDENT PINS (owner, 2026-10-09): glm-5.3 (z-ai via
 * OpenRouter) emitted two argument-wobble shapes in one real session —
 * quiz `type: "\"predict\""` (the literal with quotes baked in; the
 * schema's own description displayed the values quoted+colon) rejected
 * TEN times with byte-identical retries while the lesson never started,
 * and `correctAnswer: [":parmenides"]` (the option value with the JSON
 * key-value colon glued on) rejected four times.
 *
 * The fixes these pins hold:
 *  1. THE STANDARD HEAL EVERYWHERE — healToolRecord wraps every registry
 *     (bareQuestionTools carried NO prepareArguments at all), and the
 *     quote-encoded literal heals before TypeBox validation.
 *  2. THE DEBRIS STRIP AT MEMBERSHIP SEAMS — stripModelValueDebris in
 *     coerceCorrectAnswer (boundary check + grading), normalizeQuizType,
 *     and resolveTargetId.
 *  3. THE DISPLAY MIRROR — the record keeps RAW arguments, so
 *     parseQuizInput heals the same wobble on read (the tool-parts law:
 *     a healed-at-boundary quiz whose display parse rejects is an
 *     invisible pending quiz and a learner lockout).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { healEncodedArguments } from "../src/core/argument-heal.ts";
import { stripModelValueDebris } from "../src/core/value-debris.ts";
import {
	coerceCorrectAnswer,
	normalizeQuizType,
	quizInputObject,
	quizInputProblems,
} from "../src/core/question-core.ts";
import { parseQuizInput } from "../src/core/tool-parts.ts";
import { resolveTargetId } from "../src/core/chains.ts";
import { bareQuestionTools } from "../src/agent/teacher-agent.ts";
import { probeQuizTool } from "../src/agent/tools.ts";
import { placementProbeInput } from "../src/agent/tools/course.ts";

/** The incident's exact encoding: the value wrapped in literal quotes. */
function QUOTED(value: string): string {
	return `"${value}"`;
}

// A complete, well-formed teach-quiz input — the incident's call with
// every field valid BUT the wobbled one.
function whiteheadQuiz(type: unknown, correctAnswer: unknown) {
	return {
		question: "What was Parmenides' claim?",
		options: [
			{ label: "Being is changeless and complete", value: "parmenides" },
			{ label: "Becoming is fundamental", value: "heraclitus" },
			{ label: "Split world", value: "split" },
			{ label: "Both unreal", value: "both-illusion" },
		],
		explanation: "What truly *is* cannot come to be or pass away — the flux is appearance.",
		correctAnswer,
		type,
		nodeId: "experience-first",
		lead: "Right. Next, the Parmenides claim.",
	};
}

describe("the death-loop shape — quiz type with quotes baked in", () => {
	it("heals the quote-encoded literal (the ten-retry loop)", () => {
		const healed = healEncodedArguments({ type: QUOTED("predict") }, quizInputObject) as {
			type: unknown;
		};
		assert.equal(healed.type, "predict");
	});

	it("END-TO-END: the healed args pass pi-ai validation where the raw threw", () => {
		const raw = whiteheadQuiz(QUOTED("predict"), ["parmenides"]);
		assert.throws(() => {
			validateToolArguments({ name: "quiz", parameters: quizInputObject } as never, {
				id: "call_x",
				type: "toolCall",
				name: "quiz",
				arguments: raw,
			} as never);
		});
		const validated = validateToolArguments(
			{ name: "quiz", parameters: quizInputObject } as never,
			{
				id: "call_x",
				type: "toolCall",
				name: "quiz",
				arguments: healEncodedArguments(raw, quizInputObject),
			} as never,
		);
		assert.equal((validated as { type: unknown }).type, "predict");
	});

	it("WIRING: bareQuestionTools (the registry with NO prepareArguments) now heals", () => {
		const tools = bareQuestionTools();
		const quiz = tools.quiz;
		assert.ok(quiz, "the bare quiz must exist");
		assert.ok(quiz.prepareArguments, "the bare quiz must carry the standard heal");
		const healed = quiz.prepareArguments!(
			whiteheadQuiz(QUOTED("predict"), ["parmenides"]),
		) as { type: unknown };
		assert.equal(healed.type, "predict");
	});

	it("WIRING: the 2026-09-26 string-options shape heals through the bare quiz too", () => {
		// The universal heal covers the ORIGINAL incident's shape as well:
		// options serialized as a JSON string (then healed only on the
		// plan-tree quiz path; the bare registries had nothing).
		const quiz = bareQuestionTools().quiz;
		assert.ok(quiz?.prepareArguments, "the bare quiz must carry the standard heal");
		const input = whiteheadQuiz("predict", ["parmenides"]);
		const stringified = { ...input, options: JSON.stringify(input.options) };
		const healed = quiz.prepareArguments!(stringified) as { options: unknown };
		assert.ok(Array.isArray(healed.options), "the JSON string heals to the array");
		assert.equal(
				(healed.options as Array<{ value?: string }>)[0]?.value,
			"parmenides",
		);
	});
});

describe("the colon shape — correctAnswer with copy-syntax debris", () => {
	it("stripModelValueDebris: the observed shapes heal, interiors stay", () => {
		assert.equal(stripModelValueDebris(":parmenides"), "parmenides");
		assert.equal(stripModelValueDebris(QUOTED("predict")), "predict");
		assert.equal(stripModelValueDebris(`: "primary-external" `), "primary-external");
		assert.equal(stripModelValueDebris("`value`"), "value");
		assert.equal(stripModelValueDebris("a:b"), "a:b"); // interior colon is content
		assert.equal(stripModelValueDebris('["x"]'), '["x"]'); // interior quotes are content (JSON-array strings)
	});

	it("coerceCorrectAnswer cleans non-matching entries (boundary check + grading seam)", () => {
		assert.deepEqual(coerceCorrectAnswer([":parmenides"], ["parmenides"]), ["parmenides"]);
		assert.deepEqual(coerceCorrectAnswer(QUOTED("primary-external"), ["primary-external"]), ["primary-external"]);
	});

	it("the incident's exact call passes the semantic boundary (quizInputProblems)", () => {
		const input = whiteheadQuiz("predict", [":parmenides"]) as Parameters<
			typeof quizInputProblems
		>[0];
		assert.deepEqual(quizInputProblems(input), []);
	});

	it("normalizeQuizType heals a persisted wobbled record", () => {
		assert.equal(normalizeQuizType(QUOTED("predict")), "predict");
		assert.equal(normalizeQuizType('"check"'), "check");
		assert.equal(normalizeQuizType(undefined), undefined);
		assert.equal(normalizeQuizType("bogus"), undefined);
	});

	it("resolveTargetId heals copy-syntax on targets", () => {
		const nodes = [{ id: "experience-first", name: "Experience first" }];
		assert.equal(resolveTargetId(":experience-first", nodes), "experience-first");
		assert.equal(resolveTargetId('"Experience first"', nodes), "experience-first");
		assert.equal(resolveTargetId("nope", nodes), null);
	});
});

describe("the calculus retry loop — an exact answer was incorrectly stripped", () => {
	it("the real probe tool accepts a label with its sentence-final period", async () => {
		const input = {
			question: "Which claim?",
			options: [{ label: "The claim holds." }, { label: "The claim need not hold." }],
			explanation: "The premise does not imply the claim.",
			correctAnswer: "The claim need not hold.",
		};
		const validated = validateToolArguments(probeQuizTool, {
			type: "toolCall",
			id: "calculus-period",
			name: "probe",
			arguments: probeQuizTool.prepareArguments!(input),
		});
		assert.equal(validated.correctAnswer, input.correctAnswer);
		const result = await probeQuizTool.execute("calculus-period", validated);
		assert.notEqual(result.isError, true, "an already-exact answer must not trigger a retry");
		assert.equal(result.terminate, true, "the valid question is posed normally");
	});
});

describe("the display mirror — raw records heal on read", () => {
	it("parseQuizInput renders the incident's persisted raw record (no invisible quiz)", () => {
		const raw = whiteheadQuiz(QUOTED("predict"), [":parmenides"]);
		const parsed = parseQuizInput(raw);
		assert.ok(parsed, "the wobbled record must parse — else the quiz is invisible");
		// The display schema's type is DELIBERATELY a lenient string (old
		// and probe records carry none); the read seam is normalizeQuizType —
		// which strips the recorded wobble to the intended role.
		assert.equal(normalizeQuizType(parsed?.type), "predict");
		// The graded answer resolves to the option despite the recorded colon.
		assert.deepEqual(parsed ? coerceCorrectAnswer(parsed.correctAnswer, parsed.options.map((o) => o.value ?? o.label)) : [], ["parmenides"]);
	});
});

describe("the leaked parameter boundary (Matte 1 placement, 2026-10-25)", () => {
	// The exact failed call: `skill` swallowed `question` behind a leaked
	// `</parameter>\n<parameter name="question">` and validation refused it.
	const leaked = {
		skill: 'sk_74aa18dc0f9a</parameter>\n<parameter name="question">La $A=\begin{pmatrix}1&2\\3&k\end{pmatrix}$. For hvilken verdi av $k$?',
		explanation: "$\det A = k-6$.",
		options: [
			{ label: "$k=6$", value: "a" },
			{ label: "$k=-6$", value: "b" },
		],
		correctAnswer: "a",
	};

	it("splits the field back out, and the healed call passes validation", () => {
		const healed = healEncodedArguments(leaked, placementProbeInput) as Record<string, unknown>;
		assert.equal(healed.skill, "sk_74aa18dc0f9a");
		assert.match(String(healed.question), /^La \$A=.*For hvilken verdi av \$k\$\?$/);
		const call = (args: unknown) =>
			validateToolArguments({ name: "probe", parameters: placementProbeInput } as never, {
				id: "call_x",
				type: "toolCall",
				name: "probe",
				arguments: args,
			} as never);
		assert.throws(() => call(leaked));
		assert.doesNotThrow(() => call(healed));
	});

	it("strips a trailing closing tag on the split-off value", () => {
		const healed = healEncodedArguments(
			{ ...leaked, skill: 'sk_1</parameter>\n<parameter name="question">Q?</parameter>' },
			placementProbeInput,
		) as Record<string, unknown>;
		assert.equal(healed.question, "Q?");
	});

	it("leaves well-formed args as the same reference", () => {
		const fine = { ...leaked, skill: "sk_1", question: "Q?" };
		assert.equal(healEncodedArguments(fine, placementProbeInput), fine);
	});

	it("leaves the call alone when the named field is unknown or already present", () => {
		const unknown = { ...leaked, skill: 'sk_1</parameter>\n<parameter name="bogus">x' };
		assert.equal(healEncodedArguments(unknown, placementProbeInput), unknown);
		const present = { ...leaked, question: "Q?" };
		assert.equal(healEncodedArguments(present, placementProbeInput), present);
	});
});

describe("the leaked JSON boundary (Matte 1 review, 2026-11-07)", () => {
	// The exact failed call, shortened: the quoting broke inside `statement`, so
	// the rest of the object rode inside that string, `\n` as two characters.
	const schema = {
		properties: {
			statement: { type: "string" },
			mode: { anyOf: [{ const: "recall" }, { const: "discrimination" }, { const: "composition" }] },
			modelSolution: { type: "string" },
			skills: { type: "array" },
		},
	};
	const head = String.raw`Bruk definisjonen $f'(a)=\lim_{h\to0}\dfrac{f(a+h)-f(a)}{h}$.\n\n**a)** $f(x)=|x-1|$.\n\n**b)** Er $x\neq 1$? \nc) neste.`;
	const tail = String.raw`","mode":"recall","modelSolution":"a) f(1)=0.\\nb) g(0)=0.","skills":["sk_e0358a5e4f82"]}` + "\n";
	const leaked = { statement: head + tail };

	it("splits the fields back out, and the healed call carries real newlines", () => {
		const healed = healEncodedArguments(leaked, schema) as Record<string, unknown>;
		assert.equal(healed.mode, "recall");
		assert.deepEqual(healed.skills, ["sk_e0358a5e4f82"]);
		assert.equal(
			healed.statement,
			"Bruk definisjonen $f'(a)=\\lim_{h\\to0}\\dfrac{f(a+h)-f(a)}{h}$.\n\n**a)** $f(x)=|x-1|$.\n\n**b)** Er $x\\neq 1$? \nc) neste.",
			"\\n becomes a newline; LaTeX \\lim, \\to, \\dfrac and \\neq are kept",
		);
		assert.equal(healed.modelSolution, "a) f(1)=0.\nb) g(0)=0.");
	});

	it("halves a doubled-backslash LaTeX run (the real call's case block)", () => {
		const doubled = { statement: String.raw`$$k(x)=\\begin{cases}x^2, & x\\le 1\\\\ 2x-1, & x>1\\end{cases}$$` + tail };
		const healed = healEncodedArguments(doubled, schema) as Record<string, unknown>;
		assert.equal(healed.statement, String.raw`$$k(x)=\begin{cases}x^2, & x\le 1\\ 2x-1, & x>1\end{cases}$$`);
	});

	it("leaves it alone when a named field is unknown, already present, or the tail does not parse", () => {
		const unknown = { statement: head + '","bogus":"x"}' };
		assert.equal(healEncodedArguments(unknown, schema), unknown);
		const present = { statement: head + tail, mode: "recall" };
		assert.equal((healEncodedArguments(present, schema) as Record<string, unknown>).statement, head + tail);
		const broken = { statement: head + '","mode":"recall","modelSolution":"unterminated' };
		assert.equal(healEncodedArguments(broken, schema), broken);
	});

	it("leaves well-formed args and ordinary quoted text as the same reference", () => {
		const fine = { statement: 'Si "ja","nei": hvilket?', mode: "recall", modelSolution: "M", skills: ["sk_1"] };
		assert.equal(healEncodedArguments(fine, schema), fine);
		const mention = { statement: 'Lag en liste: "a","mode": ikke et felt.' };
		assert.equal(healEncodedArguments(mention, schema), mention, "an unparseable tail is not a leak");
	});
});

describe("a leaked tail that duplicates fields the call already carries (Matte 1 lesson, 2026-11-09)", () => {
	const schema = {
		properties: {
			lead: { type: "string" },
			question: { type: "string" },
			explanation: { type: "string" },
		},
	};
	// The real shapes: `, ` with a space, and no closing brace (the string ended there).
	const head = String.raw`**Sammenligningstesten.** For eksempel $\\int_1^\\infty \\frac{1}{x^2}\\,dx$.\n\n- Hvis $g$ konvergerer, gjør $f$ det også.`;
	const question = String.raw`Hva kan du slutte om $\displaystyle\int_1^\infty \frac{1}{\sqrt{x}+x}\,dx$?`;
	const leakedQuestion = String.raw`", "question": "Hva kan du slutte om $\\displaystyle\\int_1^\\infty \\frac{1}{\\sqrt{x}+x}\\,dx$?"`;

	it("cuts the tail, keeps the head exactly as written and lets the real field win", () => {
		const healed = healEncodedArguments({ lead: head + leakedQuestion, question }, schema) as Record<string, unknown>;
		assert.equal(healed.lead, head, "the head keeps its source escapes; the display layer repairs them");
		assert.equal(healed.question, question);
	});

	it("cuts it even when the tail's text differs from the real field, and with a closing brace", () => {
		const differing = healEncodedArguments({ lead: head + '", "question": "x"', question: "Hvilket?" }, schema) as Record<string, unknown>;
		assert.equal(differing.lead, head);
		assert.equal(differing.question, "Hvilket?");
		const braced = healEncodedArguments({ lead: head + '","question":"x"}', question: "Hvilket?" }, schema) as Record<string, unknown>;
		assert.equal(braced.lead, head);
	});

	it("cuts a tail of several duplicated fields, but not one that names a field the call lacks", () => {
		const both = healEncodedArguments({ lead: head + '", "question": "a", "explanation": "b"', question: "Q?", explanation: "E." }, schema) as Record<string, unknown>;
		assert.equal(both.lead, head);
		const partial = { lead: head + '", "question": "a", "explanation": "b"', question: "Q?" };
		assert.equal(healEncodedArguments(partial, schema), partial, "mixed present/absent stays for validation");
	});

	it("leaves ordinary quoted prose and unknown or unparseable tails alone", () => {
		const prose = { lead: 'Si "ja", "question": ikke et felt.', question: "Q?" };
		assert.equal(healEncodedArguments(prose, schema), prose, "an unparseable tail is not a leak");
		const unknown = { lead: head + '", "bogus": "x"', question: "Q?" };
		assert.equal(healEncodedArguments(unknown, schema), unknown, "an unknown field is not a leak");
		const fine = { lead: head, question };
		assert.equal(healEncodedArguments(fine, schema), fine);
	});

	it("is idempotent, and the display parse cuts the tail too (the tool-parts law)", () => {
		const once = healEncodedArguments({ lead: head + leakedQuestion, question }, schema);
		assert.equal(healEncodedArguments(once, schema), once);
		const parsed = parseQuizInput({
			type: "check",
			nodeId: "n1",
			lead: "Forste avsnitt." + '", "question": "Q?"',
			question: "Q?",
			explanation: "E.",
			options: [
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			],
			correctAnswer: "a",
		});
		assert.equal(parsed?.lead, "Forste avsnitt.");
	});
});
