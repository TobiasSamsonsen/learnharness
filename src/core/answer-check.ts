/**
 * The answer-key check (owner, 2026-10-25 — the ITGK sessions: an
 * arithmetic quiz with no correct option, a placement question that said
 * "prints 2.5" of a program that prints 2.8). PURE, browser-safe — the
 * running (server/python-run.ts) and the second model
 * (agent/subagents/answer-checker.ts) live elsewhere; this file decides.
 *
 * Two sources of truth, in order:
 *   1. Python. A question with ONE python block is run as-is; when its
 *      printed output is an option, that option must be the key. An
 *      explicit `verify` program must print the correct option's label.
 *   2. A second model, solving blind (no key, no explanation), for every
 *      question Python did not settle — with whatever the run showed as a
 *      fact it may rely on.
 */

/** The fenced python blocks of a markdown text. */
export function pythonBlocks(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/```(?:python3?|py)[ \t]*\r?\n([\s\S]*?)```/g)) out.push(m[1]!);
	return out;
}

/** Why a snippet must not run, or null. A denylist, not a sandbox: the
 *  author is the app's own model writing tiny trace-me programs; this
 *  keeps the obviously side-effecting ones (files, processes, network,
 *  dynamic code) off the learner's machine. Refused snippets are simply
 *  not run — the second model checks them instead. */
export function unsafePythonReason(code: string): string | null {
	const mod = /^\s*(?:import|from)\s+(os|sys|subprocess|shutil|socket|pathlib|ctypes|urllib|http|requests|importlib|multiprocessing|threading|signal|glob|tempfile|pickle|marshal|webbrowser|ftplib|smtplib|asyncio|io|builtins)\b/m.exec(code);
	if (mod) return `imports ${mod[1]}`;
	const call = /\b(open|exec|eval|compile|__import__|globals|locals|getattr|setattr|delattr|breakpoint)\s*\(/.exec(code);
	if (call) return `calls ${call[1]}()`;
	if (/__\w+__/.test(code.replace(/__name__|__main__|__init__|__str__|__repr__|__eq__|__len__/g, ""))) return "uses dunder attributes";
	return null;
}

/** An option label as printed output: one surrounding code span removed,
 *  nothing else touched (leading spaces are output too). */
export function labelAsOutput(label: string): string {
	const t = label.trim();
	const m = /^(`+)([\s\S]*?)\1$/.exec(t);
	return m ? m[2]! : t;
}

/** Printed output, compared exactly: CRLF folded, trailing spaces of each
 *  line and trailing blank lines dropped. */
export function normalizeOutput(s: string): string {
	return s
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
}

/** The loose comparison: runs of whitespace and commas are one separator
 *  (an option may show "A, C, -1" for three printed lines). */
const loose = (s: string) => s.replace(/[\s,]+/g, " ").trim();

/** Indices of the options whose label IS this output — exact matches if
 *  any, else loose ones. */
export function optionsShowingOutput(options: ReadonlyArray<{ label: string }>, output: string): number[] {
	const out = normalizeOutput(output);
	const exact = options.flatMap((o, i) => (normalizeOutput(labelAsOutput(o.label)) === out ? [i] : []));
	if (exact.length > 0) return exact;
	const l = loose(out);
	return l === "" ? [] : options.flatMap((o, i) => (loose(labelAsOutput(o.label)) === l ? [i] : []));
}

/** What a Python run says about a key. */
export interface PythonVerdict {
	/** The key is proven right — no second model needed. */
	verified: boolean;
	/** Refusal reasons for the author (empty = no objection). */
	problems: string[];
	/** Ground truth for the second model when nothing was proven. */
	facts: string[];
}

export interface RunOutcome {
	/** Exit 0, no timeout. */
	ok: boolean;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

const fence = (s: string) => "```\n" + s + "\n```";
const lastLine = (s: string) => s.trim().split(/\r?\n/).at(-1) ?? "";

/** The question's own block, run as-is. Refuses only when the printed
 *  output is a DIFFERENT option than the key — anything less certain
 *  becomes a fact for the second model. */
export function judgeQuestionRun(
	options: ReadonlyArray<{ label: string }>,
	correct: readonly number[],
	run: RunOutcome,
	multiSelect: boolean,
): PythonVerdict {
	if (run.timedOut) return { verified: false, problems: [], facts: ["Running the question's code block as written did not finish within 5 seconds."] };
	if (!run.ok) {
		return {
			verified: false,
			problems: [],
			facts: [`Running the question's code block as written raised: ${lastLine(run.stderr) || "an error"} (it may be deliberately incomplete — a blank to fill).`],
		};
	}
	const output = normalizeOutput(run.stdout);
	if (output === "") return { verified: false, problems: [], facts: ["Running the question's code block as written prints nothing."] };
	const fact = `Running the question's code block as written prints exactly:\n${fence(output)}`;
	if (multiSelect) return { verified: false, problems: [], facts: [fact] };
	const shows = optionsShowingOutput(options, output);
	if (shows.length === 0) return { verified: false, problems: [], facts: [fact] };
	if (correct.some((i) => shows.includes(i))) return { verified: true, problems: [], facts: [] };
	const shown = shows.map((i) => `"${options[i]!.label}"`).join(" / ");
	const keyed = correct.map((i) => `"${options[i]!.label}"`).join(", ");
	return {
		verified: false,
		problems: [
			`The code block was run: it prints exactly\n${fence(output)}\nwhich is option ${shown} — but correctAnswer is ${keyed}. ` +
				"Re-solve with that output, fix the key (and the explanation), then call again. If the question asks about something " +
				"other than this program's printed output, pass `verify` with a program that prints the correct option's label.",
		],
		facts: [],
	};
}

