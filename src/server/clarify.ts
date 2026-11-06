import type { Usage } from "@earendil-works/pi-ai";
import { agentSystemPrompt, type AgentKind } from "../agent/teacher-agent.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { activeProblemOf, asAgentMessages, hasProbeDone, pendingQuestionOf, toLlmMessages } from "../core/native-messages.ts";
import { emit } from "../core/events.ts";
import { resolveLessonLanguage } from "../core/language.ts";
import { resolvePace } from "../core/pace.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import {
	CLARIFY_ANCHOR_MAX,
	CLARIFY_CALL_ID_MAX,
	CLARIFY_QUESTION_MAX,
	CLARIFY_QUOTE_MAX,
	type CallUsage,
	type ClarifyAnchor,
	type ClarifyEntry,
	type ClarifyThread,
} from "../core/contracts.ts";
import { awaitCompaction } from "./compaction.ts";
import { courseForTurn } from "./courses.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { materialsForTurn } from "./materials.ts";
import { providerKeyPresent } from "./keys.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * The clarification call (owner design, 2026-11-01; margin threads 2026-11-02): the learner marks a passage of the
 * learning text and asks about it, in a bubble beside the line; follow-ups extend the same thread. ONE text-only model
 * call answers each question — on the chat's own conversation engine, with the SAME system prompt and the record's
 * history (the model already has the context; no tools, so it cannot touch the record). The reply is stored in the
 * record's `clarifyThreads` and never enters `messages`, so the tutor's next turn does not see it.
 *
 * While a quiz question is pending the tutor is told never to reveal its answer; with none pending it answers freely.
 */

/** A clarification must never take longer than the learner will wait. */
export const CLARIFY_TIMEOUT_MS = 120_000;

/** The instruction appended to the history as the call's one user message. `pending` = a quiz question is waiting for the
 *  learner's answer: the only place the "never reveal the answer" rule lives. `earlier` = this thread's earlier pairs. */
export function clarifyPrompt(input: {
	quote: string;
	question: string;
	earlier: readonly Pick<ClarifyEntry, "question" | "reply">[];
	pending: boolean;
}): string {
	const lines = input.pending
		? [
				"[CLARIFICATION — NOT AN ANSWER] The learner has NOT answered your pending question yet. Before answering it they marked a passage of the lesson text and are asking you about it.",
				"Clarify what they ask: explain the marked passage, the concept or the wording of the question. You may rephrase the pending question.",
				"Do NOT state, confirm, rule out or hint at the correct answer to the pending question, and do not say which option is right or wrong. If the question can only be answered by giving the answer away, say so briefly and explain the underlying idea instead.",
			]
		: [
				"[CLARIFICATION] The learner marked a passage of the lesson text and is asking you about it. No question is waiting for an answer right now.",
				"Clarify what they ask: explain the marked passage or the concept plainly, with the lesson so far as context.",
			];
	lines.push("Reply with plain text only (no tool calls), short and direct.");
	if (input.earlier.length > 0) {
		lines.push("", "The conversation about this passage so far:");
		for (const c of input.earlier) lines.push(`Learner: ${c.question}`, `You: ${c.reply}`, "");
	}
	lines.push("", `Marked text: “${input.quote}”`, `Learner's ${input.earlier.length > 0 ? "follow-up" : "question"}: ${input.question}`);
	return lines.join("\n");
}

/** The agent kind whose system prompt this chat's turns run on (the same seam
 *  chat-handler's agent construction branches on). */
function kindOf(record: NonNullable<ReturnType<typeof stores.chatStore.getChat>>): AgentKind {
	if (record.course?.mode === "placement") return "placement";
	if (record.kind === "practice") return "practice";
	return hasProbeDone(record.messages) ? "teacher" : "prober";
}

function bad(error: string, status: number): Response {
	return Response.json({ error }, { status });
}

/** The anchor of a new thread, or null when the body's is malformed. */
export function parseAnchor(raw: unknown): ClarifyAnchor | null {
	const a = (raw ?? {}) as { messageId?: unknown; text?: unknown; occurrence?: unknown; callId?: unknown };
	if (typeof a.messageId !== "string" || !a.messageId) return null;
	if (typeof a.text !== "string" || !a.text.trim() || a.text.length > CLARIFY_ANCHOR_MAX) return null;
	if (typeof a.occurrence !== "number" || !Number.isInteger(a.occurrence) || a.occurrence < 0 || a.occurrence > 10_000) return null;
	if (a.callId === undefined) return { messageId: a.messageId, text: a.text, occurrence: a.occurrence };
	if (typeof a.callId !== "string" || !a.callId || a.callId.length > CLARIFY_CALL_ID_MAX) return null;
	return { messageId: a.messageId, text: a.text, occurrence: a.occurrence, callId: a.callId };
}

/** GET /api/chats/[id]/clarify — every margin thread of the chat. */
export function handleClarifyRead(chatId: string): Response {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return bad("Unknown chat", 404);
	return Response.json({ threads: record.clarifyThreads ?? [] });
}

/**
 * POST /api/chats/[id]/clarify — body {question, threadId} for a follow-up, or {question, anchor, quote} for a new
 * thread. Answers {thread}: the whole thread, with the new pair last.
 */
