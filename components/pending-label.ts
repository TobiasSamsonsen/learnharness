/**
 * The one live line of a running turn (owner, 2026-11-17: "like most LLM
 * chats, the next move just changes the thinking line"). While a tutor turn
 * runs the transcript shows a single status line whose text follows the tool
 * that is executing; it never drops out between steps or phases, and the
 * per-step Reasoning rows stay hidden until the turn is done. PURE, browser-safe.
 */

/** The minimal part shape both helpers read (a subset of LhViewPart). */
export interface LivePart {
	type: string;
	state?: string;
	output?: unknown;
}

export interface LiveMessage {
	role: string;
	parts: readonly LivePart[];
}

/** The label per tool, without the trailing ellipsis (uppercased by the line). */
const TOOL_LABELS: Readonly<Record<string, string>> = {
	material_search: "Searching materials",
	material_read: "Reading materials",
	plan_init: "Planning",
	probe: "Writing a question",
	quiz: "Writing a question",
	explain: "Writing a question",
	probe_done: "Assessing",
};

export const DEFAULT_PENDING_LABEL = "Thinking";

/** A tool call that is still executing (its arguments are streaming or it has not returned). */
const isRunningTool = (p: LivePart): boolean =>
	p.type.startsWith("tool-") && (p.state === "input-streaming" || p.state === "input-available");

/**
 * The label for the line right now: the tool running at the tail of the
 * newest assistant message, else "Thinking". Only a RUNNING tool names the
 * line: once it returns, the model is thinking about the next move again.
 */
export function pendingLabel(messages: readonly LiveMessage[]): string {
	const last = messages.at(-1);
	if (!last || last.role !== "assistant") return DEFAULT_PENDING_LABEL;
	const tail = last.parts.at(-1);
	if (!tail || !isRunningTool(tail)) return DEFAULT_PENDING_LABEL;
	return TOOL_LABELS[tail.type.slice("tool-".length)] ?? DEFAULT_PENDING_LABEL;
}

/**
 * True when the tutor is writing visible text right now: the newest part of
 * the newest assistant message is non-empty text. The thinking is done, so the
 * live line goes quiet (owner, 2026-11-17: it must stop when the plan is
 * written). It comes back when the next tool call or thinking part arrives.
 * The caller applies this only while a stream is live: between turns the
 * transcript's tail is the previous turn's text.
 */
export function isWritingText(messages: readonly LiveMessage[]): boolean {
	const last = messages.at(-1);
	if (!last || last.role !== "assistant") return false;
	const tail = last.parts.at(-1) as (LivePart & { text?: string }) | undefined;
	return tail?.type === "text" && (tail.text ?? "").trim() !== "";
}

/**
 * True when the transcript ends on a concluded probe whose planning wake has
 * not started: the last message is an assistant one holding a clean
 * `probe_done`, followed only by reasoning/text/step parts (the planning
 * turn's first tool call or plan block ends this). The server starts that
 * wake about a second after the probe turn settles; the client bridges the
 * gap with the live line (a failed `probe_done` queues no wake, so it is
 * not owed).
 */
export function probeHandoffOwed(messages: readonly LiveMessage[]): boolean {
	const last = messages.at(-1);
	if (!last || last.role !== "assistant") return false;
	let at = -1;
	for (let i = last.parts.length - 1; i >= 0; i--) {
		if (last.parts[i]!.type === "tool-probe_done") {
			at = i;
			break;
		}
	}
	if (at < 0) return false;
	const done = last.parts[at]!;
	if (done.state !== "output-available") return false;
	if ((done.output as { ok?: unknown } | null | undefined)?.ok === false) return false;
	return last.parts.slice(at + 1).every((p) => p.type === "reasoning" || p.type === "text" || p.type === "step-start");
}

/** How long the client bridges the hand-off gap before giving up (a failed wake must not spin forever). */
export const HANDOFF_WAIT_MS = 8000;
