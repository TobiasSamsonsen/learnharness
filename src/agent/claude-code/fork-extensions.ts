/**
 * What this FORK adds on top of upstream's Claude CLI provider (v0.4.0 merge, 2026-10-29; docs/android/m14-plan.md).
 * Upstream's provider is adopted as is; everything the fork needs that it lacks lives here, and upstream's files
 * only call into it (a handful of one-line hooks), so the next upstream merge stays cheap.
 *
 *   P1  elideConcludedProblems   a concluded practice problem is not replayed on a respawn
 *   P2  normalizeSketchContent   a sketch page counts the same as an image or as a text stub when a live process is
 *                                reused (the process already holds the image it was sent)
 *   P4  parseIdleMs / parseMaxSessions   the owner's operating knobs (LH_CLAUDE_IDLE_MIN, LH_CLAUDE_CODE_MAX_SESSIONS)
 *   P8  idleReuse                a plain answer keeps the process for the next message (LH_CLAUDE_IDLE_REUSE=1, off by
 *                                default so upstream's behaviour and tests hold; the Android shell switches it on)
 *   P5  forkChildEnv             the app's own access token never reaches the CLI
 *
 * (P3, the plan-usage report, is plan-usage.ts; the idle-process reuse lives in stream.ts and live-processes.ts.)
 */

import type { Message } from "@earendil-works/pi-ai";
import { SKETCH_LABEL_RE } from "../../core/sketch.ts";

// ─── P1: replay elision ──────────────────────────────────────────────────────

export interface ElidedProblem {
	/** Index of the message that holds the `problem` pose. */
	from: number;
	/** Index of the last omitted message: the successful `conclude` tool result. */
	to: number;
	statement: string;
	outcome: string;
}

/** The practice problems a fresh process does not need replayed: every problem that was concluded (a `conclude` result
 *  that is not an error) before a LATER problem was posed. The span runs from the pose through that conclude result, so
 *  the problem's thinking markers, sketches and its read_sketch calls drop out, and the active problem always stays in
 *  full. Only the replay is shortened: a live process already holds this history. Pure. */
export function elidedProblems(messages: readonly Message[]): ElidedProblem[] {
	const poses: Array<{ index: number; statement: string }> = [];
	const outcomes = new Map<string, string>(); // conclude call id -> outcome
	const concludes: Array<{ index: number; outcome: string }> = [];
	messages.forEach((message, index) => {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const args = block.arguments as { statement?: unknown; outcome?: unknown };
				if (block.name === "problem") poses.push({ index, statement: typeof args.statement === "string" ? args.statement : "" });
				else if (block.name === "conclude") outcomes.set(block.id, typeof args.outcome === "string" ? args.outcome : "concluded");
			}
		} else if (message.role === "toolResult" && message.toolName === "conclude" && !message.isError) {
			concludes.push({ index, outcome: outcomes.get(message.toolCallId) ?? "concluded" });
		}
	});
	const out: ElidedProblem[] = [];
	poses.forEach((pose, k) => {
		const next = poses[k + 1];
		if (!next) return; // the active problem stays in full, concluded or not
		const done = concludes.find((c) => c.index > pose.index && c.index < next.index);
		if (done) out.push({ from: pose.index, to: done.index, statement: pose.statement, outcome: done.outcome });
	});
	return out;
}

const OMITTED = Symbol.for("lh.omittedProblemNote");

/** The note that stands in for an elided problem; the transcript renders its text as is (no `[user]` label). */
export function isOmittedNote(message: Message): boolean {
	return (message as { [OMITTED]?: boolean })[OMITTED] === true;
}

function omittedNote(gone: ElidedProblem): Message {
	const stem = gone.statement.replace(/\s+/g, " ").trim();
	const note: Message = {
		role: "user",
		content: `<omitted>An earlier practice problem (${stem.length > 120 ? `${stem.slice(0, 120)}…` : stem}) was concluded as ${gone.outcome}; its messages are left out of this replay.</omitted>`,
		timestamp: 0,
	};
	(note as { [OMITTED]?: boolean })[OMITTED] = true;
	return note;
}

