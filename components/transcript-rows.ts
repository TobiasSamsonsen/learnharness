/**
 * Which assistant parts show in the transcript (owner, 2026-11-17: the live
 * line stands for all thinking and tool activity). Model Reasoning rows and
 * tool-activity rows are never drawn; only content is: text, the plan block,
 * answered questions, and the content cards (assessment, figures, problems,
 * job cards, finish). One pure helper so the renderer's step hairlines and
 * its empty-group check read the same truth. PURE, browser-safe.
 */

export interface RowPart {
	type: string;
	state?: string;
	text?: string;
	pluginProblem?: unknown;
	pluginQuestion?: unknown;
}

/** Tools whose part is a content card the learner reads (everything else is activity). */
const CONTENT_TOOLS: ReadonlySet<string> = new Set([
	"research",
	"pdf",
	"demo",
	"visual",
	"show_image",
	"show_figure",
	"probe_done",
	"problem",
	"conclude",
	"read_sketch",
	"finish_lesson",
	"finish_session",
]);

/** Tools that pose a question: the dock shows them live, the transcript only once answered. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(["quiz", "probe", "explain", "recall", "ask_user_question"]);

/** True when the part draws something in the transcript. */
export function partShows(p: RowPart): boolean {
	if (p.pluginProblem || p.pluginQuestion) return true;
	if (p.type === "text") return (p.text ?? "").trim() !== "";
	if (p.type === "data-plan-block") return true;
	if (!p.type.startsWith("tool-")) return false; // reasoning, step-start, other data parts
	const name = p.type.slice("tool-".length);
	if (QUESTION_TOOLS.has(name)) return p.state === "output-available";
	if (name === "finish_lesson" || name === "finish_session") return p.state === "output-available";
	return CONTENT_TOOLS.has(name);
}

/**
 * A React key per part that does not depend on its position. At the end of a
 * turn the server adds the plan block in the middle of the message; keyed by
 * position, every part after it would shift and re-mount (the plan text
 * blinked). Tool parts keep their call id; the rest count per type, so a part
 * of another type inserted before it changes nothing.
 */
export function partKeys(parts: readonly (RowPart & { toolCallId?: string; id?: string })[]): string[] {
	const counts = new Map<string, number>();
	const used = new Set<string>();
	return parts.map((p, i) => {
		let key: string;
		if (p.type.startsWith("tool-") && p.toolCallId) key = `c:${p.toolCallId}`;
		else if (p.type.startsWith("data-") && p.id) key = `d:${p.id}`;
		else {
			const n = counts.get(p.type) ?? 0;
			counts.set(p.type, n + 1);
			key = `${p.type}#${n}`;
		}
		if (used.has(key)) key = `${key}@${i}`;
		used.add(key);
		return key;
	});
}

/**
 * The `step-start` indexes that get a hairline: the step has something to
 * show AND something showed above it. A step of only hidden rows draws no
 * line, so hairlines never stack.
 */
export function stepSeparators(parts: readonly RowPart[]): Set<number> {
	const out = new Set<number>();
	let seenShown = false;
	let i = 0;
	while (i < parts.length) {
		const isStep = parts[i]!.type === "step-start";
		let j = i + 1;
		while (j < parts.length && parts[j]!.type !== "step-start") j++;
		const stepShows = parts.slice(isStep ? i + 1 : i, j).some(partShows);
		if (isStep && seenShown && stepShows) out.add(i);
		if (stepShows) seenShown = true;
		i = j;
	}
	return out;
}
