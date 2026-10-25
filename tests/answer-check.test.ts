/**
 * The answer-key check (owner, 2026-10-25 — the ITGK sessions: a quiz with
 * no correct option, a placement question claiming "prints 2.5" of a
 * program printing 2.8). The pure rules, the Python runner against the
 * real interpreter (skipped when the machine has none), and the seam
 * through a real question tool.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	judgeChecker,
	judgeQuestionRun,
	judgeVerifyRun,
	labelAsOutput,
	optionsShowingOutput,
	pythonBlocks,
	unsafePythonReason,
} from "../src/core/answer-check.ts";
import { installQuestionVerifier, resolveQuiz } from "../src/agent/question-verify.ts";
import { probeQuizTool } from "../src/agent/tools.ts";
import { findPython, runPython } from "../src/server/python-run.ts";

const opts = (...labels: string[]) => labels.map((label, i) => ({ label, value: String.fromCharCode(97 + i) }));
const ran = (stdout: string) => ({ ok: true, stdout, stderr: "", timedOut: false });

describe("reading a question's code and options", () => {
	it("finds python blocks only", () => {
		assert.deepEqual(pythonBlocks("a\n```python\nprint(1)\n```\n```\nplain\n```\n```py\nx = 2\n```"), ["print(1)\n", "x = 2\n"]);
	});

	it("an option label is output with one code span removed — leading spaces kept", () => {
		assert.equal(labelAsOutput("`   Ola|007.50|lala`"), "   Ola|007.50|lala");
		assert.equal(labelAsOutput("``a`b``"), "a`b");
		assert.equal(labelAsOutput("plain words"), "plain words");
	});

	it("matches output exactly first, loosely (lines vs commas) second", () => {
		const o = opts("`A, C, -1, B, C, 2`", "`A, -1, B, C, 2`");
		assert.deepEqual(optionsShowingOutput(o, "A\nC\n-1\nB\nC\n2\n"), [0]);
		assert.deepEqual(optionsShowingOutput(opts("`   Ola`", "`Ola`"), "   Ola\n"), [0], "exact wins over loose");
	});

	it("refuses snippets that touch the machine, runs plain computation", () => {
		assert.match(unsafePythonReason("import os\nos.remove('x')")!, /os/);
		assert.match(unsafePythonReason("open('f', 'w').write('x')")!, /open/);
		assert.match(unsafePythonReason("().__class__.__base__")!, /dunder/);
		assert.equal(unsafePythonReason("import copy\nimport numpy as np\nprint(np.sum([1, 2]))"), null);
		assert.equal(unsafePythonReason("if __name__ == '__main__':\n    print(1)"), null);
	});
});

describe("judging a run of the question's own code", () => {
	const o = opts("`[[1, 5], [1, 5]]`", "`[[1, 0], [1, 0]]`");

	it("the key's label printed → verified, no second model needed", () => {
		assert.deepEqual(judgeQuestionRun(o, [0], ran("[[1, 5], [1, 5]]\n"), false), { verified: true, problems: [], facts: [] });
	});

	it("another option printed → refused, with the real output", () => {
		const v = judgeQuestionRun(o, [1], ran("[[1, 5], [1, 5]]\n"), false);
		assert.equal(v.verified, false);
		assert.match(v.problems[0]!, /prints exactly[\s\S]*\[\[1, 5\], \[1, 5\]\][\s\S]*correctAnswer is "`\[\[1, 0\], \[1, 0\]\]`"/);
	});

	it("output that is no option (the 'prints 2.5' premise) → a fact for the second model, never a refusal", () => {
		const v = judgeQuestionRun(opts("Set a breakpoint", "Run it again"), [0], ran("2.8\n"), false);
		assert.deepEqual(v.problems, []);
		assert.match(v.facts[0]!, /prints exactly:\n```\n2\.8\n```/);
	});

	it("an error or a timeout is a fact too (the block may hold a blank)", () => {
		const err = judgeQuestionRun(o, [0], { ok: false, stdout: "", stderr: "Traceback…\nSyntaxError: invalid syntax", timedOut: false }, false);
		assert.deepEqual(err.problems, []);
		assert.match(err.facts[0]!, /SyntaxError: invalid syntax[\s\S]*deliberately incomplete/);
		assert.match(judgeQuestionRun(o, [0], { ok: false, stdout: "", stderr: "", timedOut: true }, false).facts[0]!, /did not finish/);
	});
});

describe("judging an explicit verify program", () => {
	const o = opts("`ord not in sett`", "`ord in sett`", "`len(sett) == 0`");

	it("must print the correct option's label", () => {
		assert.equal(judgeVerifyRun(o, [0], ran("ord not in sett\n"), false).verified, true);
		assert.match(judgeVerifyRun(o, [0], ran("ord in sett\n"), false).problems[0]!, /printed[\s\S]*ord in sett[\s\S]*correct option's label is "`ord not in sett`"/);
	});

	it("multi-select: every correct label, one per line, any order", () => {
		assert.equal(judgeVerifyRun(o, [0, 2], ran("len(sett) == 0\nord not in sett\n"), true).verified, true);
		assert.equal(judgeVerifyRun(o, [0, 2], ran("ord not in sett\n"), true).verified, false);
	});

	it("a crashing verify program is the author's to fix", () => {
		assert.match(judgeVerifyRun(o, [0], { ok: false, stdout: "", stderr: "NameError: name 'x' is not defined", timedOut: false }, false).problems[0]!, /NameError/);
	});
});

describe("judging the second model", () => {
	const o = opts("$2x\\sin x + x^2\\cos x$", "$2x\\cos x$");

	it("agrees → no problem; disagrees → refused with its solution", () => {
		assert.deepEqual(judgeChecker(o, [0], { solution: "product rule", correct: ["a"] }), []);
		assert.match(judgeChecker(o, [1], { solution: "product rule", correct: ["a"] })[0]!, /independently[\s\S]*chose "\$2x\\sin x \+ x\^2\\cos x\$", not "\$2x\\cos x\$"[\s\S]*product rule[\s\S]*send the same call again unchanged/);
	});

	it("a flagged question is refused even when the key agrees", () => {
		assert.match(judgeChecker(o, [0], { solution: "…", correct: ["a"], problem: "the question says 2.5; it prints 2.8" })[0]!, /flagged: the question says 2\.5/);
	});

	it("the checker may answer by label as well as by value", () => {
		assert.deepEqual(judgeChecker(o, [0], { solution: "…", correct: ["$2x\\sin x + x^2\\cos x$"] }), []);
	});
});

describe("the seam: a question tool awaits the installed verifier", () => {
	after(() => installQuestionVerifier(null));
	const args = { question: "Q?", explanation: "…", options: [{ label: "x", value: "a" }, { label: "y", value: "b" }], correctAnswer: "b" };

	it("resolves the key the way grading does", () => {
		const r = resolveQuiz({ ...args, options: [{ label: "x" }, { label: "y" }], correctAnswer: "y" });
		assert.deepEqual(r.correct, [1]);
		assert.deepEqual(r.keyed, [{ label: "x", value: "x" }, { label: "y", value: "y" }]);
	});

	it("problems come back as the tool's invalid-input result; none → posed", async () => {
		let seen: number[] | null = null;
		installQuestionVerifier(async (q) => {
			seen = q.correct;
			return q.correct[0] === 1 ? ["wrong key"] : [];
		});
		const refused = await probeQuizTool.execute("c1", args as never);
		assert.equal(seen![0], 1);
		assert.match(JSON.stringify(refused.content), /wrong key/);
		const posed = await probeQuizTool.execute("c2", { ...args, correctAnswer: "a" } as never);
		assert.match(JSON.stringify(posed.content), /Question posed/);
	});
});

describe("the Python runner (the machine's own interpreter)", async () => {
	const python = await findPython();

	it("runs a snippet in isolation and captures stdout", { skip: !python && "no Python on this machine" }, async () => {
		const run = (await runPython("a = [[0] * 2] * 2\na[0][0] = 1\nprint(a)"))!;
		assert.equal(run.ok, true);
		assert.equal(run.stdout.trim(), "[[1, 0], [1, 0]]");
	});

	it("reports errors, and kills a runaway loop", { skip: !python && "no Python on this machine" }, async () => {
		const err = (await runPython("print(1 // 0)"))!;
		assert.equal(err.ok, false);
		assert.match(err.stderr, /ZeroDivisionError/);
		const loop = (await runPython("while True:\n    pass"))!;
		assert.equal(loop.timedOut, true);
	});

	it("starts in an empty temp directory", { skip: !python && "no Python on this machine" }, async () => {
		const run = (await runPython("import os\nprint(len(os.listdir('.')))"))!;
		assert.equal(run.stdout.trim(), "1", "only the snippet itself");
	});
});
