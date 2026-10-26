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
import { QUESTION_TOOLS } from "./pending.ts";
import { sketchOfMessage } from "./sketch.ts";

export const READ_SKETCH_TOOL = "read_sketch";
/** The marker the learner's dispute appends (native-messages.ts). */
export const SKETCH_DISPUTE_MARKER = "sketch-dispute";

/** What the tutor recorded about one sketch. */
export interface SketchReading {
	reading: string;
	uncertain: string[];
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

/** Parse a read_sketch call's arguments (the model authored them — the
 *  tool's schema vouches, this stays defensive for old or odd records). */
function readingOf(args: unknown): { sketchId: string; reading: SketchReading } | null {
	if (typeof args !== "object" || args === null) return null;
	const a = args as { sketchId?: unknown; reading?: unknown; uncertain?: unknown };
	if (typeof a.sketchId !== "string" || typeof a.reading !== "string") return null;
	const uncertain = Array.isArray(a.uncertain) ? a.uncertain.filter((u): u is string => typeof u === "string") : [];
	return { sketchId: a.sketchId, reading: { reading: a.reading, uncertain } };
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

/** The sketches whose pages ride as text stubs instead of images in a
 *  request: CONFIRMED (read, no doubts, no open dispute) and CLOSED. A
 *  practice submission closes when a newer problem is posed; an answer's
 *  sketch closes when a later question is answered. Each projection then
 *  changes at most once per sketch (a dispute re-opens it: the re-read
 *  needs the image). */
export function sketchReplayPlan(messages: readonly AgentMessage[]): Set<string> {
	let lastPose = -1;
	let lastAnswer = -1;
	messages.forEach((m, i) => {
		const role = (m as { role?: string }).role;
		if (role === "assistant") {
			if ((m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.name === "problem")) lastPose = i;
		} else if (role === "toolResult") {
			if ((QUESTION_TOOLS as readonly string[]).includes((m as ToolResultMessage).toolName)) lastAnswer = i;
		}
	});
	const states = sketchStatesOf(messages);
	const elided = new Set<string>();
	messages.forEach((m, i) => {
		const ref = sketchOfMessage(m);
		if (!ref || !isConfirmed(states.get(ref.id))) return;
		const role = (m as { role?: string }).role;
		const closed = role === "custom" ? lastPose > i : lastAnswer > i;
		if (closed) elided.add(ref.id);
	});
	return elided;
}

/** The tutor's recorded reading of a sketch, if any (compaction's words). */
export function sketchReadingText(messages: readonly AgentMessage[], sketchId: string): string | null {
	return sketchStatesOf(messages).get(sketchId)?.read?.reading ?? null;
}
