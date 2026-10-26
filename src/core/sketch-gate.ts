/**
 * Sketch readings — the pure folds (Android plan M2, 2026-10-26).
 *
 * The record is the only truth: a sketch's reading is the `read_sketch`
 * call the tutor made (its arguments) and the clean result that came back;
 * a dispute is a `sketch-dispute` marker. Three things fold from them:
 *
 *  - the CONCLUDE GATE: a problem may not conclude solved while its newest
 *    sketch is unread, doubtful, or disputed (sketchGateOf, noteSketchRead,
 *    sketchConcludeProblems — the closure the practice tools carry, since a
 *    [read_sketch, conclude] batch is not yet in the frozen record);
 *  - REPLAY ELISION: a confirmed sketch whose scope is closed stops riding
 *    as images (sketchReplayPlan) — its reading is already in the record;
 *  - the record's own words for a sketch (readingOf), for compaction.
 *
 * No imports from native-messages at runtime (it imports this): records
 * are read through their plain shapes.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { healEncodedArguments } from "./argument-heal.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import type { SketchRef } from "./contracts/sketch.ts";
import { sketchOfMessage } from "./sketch.ts";

export const READ_SKETCH_TOOL = "read_sketch";
/** The marker the learner's dispute appends (native-messages.ts). */
export const SKETCH_DISPUTE_MARKER = "sketch-dispute";

/** What the tutor recorded about one sketch. */
export interface SketchReading {
	reading: string;
	/** Doubts the tutor could NOT settle — the only ones that block grading. */
	uncertain: string[];
	/** Unclear marks it settled against the committed answer (what it could
	 *  be, what it took): shown to the learner, never a block. */
	settled: string[];
}

export interface SketchState {
	/** The newest clean read_sketch for it; null = never read. */
	read: SketchReading | null;
	/** The learner disputed it after the newest read. */
	disputed: boolean;
}

/** A reading is confirmed when it exists, carries no doubts, and no dispute
 *  has come since. */
export function isConfirmed(state: SketchState | undefined): boolean {
	return !!state?.read && state.read.uncertain.length === 0 && !state.disputed;
}

/** The display-side twin of the tool's schema (the tool-parts law: the
 *  record keeps the model's RAW arguments, so every read of them heals the
 *  same wobbles the agent boundary healed — a leaked `</parameter>` boundary
 *  in `sketchId` (seen live, 2026-10-26), a JSON-string `uncertain`). */
const READ_SKETCH_DISPLAY_SCHEMA = {
	properties: { sketchId: { type: "string" }, reading: { type: "string" }, uncertain: { type: "array" }, settled: { type: "array" } },
};

/** A read_sketch call's arguments, healed for reading. */
export function healReadSketchArguments(args: unknown): unknown {
	return healEncodedArguments(args, READ_SKETCH_DISPLAY_SCHEMA);
}

/** Parse a read_sketch call's arguments (the model authored them — the
 *  tool's schema vouches, this stays defensive for old or odd records). */
export function readSketchCall(rawArgs: unknown): { sketchId: string; reading: SketchReading } | null {
	return readingOf(rawArgs);
}

function readingOf(rawArgs: unknown): { sketchId: string; reading: SketchReading } | null {
	const args = healReadSketchArguments(rawArgs);
	if (typeof args !== "object" || args === null) return null;
	const a = args as { sketchId?: unknown; reading?: unknown; uncertain?: unknown; settled?: unknown };
	if (typeof a.sketchId !== "string" || typeof a.reading !== "string") return null;
	const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : []);
	return { sketchId: a.sketchId, reading: { reading: a.reading, uncertain: strings(a.uncertain), settled: strings(a.settled) } };
}

/** Every sketch's state, folded in record order. A read counts only
 *  through its clean result; a later read clears an earlier dispute. */