/** An explicit `verify` program: it must print the correct option's label
 *  (multi-select: each correct label on its own line, any order). */
export function judgeVerifyRun(
	options: ReadonlyArray<{ label: string }>,
	correct: readonly number[],
	run: RunOutcome,
	multiSelect: boolean,
): PythonVerdict {
	if (run.timedOut) return { verified: false, problems: ["Your `verify` program did not finish within 5 seconds — keep it a tiny computation."], facts: [] };
	if (!run.ok) return { verified: false, problems: [`Your \`verify\` program raised: ${lastLine(run.stderr) || "an error"}. Fix it (or the question), then call again.`], facts: [] };
	const output = normalizeOutput(run.stdout);
	const keyed = correct.map((i) => options[i]!.label);
	if (multiSelect) {
		const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
		const printed = new Set(lines.flatMap((l) => optionsShowingOutput(options, l)));
		if (printed.size === correct.length && correct.every((i) => printed.has(i))) return { verified: true, problems: [], facts: [] };
	} else if (correct.some((i) => optionsShowingOutput(options, output).includes(i))) {
		return { verified: true, problems: [], facts: [] };
	}
	return {
		verified: false,
		problems: [
			`Your \`verify\` program printed\n${fence(output || "(nothing)")}\nbut the correct option's label is ${keyed.map((l) => `"${l}"`).join(", ")}. ` +
				"Re-solve the question with that result and fix the key, the options or the program, then call again.",
		],
		facts: [],
	};
}

/** The second model's verdict, as the author's problems (empty = agrees). */
export function judgeChecker(
	options: ReadonlyArray<{ label: string; value: string }>,
	correct: readonly number[],
	verdict: { solution: string; correct: readonly string[]; problem?: string },
): string[] {
	const tail =
		"Re-solve it yourself. If the key is wrong, fix it and the explanation; if the question lets a careful solver defend another option, make it unambiguous. " +
		"If you are certain the question is right exactly as written, send the same call again unchanged — it then goes through.";
	const problem = verdict.problem?.trim();
	if (problem) return [`A second model checked this question before the learner sees it and flagged: ${problem}\nIts solution: ${verdict.solution.trim()}\n${tail}`];
	const picked = new Set(verdict.correct.map((v) => options.findIndex((o) => o.value === v || o.label === v)).filter((i) => i >= 0));
	if (picked.size === correct.length && correct.every((i) => picked.has(i))) return [];
	const labels = (ids: Iterable<number>) => [...ids].map((i) => `"${options[i]!.label}"`).join(", ") || "no option";
	return [
		`A second model solved this question independently (it never saw your key) and chose ${labels(picked)}, not ${labels(correct)}.\nIts solution: ${verdict.solution.trim()}\n${tail}`,
	];
}
