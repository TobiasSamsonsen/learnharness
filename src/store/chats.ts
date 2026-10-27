/**
 * ChatStore — the fs JSON adapter (one file per chat in data/chats/).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatCourseLink, ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, PlanTree, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import { sessionFinishOf } from "../core/course-session.ts";

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

/** THE SILENCE LAW (push S6, 2026-10-02): chats-changed announces ONLY
 *  list-SHAPE mutations — createChat, renameChat, deleteChat (below,
 *  each emits post-write). The content writers (saveMessages,
 *  appendTurnUsage, appendExtractionUsage, saveSettings, saveTree) are
 *  DELIBERATELY SILENT: saveMessages fires per turn-persist and would
 *  spam the bus, and every list-visible change it causes (title, order,
 *  phase, busy, pendingQuestion) is already announced by turn-started /
 *  turn-settled, which the sidebar refetches on. Silence here is law,
 *  not oversight. */
function createChat(title: string, kind?: "practice", course?: ChatCourseLink): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		// Practice sessions carry the marker; teach stays ABSENT (absence
		// reads as teach — pre-practice records never migrate).
		...(kind === "practice" ? { kind: "practice" as const } : {}),
		// The course link (fork addition — docs/courses.md §1.3): stamped
		// here, at birth, and never changed.
		...(course ? { course } : {}),
	};
	fs.mkdirSync(PATHS.chats, { recursive: true });
	writeChat(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION }; // the in-memory twin of what landed on disk
}

/** THE WRITE CHOKE POINT (schema-versioning wave, owner 2026-10-10): every
 *  record persist goes through here and carries the CURRENT version stamp —
 *  lazy migration means existing files only get stamped on their next write.
 *  A future-version guard lives on the read side (getChat). */
function writeChat(record: ChatRecord): void {
	fs.writeFileSync(chatFile(record.id), JSON.stringify({ ...record, version: CURRENT_CHAT_VERSION }, null, "\t"), "utf-8");
	summaryCache.delete(record.id); // our own write: never trust the stat when we know the file changed
}

function getChat(id: string): ChatRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(chatFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (owner ruling 2026-10-10): a record stamped NEWER than
	// this build (the downgrade scenario) reads as absent, never misparsed —
	// the next read-modify-write must not rewrite what it doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return parsed as ChatRecord;
}

/** The list projection of one record (null when the projection fails). */
function summarize({ messages, tree, turns, extractions, ...summary }: ChatRecord): ChatSummary | null {
	// Per-record isolation (Wave B): a record whose messages fail the
	// projection (e.g. pre-Wave-B UIMessage-format scratch — the
	// zero-back-compat wipe makes these "corrupt") must not blank the
	// whole sidebar — same isolation getChat's per-file catch gives.
	try {
		return {
			// turns and extractions stay out of the list payload (list =
			// summaries; usage aggregates ride the full record, the picker
			// never needs them).
			...summary,
			// Normalized kind: absent record field reads as teach.
			kind: summary.kind ?? "teach",
			messageCount: messages.length,
			// Record-derived status for the session picker: phase from the
			// transcript's explicit events (probe_done concluded / verdict
			// accepted — docs/probe-teach-split.md §4), pending question
			// from the native dangling-call scan. Wave D: both folds read
			// the NATIVE record (core/phases.ts phaseAt3Lh +
			// native-messages.ts danglingQuestionOf). Liveness (busy) is
			// NOT record-derived — the API route merges it (ChatListItem).
			phase: phaseAt3Lh(messages),
			pendingQuestion: danglingQuestionOf(messages) !== null,
			// A finished course session (owner, 2026-10-25): the
			// sidebar row says so.
			...(summary.course && sessionFinishOf(messages as LhMessage[]) ? { finished: true } : {}),
			// NOTE (found while caching this, 2026-10-27; behaviour kept as it was): pendingProblem is
			// declared on ChatSummary and read by the sidebar's "Problem waiting" meta, but nothing here
			// ever sets it, so that label never shows. The old code hid it behind an unchecked type guard.
		} as ChatSummary;
	} catch (err) {
		console.error(`[chat ${summary.id}] summary projection failed:`, err);
		return null;
	}
}

/** M11 (docs/android/m11-plan.md Q4, owner: in-memory cache): the list used to
 *  read and parse EVERY chat file on every call (the sidebar asks several times a
 *  turn). A summary is now kept per file and reused while the file's mtime and size
 *  are unchanged; our own writes and deletes drop the entry, so only a foreign edit
 *  that keeps both mtime and size could go unseen. No file-format change. */
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: ChatSummary | null }>();

function listChats(): ChatSummary[] {
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		const present = new Set<string>();
		const out: ChatSummary[] = [];
		for (const f of fs.readdirSync(PATHS.chats)) {
			if (!f.endsWith(".json")) continue;
			const id = f.slice(0, -5);
			present.add(id);
			let st: fs.Stats;
			try {
				st = fs.statSync(chatFile(id));
			} catch {
				summaryCache.delete(id);
				continue; // vanished between readdir and stat
			}
			let hit = summaryCache.get(id);
			if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
				const record = getChat(id);
				hit = { mtimeMs: st.mtimeMs, size: st.size, summary: record ? summarize(record) : null };
				summaryCache.set(id, hit);
			}
			// a copy, so a caller that decorates its list never edits the cache
			if (hit.summary) out.push({ ...hit.summary });
		}
		for (const id of [...summaryCache.keys()]) if (!present.has(id)) summaryCache.delete(id);
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** Persist the full native message list (the record IS the agent state —
 *  Wave B: replay is state.messages = record.messages). SILENT by the
 *  events law — see the SILENCE LAW comment at createChat. */
function saveMessages(id: string, messages: LhMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	writeChat(record);
}

/** Append one usage entry to the record's turn log — idempotent per
 * turn id: each REQUEST carries its own id, so a replay of the same turn's
 * persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	writeChat(record);
}

/** Append one extraction-run usage entry to the record's extractions
 * log — idempotent per startedAt: a retry that reaches the append twice
 * (abort replays) does not double-count spend. */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	writeChat(record);
}

/** Persist the per-chat model/thinking settings — replace-whole (the
 * picker sends the complete object; absent = config defaults). */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Like saveTree: a settings tweak is not conversation activity, so it
	// deliberately does NOT bump updatedAt (sidebar order must not churn).
	record.settings = settings;
	writeChat(record);
}

/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
 * so sidebar order never churns. Same fallback as createChat — the empty
 * string becomes "Untitled session" (the API gate rejects it first; this
 * is the honest floor for any other caller). */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	writeChat(record);
	emit("chats-changed", {});
	return record;
}

/** Delete the session record file entirely (session-deletion wave 6,
 *  owner 2026-09-22). False when the id is unknown — the route turns that
 *  into a 404. The record's graph traces and jobs are the route's
 *  choreography (core/graph-deletion.ts), not the store's. */
function deleteChat(id: string): boolean {
	try {
		fs.unlinkSync(chatFile(id));
		summaryCache.delete(id);
		emit("chats-changed", {}); // only a real removal — the present-entry law
		return true;
	} catch {
		return false; // never existed, already deleted, or unreadable — same answer
	}
}

/** Persist the session plan tree (plan tools call this in execute). */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	writeChat(record);
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	saveMessages,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
};