export function sketchStatesOf(messages: readonly AgentMessage[]): Map<string, SketchState> {
	const states = new Map<string, SketchState>();
	const stateOf = (id: string): SketchState => {
		let s = states.get(id);
		if (!s) states.set(id, (s = { read: null, disputed: false }));
		return s;
	};
	const calls = new Map<string, { sketchId: string; reading: SketchReading }>();
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "assistant") {
			for (const block of (m as AssistantMessage).content) {
				if (block.type !== "toolCall" || block.name !== READ_SKETCH_TOOL) continue;
				const parsed = readingOf(block.arguments);
				if (parsed) calls.set(block.id, parsed);
			}
		} else if (role === "toolResult") {
			const result = m as ToolResultMessage;
			if (result.toolName !== READ_SKETCH_TOOL || result.isError) continue;
			const call = calls.get(result.toolCallId);
			if (!call) continue;
			const s = stateOf(call.sketchId);
			s.read = call.reading;
			s.disputed = false;
		} else if (role === "custom") {
			const marker = m as { customType?: string; details?: unknown };
			if (marker.customType !== SKETCH_DISPUTE_MARKER) continue;
			const id = (marker.details as { sketchId?: unknown } | null)?.sketchId;
			if (typeof id === "string") stateOf(id).disputed = true;
		}
	}
	return states;
}

/** Is this tool result a clean read_sketch that left doubts open? Such a
 *  result ENDS the turn (the learner clarifies on the card; the tutor writes
 *  nothing until it can read again with no doubts) — the turn stopper and the
 *  continuation fold both read this one test, so they cannot disagree. */
export function isDoubtfulReadResult(m: { toolName?: string; isError?: boolean; details?: unknown }): boolean {
	if (m.toolName !== READ_SKETCH_TOOL || m.isError) return false;
	const doubts = (m.details as { doubts?: unknown } | null)?.doubts;
	return typeof doubts === "number" && doubts > 0;
}

/** The ids of every sketch the record carries (what read_sketch may name). */
export function sketchIdsOf(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		const ref = sketchOfMessage(m);
		if (ref) ids.add(ref.id);
	}
	return ids;
}

// ─── the conclude gate ───────────────────────────────────────────────────────

/** The gate's view of the ACTIVE problem's newest sketch. Mutable: the
 *  practice tools flip it mid-turn (a read_sketch → conclude batch). */
export interface SketchGate {
	id: string;
	read: boolean;
	doubtful: boolean;
	disputed: boolean;
}

/** Seed the gate from the record: the newest sketch submitted on the
 *  active problem, or null (no sketch: nothing to gate). */
export function sketchGateOf(messages: readonly AgentMessage[], activeProblemCallId: string | null): SketchGate | null {
	if (activeProblemCallId === null) return null;
	let newest: string | null = null;
	for (const m of messages) {
		const marker = m as { role?: string; customType?: string; details?: { problemCallId?: unknown } | null };
		if (marker.role !== "custom" || marker.customType !== "practice-thinking") continue;
		if (marker.details?.problemCallId !== activeProblemCallId) continue;
		const ref = sketchOfMessage(m);
		if (ref) newest = ref.id;
	}
	if (newest === null) return null;
	const state = sketchStatesOf(messages).get(newest);
	return {
		id: newest,
		read: !!state?.read,
		doubtful: (state?.read?.uncertain.length ?? 0) > 0,
		disputed: state?.disputed ?? false,
	};
}

/** A read_sketch executed this turn: update the gate if it is the gated
 *  sketch (a read clears a dispute; doubts follow the new reading). */
export function noteSketchRead(gate: SketchGate | null, sketchId: string, uncertain: readonly string[]): void {
	if (!gate || gate.id !== sketchId) return;
	gate.read = true;
	gate.doubtful = uncertain.length > 0;
	gate.disputed = false;
}

/** Why a conclude with this outcome must wait, or [] when it may go. Only
 *  the solved outcomes are gated — a surrender or a move-on is not credit. */
export function sketchConcludeProblems(gate: SketchGate | null, outcome: string): string[] {
	if (!gate || (outcome !== "solved" && outcome !== "solvedWithHints")) return [];
	if (!gate.read) {
		return [`the learner's sketch ${gate.id} is unread — call read_sketch for it first (transcribe exactly what is written), then respond to the work before concluding`];
	}
	if (gate.disputed) {
		return [`the learner disputed your reading of sketch ${gate.id} — call read_sketch again with the corrected reading before concluding`];
	}
	if (gate.doubtful) {
		return [`your reading of sketch ${gate.id} still has open doubts — ask the learner about them, then call read_sketch again before concluding as solved`];
	}
	return [];
}

// ─── replay elision ──────────────────────────────────────────────────────────

/** Where a sketch's pages can ride in a request: the message that carries
 *  the sketch (a practice submission, or a question's answer), or a dispute
 *  marker re-sending it (the re-read needs the image, and the live process
 *  only receives what arrives in a NEW message). */