export async function handleClarifyRequest(
	chatId: string,
	body: unknown,
	/** Test seam: a scripted engine replaces the chat's conversation engine. */
	engineOverride?: PiEngine,
): Promise<Response> {
	const raw = (body ?? {}) as { threadId?: unknown; anchor?: unknown; quote?: unknown; question?: unknown };
	const question = typeof raw.question === "string" ? raw.question.trim() : "";
	if (!question) return bad("Write a question first", 400);
	if (question.length > CLARIFY_QUESTION_MAX) return bad("The question is too long", 400);

	let record = stores.chatStore.getChat(chatId);
	if (!record) return bad("Unknown chat", 404);

	// A follow-up names its thread; a new thread brings its anchor and the marked text.
	let thread: Pick<ClarifyThread, "id" | "anchor" | "quote" | "entries">;
	if (typeof raw.threadId === "string" && raw.threadId) {
		const existing = record.clarifyThreads?.find((t) => t.id === raw.threadId);
		if (!existing) return bad("That thread no longer exists", 404);
		thread = existing;
	} else {
		const anchor = parseAnchor(raw.anchor);
		const quote = typeof raw.quote === "string" ? raw.quote.trim() : "";
		if (!anchor) return bad("Mark some text first", 400);
		if (!quote) return bad("Mark some text first", 400);
		if (quote.length > CLARIFY_QUOTE_MAX) return bad("The marked text is too long", 400);
		const anchorMessage = record.messages.find((m) => (m as { id?: string }).id === anchor.messageId) as { content?: unknown } | undefined;
		if (!anchorMessage) return bad("That text is no longer in the session", 400);
		// Text marked in a question's wording names the call it belongs to; that call must be in this message.
		if (anchor.callId !== undefined) {
			const blocks = Array.isArray(anchorMessage.content) ? (anchorMessage.content as { type?: string; id?: string }[]) : [];
			if (!blocks.some((b) => b.type === "toolCall" && b.id === anchor.callId)) return bad("That text is no longer in the session", 400);
		}
		thread = { id: crypto.randomUUID(), anchor, quote, entries: [] };
	}

	// One model call per chat at a time, and never over a running turn (its messages are not saved yet).
	if (isTurnRunning(chatId)) return bad("The tutor is writing right now. Try again in a moment.", 409);

	const effective = effectiveSettings();
	const conversation = resolveConversationSpec(record.settings, effective.models.strong);
	if (!conversation && !engineOverride) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	if (conversation && !engineOverride) {
		if (isSubscriptionProvider(conversation.provider)) await refreshConnectionCatalog(conversation.provider);
		if (!providerKeyPresent(conversation.provider)) {
			return Response.json(providerKeyMissingEnvelope(conversation.provider, ["strong"]), { status: 503 });
		}
	}

	// A compaction in flight rewrites the history this call reads.
	await awaitCompaction(chatId);
	record = stores.chatStore.getChat(chatId);
	if (!record) return bad("Unknown chat", 404);
	// Read AFTER the awaits: the learner may have answered meanwhile.
	const pending = pendingQuestionOf(record.messages);
	// An open practice problem is a question waiting for its learner as well: its solution is never revealed (owner, 2026-11-06).
	const waiting = pending !== null || activeProblemOf(record.messages) !== null;

	let engine: PiEngine;
	try {
		engine =
			engineOverride ??
			piEngineForSpec(conversation!, false, undefined, () => effectiveSettings().models?.strong?.cacheRetention);
	} catch {
		return bad("The selected model is unavailable.", 503);
	}

	const course = courseForTurn(chatId);
	const systemPrompt = agentSystemPrompt(kindOf(record), {
		promptSwitches: effective.agent.prompts,
		language: resolveLessonLanguage(record.settings),
		pace: { level: resolvePace(record.settings), note: course?.note ?? record.settings?.paceNote },
		materials: materialsForTurn(chatId),
		...(course ? { course: { section: course.section } } : {}),
	});

	const steps: CallUsage[] = [];
	const collect = (usage: Usage) => {
		steps.push({
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
			reasoningTokens: usage.reasoning ?? 0,
		});
	};
	let reply: string;
	try {
		const result = await runSubagent([], {
			// The engine is always injected (the chat's own conversation engine);
			// the role label never resolves one — compaction's precedent.
			role: "researcher" as never,
			engine,
			systemPrompt,
			messages: asAgentMessages(record.messages),
			convertToLlm: (messages) => toLlmMessages(messages),
			prompt: clarifyPrompt({ quote: thread.quote, question, earlier: thread.entries, pending: waiting }),
			maxTurns: 1,
			abortSignal: AbortSignal.timeout(CLARIFY_TIMEOUT_MS),
			onUsage: collect,
			chatId,
		});
		reply = result.text.trim();
	} catch (error) {
		console.error(`[chat ${chatId}] clarification failed:`, error);
		return bad("The tutor could not answer just now. Try again.", 502);
	}
	if (!reply) return bad("The tutor sent an empty answer. Try again.", 502);

	const entry: ClarifyEntry = { id: crypto.randomUUID(), question, reply, at: new Date().toISOString() };
	try {
		stores.chatStore.appendClarifyEntry(chatId, thread, entry);
		// The money channel: the call is real spend, filed under the pending question's message (or the newest tutor message).
		const anchorMessageId =
			pending?.messageId ?? [...record.messages].reverse().find((m) => (m as { role?: string }).role === "assistant")?.id;
		if (steps.length > 0 && anchorMessageId) {
			stores.chatStore.appendTurnUsage(chatId, {
				id: `clarify_${entry.id}`,
				messageId: anchorMessageId,
				at: entry.at,
				model: `${engine.model.provider}:${engine.model.id}`,
				steps,
			});
		}
	} catch (error) {
		console.error(`[chat ${chatId}] clarification not saved:`, error);
		return bad("The answer could not be saved. Try again.", 500);
	}
	emit("record-changed", { chatId });
	const saved = stores.chatStore.getChat(chatId)?.clarifyThreads?.find((t) => t.id === thread.id);
	return Response.json({ thread: saved });
}
