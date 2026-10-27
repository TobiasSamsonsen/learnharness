/**
 * Retries in the transcript (owner, 2026-10-27). A step whose tool calls all
 * errored back to the agent, with no text of its own, is a retry: the agent
 * reads the error and tries again. Once the lesson has moved on the retry is
 * not shown at all, so it reads as if it never happened. While it is the
 * newest thing (or if the turn ends on it) ONE quiet line stands for the whole
 * run of retries: it takes the place the next step will fill, so nothing
 * shifts when real content arrives. PURE, browser-safe.
 */

export interface StepPart {
	type: string;
	state?: string;
	errorText?: string;
	text?: string;
}

/** A call that errored back to the agent. An abort is terminal: nothing retries. */
const isFailedCall = (p: StepPart): boolean =>
	p.type.startsWith("tool-") && p.state === "output-error" && p.errorText !== "Operation aborted";

const hasText = (step: readonly StepPart[]): boolean => step.some((p) => p.type === "text" && (p.text ?? "").trim() !== "");

export interface RetryPlan {
	/** Part indexes that render nothing (every part of every retry step). */
	hidden: ReadonlySet<number>;
	/** The index where the single "Retrying…" line stands, if the message ends on retries. */
	lineAt: number | null;
	/** The first part index that renders anything: no step separator goes above it. */
	first: number;
}

export function retryPlan(parts: readonly StepPart[]): RetryPlan {
	const starts: number[] = [];
	parts.forEach((p, i) => {
		if (p.type === "step-start" || (i === 0 && starts.length === 0)) starts.push(i);
	});
	const hidden = new Set<number>();
	let lineAt: number | null = null;
	for (let k = 0; k < starts.length; k++) {
		const from = starts[k]!;
		const to = starts[k + 1] ?? parts.length;
		const step = parts.slice(from, to);
		const tools = step.filter((p) => p.type.startsWith("tool-"));
		let absorbed = tools.length > 0 && tools.every(isFailedCall) && !hasText(step);
		// The step after a run of retries, before it has said or posed anything
		// (thinking, a call still streaming): the retry is still the newest
		// thing, so the line stays put instead of flickering away and back.
		if (!absorbed && k === starts.length - 1 && lineAt !== null) {
			absorbed = !hasText(step) && !tools.some((p) => p.state === "output-available");
		}
		if (!absorbed) {
			lineAt = null;
			continue;
		}
		if (lineAt === null) lineAt = from;
		for (let i = from; i < to; i++) hidden.add(i);
	}
	let first = 0;
	while (first < parts.length && hidden.has(first) && first !== lineAt) first++;
	return { hidden, lineAt, first: Math.min(first, Math.max(parts.length - 1, 0)) };
}

/** The parts with every retry step blanked, indexes kept: what the phase
 *  logic should see (a refused first question never counted as the flip). */
export function withoutRetries<T extends StepPart>(parts: readonly T[], plan: RetryPlan): Array<T | { type: "retry" }> {
	return parts.map((p, i) => (plan.hidden.has(i) ? { type: "retry" } : p));
}
