import type { Usage } from "@earendil-works/pi-ai";
import { agentSystemPrompt, type AgentKind } from "../agent/teacher-agent.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { asAgentMessages, hasProbeDone, pendingQuestionOf, toLlmMessages } from "../core/native-messages.ts";
import { emit } from "../core/events.ts";
import { resolveLessonLanguage } from "../core/language.ts";
import { resolvePace } from "../core/pace.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import { CLARIFY_QUESTION_MAX, CLARIFY_QUOTE_MAX, type CallUsage, type Clarification } from "../core/contracts.ts";
import { awaitCompaction } from "./compaction.ts";
import { courseForTurn } from "./courses.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { materialsForTurn } from "./materials.ts";
import { providerKeyPresent } from "./keys.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * The clarification call (owner design, 2026-11-01): while a quiz question is
 * pending, the learner marks a passage of the learning text and asks about it.
 * ONE text-only model call answers it — on the chat's own conversation engine,
 * with the SAME system prompt and the record's history up to the pending
 * question (the model already has the context; no tools, so it cannot touch the
 * record). The reply is stored in the record's side thread (`clarifications`,
 * keyed by the pending question) and never enters `messages`, so the tutor's
 * next turn does not see it.
 */

/** A clarification must never take longer than the learner will wait. */
export const CLARIFY_TIMEOUT_MS = 120_000;

/** The instruction appended to the history as the call's one user message. It is
 *  the only place the "never reveal the answer" rule lives. */
export function clarifyPrompt(input: {
	quote: string;
	question: string;
	earlier: readonly Pick<Clarification, "quote" | "question" | "reply">[];
}): string {
	const lines = [
		"[CLARIFICATION — NOT AN ANSWER] The learner has NOT answered your pending question yet. Before answering it they marked a passage of the learning text and are asking you about it.",
		"Clarify what they ask: explain the marked passage, the concept or the wording of the question. You may rephrase the pending question.",
		"Do NOT state, confirm, rule out or hint at the correct answer to the pending question, and do not say which option is right or wrong. If the question can only be answered by giving the answer away, say so briefly and explain the underlying idea instead.",
		"Reply with plain text only (no tool calls), short and direct.",
	];
	if (input.earlier.length > 0) {
		lines.push("", "Earlier clarifications on this question:");
		for (const c of input.earlier) lines.push(`Marked: “${c.quote}”`, `Learner: ${c.question}`, `You: ${c.reply}`, "");
	}
	lines.push("", `Marked text: “${input.quote}”`, `Learner's question: ${input.question}`);
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

/** GET /api/chats/[id]/clarify?key=… — the side thread of one question. */
export function handleClarifyRead(chatId: string, key: string): Response {
	if (!key) return bad("Missing question key", 400);
	const record = stores.chatStore.getChat(chatId);
	if (!record) return bad("Unknown chat", 404);
	return Response.json({ clarifications: record.clarifications?.[key] ?? [] });
}

/** POST /api/chats/[id]/clarify — body {key, quote, question}. */
export async function handleClarifyRequest(
	chatId: string,
	body: unknown,
	/** Test seam: a scripted engine replaces the chat's conversation engine. */
	engineOverride?: PiEngine,
): Promise<Response> {
	const raw = (body ?? {}) as { key?: unknown; quote?: unknown; question?: unknown };
	const key = typeof raw.key === "string" ? raw.key : "";
	const quote = typeof raw.quote === "string" ? raw.quote.trim() : "";
	const question = typeof raw.question === "string" ? raw.question.trim() : "";
	if (!key) return bad("Missing question key", 400);
	if (!quote) return bad("Mark some text first", 400);
	if (!question) return bad("Write a question first", 400);
	if (quote.length > CLARIFY_QUOTE_MAX) return bad("The marked text is too long", 400);
	if (question.length > CLARIFY_QUESTION_MAX) return bad("The question is too long", 400);

	let record = stores.chatStore.getChat(chatId);
	if (!record) return bad("Unknown chat", 404);
	// Only while the quiz question is waiting, and only one turn at a time.
	if (isTurnRunning(chatId)) return bad("The tutor is busy right now", 409);
	const pending = pendingQuestionOf(record.messages);
	if (!pending || pending.key !== key) return bad("That question is no longer waiting for an answer", 409);

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
	const stillPending = pendingQuestionOf(record.messages);
	if (!stillPending || stillPending.key !== key) return bad("That question is no longer waiting for an answer", 409);

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
	const earlier = record.clarifications?.[key] ?? [];
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
			prompt: clarifyPrompt({ quote, question, earlier }),
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

	const entry: Clarification = {
		id: crypto.randomUUID(),
		quote,
		question,
		reply,
		at: new Date().toISOString(),
	};
	try {
		stores.chatStore.appendClarification(chatId, stillPending.key, entry);
		// The money channel: the call is real spend, filed under the question's message.
		if (steps.length > 0) {
			stores.chatStore.appendTurnUsage(chatId, {
				id: `clarify_${entry.id}`,
				messageId: stillPending.messageId,
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
	return Response.json({ clarification: entry });
}
