/**
 * Figures wait for the tutor (owner, 2026-11-12). PURE, browser-safe.
 *
 * A `visual` or `demo` is ordered early (the visual gate wants it before the
 * first teach question), so a figure that rendered on arrival landed right
 * after the plan, far from the explanation it was made for. Now a finished
 * figure stays hidden until the tutor calls `show_figure`, which puts the card
 * in the transcript at that point of its teaching turn (never inside the
 * question popup). Before that the learner sees nothing: not the ordering
 * line, not the arrival, not a failure.
 *
 * Old chats stay as they were: only a dispatch result and a delivery that
 * carry `onShow: true` (written by the code from this change on) are hidden.
 * The record is the source of truth for every lookup here, because job
 * records (data/jobs) never sync between devices.
 */

import { isSubagentFailure, type DemoResult, type JobResult, type SteerDetails } from "./contracts/jobs.ts";

/** The tool that shows a finished figure or demo. */
export const SHOW_FIGURE_TOOL = "show_figure";

/** The job tools whose results wait for show_figure. */
export const FIGURE_TOOLS: readonly string[] = ["visual", "demo"];

/** The flag a figure dispatch's result details and its delivery's details carry. */
export interface OnShowFlag {
	onShow?: true;
}

/** What a figure dispatch's result details hold (the ack text rides `content`). */
export interface FigureDispatchDetails extends OnShowFlag {
	jobId: string;
}

/** One delivered figure or demo, read from its delivery marker. */
export interface FigureEntry {
	jobId: string;
	/** The delivery marker's id: the invert switch writes to it. */
	steerId: string;
	kind: "visual" | "demo";
	/** The dispatching call. */
	toolCallId: string;
	result: JobResult;
	ui?: { inverted?: boolean };
	/** False for a figure that could not be made. */
	ok: boolean;
	/** True when it waits for show_figure (delivered after the change). */
	onShow: boolean;
}

interface LooseMessage {
	id?: string;
	role?: string;
	customType?: string;
	details?: unknown;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

interface LooseToolCall {
	type?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

/** The figure a delivery marker carries, or undefined for any other message. */
export function figureSteerOf(message: unknown): FigureEntry | undefined {
	const m = message as LooseMessage;
	if (m.role !== "custom" || m.customType !== "subagent-steer") return undefined;
	const d = m.details as (Partial<SteerDetails> & OnShowFlag) | null | undefined;
	if (!d || (d.kind !== "visual" && d.kind !== "demo") || typeof d.jobId !== "string") return undefined;
	const result = d.result as JobResult;
	return {
		jobId: d.jobId,
		steerId: m.id ?? `steer_${d.jobId}`,
		kind: d.kind,
		toolCallId: typeof d.toolCallId === "string" ? d.toolCallId : "",
		result,
		...(d.ui ? { ui: d.ui } : {}),
		ok: result !== undefined && result !== null && !isSubagentFailure(d.kind, result),
		onShow: d.onShow === true,
	};
}

/** Every delivered figure in the record, by job id. */
export function figuresOf(messages: readonly unknown[]): Map<string, FigureEntry> {
	const out = new Map<string, FigureEntry>();
	for (const m of messages) {
		const figure = figureSteerOf(m);
		if (figure) out.set(figure.jobId, figure);
	}
	return out;
}

/** Does a figure dispatch render in the transcript? Only a call that settled
 *  cleanly WITHOUT the flag (one from before this change) does; a running,
 *  failed or flagged call is hidden. */
export function figureDispatchShown(result: { isError?: boolean; details?: unknown } | undefined): boolean {
	if (!result || result.isError) return false;
	const details = result.details;
	return !(typeof details === "object" && details !== null && (details as OnShowFlag).onShow === true);
}

/** The dispatching calls whose figures wait for show_figure (their settled result carries the flag). */
export function hiddenFigureDispatches(messages: readonly unknown[]): Set<string> {
	const out = new Set<string>();
	for (const m of messages) {
		const r = m as LooseMessage;
		if (r.role !== "toolResult" || !FIGURE_TOOLS.includes(r.toolName ?? "") || r.isError) continue;
		const details = r.details as OnShowFlag | null | undefined;
		if (typeof details === "object" && details !== null && details.onShow === true && r.toolCallId) out.add(r.toolCallId);
	}
	return out;
}

/** The job ids the tutor has shown: every show_figure call that was not refused. */
export function shownFigureIds(messages: readonly unknown[]): Set<string> {
	const refused = new Set<string>();
	for (const m of messages) {
		const r = m as LooseMessage;
		if (r.role === "toolResult" && r.toolName === SHOW_FIGURE_TOOL && r.isError && r.toolCallId) refused.add(r.toolCallId);
	}
	const out = new Set<string>();
	for (const m of messages) {
		const a = m as LooseMessage;
		if (a.role !== "assistant" || !Array.isArray(a.content)) continue;
		for (const block of a.content as LooseToolCall[]) {
			if (block.type !== "toolCall" || block.name !== SHOW_FIGURE_TOOL || (block.id && refused.has(block.id))) continue;
			const figure = (block.arguments as { figure?: unknown } | null | undefined)?.figure;
			if (typeof figure === "string") out.add(figure.trim());
		}
	}
	return out;
}

const LABEL_MAX = 60;

/** A short human label for a figure: the demo's title, or the start of the visual's brief. */
export function figureLabel(messages: readonly unknown[], figure: FigureEntry): string {
	if (figure.kind === "demo") {
		const title = (figure.result as DemoResult | undefined)?.title;
		if (typeof title === "string" && title.trim()) return shorten(title.trim());
	}
	for (const m of messages) {
		const a = m as LooseMessage;
		if (a.role !== "assistant" || !Array.isArray(a.content)) continue;
		for (const block of a.content as LooseToolCall[]) {
			if (block.type !== "toolCall" || block.id !== figure.toolCallId) continue;
			const args = block.arguments as { title?: unknown; brief?: unknown } | null | undefined;
			const text = typeof args?.title === "string" && args.title.trim() ? args.title : args?.brief;
			if (typeof text === "string" && text.trim()) return shorten(text.trim());
		}
	}
	return figure.kind;
}

function shorten(text: string): string {
	const flat = text.replace(/\s+/g, " ");
	return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX).trimEnd()}…` : flat;
}

/** The finished figures still waiting for show_figure, oldest first. */
export function unshownFigures(messages: readonly unknown[]): FigureEntry[] {
	const shown = shownFigureIds(messages);
	return [...figuresOf(messages).values()].filter((f) => f.onShow && f.ok && !shown.has(f.jobId));
}

/** The soft reminder a teach question's answer carries for the tutor (never shown to the learner), or undefined. */
export function unshownFiguresNote(messages: readonly unknown[]): string | undefined {
	const waiting = unshownFigures(messages);
	if (waiting.length === 0) return undefined;
	const list = waiting.map((f) => `${f.jobId} (${f.kind}: "${figureLabel(messages, f)}")`).join(", ");
	return `Figures ready but not shown yet: ${list}. Show one with show_figure in the turn whose teaching it serves; leave it until then.`;
}