export interface SketchOccurrence {
	/** Index into the message list. */
	index: number;
	ref: SketchRef;
	kind: "submission" | "answer" | "dispute";
}

/** The sketch a dispute marker names, if it is one. */
function disputedSketchId(m: AgentMessage): string | null {
	const marker = m as { role?: string; customType?: string; details?: unknown };
	if (marker.role !== "custom" || marker.customType !== SKETCH_DISPUTE_MARKER) return null;
	const id = (marker.details as { sketchId?: unknown } | null)?.sketchId;
	return typeof id === "string" ? id : null;
}

/** Every sketch the record carries, by id (its submission's ref). */
export function sketchRefsById(messages: readonly AgentMessage[]): Map<string, SketchRef> {
	const refs = new Map<string, SketchRef>();
	for (const m of messages) {
		const ref = sketchOfMessage(m);
		if (ref) refs.set(ref.id, ref);
	}
	return refs;
}

/** Every place a sketch's pages ride, in record order. */
export function sketchOccurrencesOf(messages: readonly AgentMessage[]): SketchOccurrence[] {
	const refs = sketchRefsById(messages);
	const out: SketchOccurrence[] = [];
	messages.forEach((m, index) => {
		const ref = sketchOfMessage(m);
		if (ref) {
			out.push({ index, ref, kind: (m as { role?: string }).role === "custom" ? "submission" : "answer" });
			return;
		}
		const disputed = disputedSketchId(m);
		const known = disputed ? refs.get(disputed) : undefined;
		if (known) out.push({ index, ref: known, kind: "dispute" });
	});
	return out;
}

/** The occurrences whose pages ride as text stubs instead of images: a
 *  CONFIRMED sketch (a clean, doubt-free read after it) whose scope has
 *  CLOSED (a newer problem was posed / a later question answered, after it).
 *
 *  ONE-WAY by construction: both conditions are "an event after this
 *  occurrence", and events only ever append — so an occurrence flips from
 *  image to stub at most once and never back. A dispute therefore does NOT
 *  re-open the old pages; its own marker re-sends them (a new message the
 *  live process receives), and that copy is stubbed by the same rule once a
 *  clean read follows IT and the scope closes.
 *
 *  Only CLEAN results count as events (the activeProblemOf rule): an
 *  errored pose, or a prose-gate-blocked question, closes nothing. */
export function sketchReplayPlan(messages: readonly AgentMessage[]): Set<number> {
	const confirmations = new Map<string, number[]>();
	const poses: number[] = [];
	const answers: number[] = [];
	const calls = new Map<string, { sketchId: string; reading: SketchReading }>();
	messages.forEach((m, i) => {
		const role = (m as { role?: string }).role;
		if (role === "assistant") {
			for (const block of (m as AssistantMessage).content) {
				if (block.type !== "toolCall" || block.name !== READ_SKETCH_TOOL) continue;
				const parsed = readingOf(block.arguments);
				if (parsed) calls.set(block.id, parsed);
			}
			return;
		}
		if (role !== "toolResult") return;
		const result = m as ToolResultMessage;
		if (result.isError) return;
		if (result.toolName === READ_SKETCH_TOOL) {
			const call = calls.get(result.toolCallId);
			if (call && call.reading.uncertain.length === 0) {
				const list = confirmations.get(call.sketchId) ?? [];
				list.push(i);
				confirmations.set(call.sketchId, list);
			}
		} else if (result.toolName === "problem") {
			poses.push(i);
		} else if ((QUESTION_TOOLS as readonly string[]).includes(result.toolName)) {
			const details = result.details as { dismissed?: unknown } | null;
			if (details && !details.dismissed) answers.push(i);
		}
	});
	const after = (events: readonly number[], index: number) => events.some((e) => e > index);
	const elided = new Set<number>();
	for (const o of sketchOccurrencesOf(messages)) {
		if (!after(confirmations.get(o.ref.id) ?? [], o.index)) continue;
		const closed =
			o.kind === "submission" ? after(poses, o.index) : o.kind === "answer" ? after(answers, o.index) : after(poses, o.index) || after(answers, o.index);
		if (closed) elided.add(o.index);
	}
	return elided;
}

/** The tutor's recorded reading of a sketch, if any (compaction's words). */
export function sketchReadingText(messages: readonly AgentMessage[], sketchId: string): string | null {
	return sketchStatesOf(messages).get(sketchId)?.read?.reading ?? null;
}