/** The conversation with every elided problem replaced by one omitted-note. Pure; the input is not changed. */
export function elideConcludedProblems(messages: readonly Message[]): Message[] {
	const gone = new Map(elidedProblems(messages).map((e) => [e.from, e]));
	if (gone.size === 0) return [...messages];
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		const span = gone.get(i);
		if (span) {
			out.push(omittedNote(span));
			i = span.to;
		} else {
			out.push(messages[i]!);
		}
	}
	return out;
}

// ─── P2: sketch pages compare equal as an image or as a stub ────────────────

type Block = { type: string; text?: string };

/** Message content for the live-process reuse comparison: a text block that opens with a sketch label (`[sketch sk_… ·
 *  page i/n]`) becomes just that label, and the image block right after it is dropped. A sketch page therefore reads
 *  the same whether it rode as an image or has since turned into a stub (elided, out of the request window,
 *  unreadable): the process already holds the image it was sent, and the stub only matters to a fresh replay. */
export function normalizeSketchContent<T extends string | readonly Block[]>(content: T): T | Block[] {
	if (typeof content === "string") return content;
	const out: Block[] = [];
	let afterLabel = false;
	for (const block of content as readonly Block[]) {
		if (block.type === "text") {
			const label = SKETCH_LABEL_RE.exec(block.text ?? "");
			if (label) {
				out.push({ type: "text", text: `[sketch ${label[1]} · page ${label[2]}/${label[3]}]` });
				afterLabel = true;
				continue;
			}
			afterLabel = false;
		} else if (afterLabel) {
			afterLabel = false; // the image that belongs to the label
			continue;
		}
		out.push(block);
	}
	return out;
}

// ─── P4: operating knobs ─────────────────────────────────────────────────────

/** Live processes kept at most (each holds a model conversation). */
export const DEFAULT_MAX_SESSIONS = 6;
/** With idle reuse on, an idle process dies after this: inside the 1-hour prompt cache (owner decision, M11 Q3). */
export const DEFAULT_IDLE_MIN = 40;
/** Upstream's own idle limit, the default while idle reuse is off. */
export const UPSTREAM_IDLE_MIN = 10;

/** P8 (owner, 2026-10-29: off by default, so upstream's kill-after-answer and its tests stay as they are). `LH_CLAUDE_IDLE_REUSE=1`
 *  keeps the process after a plain answer. Test seam. */
export const idleReuse = { current: globalThis.process?.env?.LH_CLAUDE_IDLE_REUSE === "1" };

/** LH_CLAUDE_CODE_MAX_SESSIONS (Android plan M6): a positive integer; an unset, empty, non-integer or < 1 value is the
 *  default. Pure, for tests. */
export function parseMaxSessions(value: string | undefined): number {
	const text = value?.trim() ?? "";
	if (!/^[0-9]+$/.test(text)) return DEFAULT_MAX_SESSIONS;
	const n = Number(text);
	return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_MAX_SESSIONS;
}

/** LH_CLAUDE_IDLE_MIN (Android plan M11 Q3): minutes an idle process lives, a positive integer; an unset, empty,
 *  non-integer or < 1 value is `fallbackMin` (40 with idle reuse, upstream's 10 without). Returns milliseconds. Pure, for tests. */
export function parseIdleMs(value: string | undefined, fallbackMin: number = DEFAULT_IDLE_MIN): number {
	const text = value?.trim() ?? "";
	const n = /^[0-9]+$/.test(text) ? Number(text) : fallbackMin;
	return (Number.isSafeInteger(n) && n >= 1 ? n : fallbackMin) * 60_000;
}

// ─── P5: the child's environment ─────────────────────────────────────────────

/** The CLI owns its authentication; the app's own access token (headless servers: LH_ACCESS_TOKEN) is not for it. */
export function forkChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out = { ...env };
	delete out.LH_ACCESS_TOKEN;
	return out;
}
