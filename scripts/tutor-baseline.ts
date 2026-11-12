/**
 * tutor-baseline.ts — a scripted learner that drives one real lesson headlessly and measures the tutor.
 *
 * Why (owner, 2026-11-10): the tutor's fixes had only ever been checked on one or two live turns. This plays a fixed
 * learner (right, wrong, "don't know", right-but-confused, ...) against a running server and records, per run:
 * how often each gate refused, how long the tutor's reply was after a miss (and after a correct-but-confused answer),
 * how much of its output reached the learner, whether the picture came before the first question, the number of
 * picture jobs, and the wall time per turn. Run it before and after a prompt or gate change and compare.
 *
 *   npx tsx scripts/tutor-baseline.ts --base http://127.0.0.1:3111 --topic "the epsilon-delta definition of a limit" \
 *     [--model claude-code/sonnet] [--thinking medium] [--language en|nb] [--questions 14] [--out report.json]
 *   npx tsx scripts/tutor-baseline.ts --compare before.json after.json
 *
 * --language nb plays a Norwegian learner (scripts/baseline-lang.ts) and, besides the metrics above, counts praise/filler
 * and estimates how much of the tutor's prose reads as English. --compare prints two --out reports side by side (b − a).
 *
 * The server is a throwaway `next dev -p 3111` with its own LH_DATA_DIR (a copy of data/settings.json with
 * {"claudeCode":{"enabled":true}}); see docs/development.md. It spends real model turns: ~14 questions is one lesson.
 * The script only talks HTTP; it never touches the data directory.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { questionCallsOf, type LhMessage } from "../src/core/native-messages.ts";
import { parseQuestionInput } from "../src/core/tool-parts.ts";
import { SHOW_FIGURE_TOOL, figuresOf, shownFigureIds, unshownFigures } from "../src/core/figure-show.ts";
import { countFiller, englishLeak, formatComparison, learnerLines, tutorProse } from "./baseline-lang.ts";

const arg = (name: string, fallback?: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
};

const BASE = (arg("base", "http://127.0.0.1:3111") as string).replace(/\/$/, "");
const LANGUAGE = arg("language", "en") as string;
/** The scripted learner's lines in the lesson language (the `en` table is the original hard-coded text). */
const LINES = learnerLines(LANGUAGE);
const TOPIC = arg("topic", LINES.defaultTopic) as string;
const [PROVIDER, MODEL_ID] = (arg("model", "claude-code/sonnet") as string).split("/") as [string, string];
const THINKING = arg("thinking", "medium") as string;
const MAX_QUESTIONS = Number(arg("questions", "14"));
const OUT = arg("out");
const TURN_TIMEOUT_MS = 8 * 60_000;

/** What the learner does at the Nth question: cycled. "confused" = a correct pick with low confidence and a stated "I don't understand". */
type Move = "right" | "wrong" | "dontknow" | "confused";
const SCRIPT: Move[] = ["right", "wrong", "confused", "dontknow", "right", "wrong", "right", "confused"];
/** The probe phase (probe / recall / ask_user_question before the plan): mostly right, one miss, so the probe reaches a plan. */
const PROBE_SCRIPT: Move[] = ["right", "right", "wrong", "right"];

const headers = { "content-type": "application/json", origin: BASE };
const call = async (path: string, init?: RequestInit): Promise<Response> => fetch(BASE + path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChatView {
	id: string;
	messages: LhMessage[];
	turnInFlight: boolean;
	turnError?: unknown;
}

async function getChat(id: string): Promise<ChatView> {
	const res = await call(`/api/chats/${id}`);
	if (!res.ok) throw new Error(`GET chat ${res.status}`);
	return (await res.json()) as ChatView;
}

async function settle(id: string): Promise<ChatView> {
	const started = Date.now();
	for (;;) {
		const chat = await getChat(id);
		if (!chat.turnInFlight) return chat;
		if (Date.now() - started > TURN_TIMEOUT_MS) throw new Error("turn did not finish in time");
		await sleep(2000);
	}
}

async function send(id: string, input: unknown): Promise<void> {
	const res = await call("/api/chat", { method: "POST", body: JSON.stringify({ chatId: id, input }) });
	if (!res.ok) throw new Error(`POST /api/chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
	await res.text(); // the turn runs server-side; the stream ends with it
}

/** The learner's answer to a pending question, per the script. */
function answerFor(tool: string, raw: unknown, move: Move, planPending: boolean): Record<string, unknown> {
	const parsed = parseQuestionInput(tool, raw) as Record<string, any> | undefined;
	if (!parsed) throw new Error(`unparseable ${tool} call`);
	const confusedText = LINES.confused;
	const thinking = move === "confused" ? confusedText : move === "wrong" ? LINES.guessing : LINES.followsFromSaid;
	if (tool === "ask_user_question") {
		const options = (parsed.options ?? []) as Array<{ label: string; value: string }>;
		return options.length > 0
			? { kind: "ask", tool, questionText: parsed.question, dontKnow: false, answers: [{ label: options[0]!.label, value: options[0]!.value, index: 1 }], thinking: planPending ? LINES.planOk : thinking }
			: { kind: "ask", tool, questionText: parsed.question, dontKnow: false, answers: [], other: LINES.yesGoOn, text: LINES.yesGoOn };
	}
	if (tool === "explain" || tool === "recall") {
		const base = { kind: "explain", tool, ...(parsed.type ? { questionType: parsed.type } : {}), questionText: parsed.question, thinking };
		if (move === "dontknow") return { ...base, dontKnow: true, answers: [] };
		const committed = String(parsed.correctAnswer ?? parsed.committedAnswer ?? "");
		return { ...base, dontKnow: false, answers: [], text: move === "wrong" ? LINES.wrongExplain : committed.slice(0, 400) || LINES.bestAttempt };
	}
	// quiz / probe: multiple choice
	const options = (parsed.options ?? []) as Array<{ label: string; value: string }>;
	const correct = new Set(Array.isArray(parsed.correctAnswer) ? parsed.correctAnswer : [parsed.correctAnswer]);
	const base = { kind: "quiz", tool, ...(parsed.type ? { questionType: parsed.type } : {}), questionText: parsed.question, options: options.map((o, i) => ({ index: i + 1, label: o.label })), thinking };
	if (move === "dontknow") return { ...base, dontKnow: true, answers: [], correct: false, correctIndices: options.flatMap((o, i) => (correct.has(o.value) ? [i + 1] : [])) };
	const pickIdx = options.findIndex((o) => (move === "wrong" ? !correct.has(o.value) : correct.has(o.value)));
	const at = pickIdx >= 0 ? pickIdx : 0;
	return {
		...base,
		dontKnow: false,
		answers: [{ label: options[at]!.label, value: options[at]!.value, index: at + 1 }],
		correctIndices: options.flatMap((o, i) => (correct.has(o.value) ? [i + 1] : [])),
		correct: correct.has(options[at]!.value),
		confidence: move === "confused" ? 30 : move === "wrong" ? 50 : 90,
		...(move === "confused" ? { readingThinking: confusedText } : {}),
	};
}

// ---- measuring -------------------------------------------------------------------------------------------------

const GATES: Array<[string, RegExp]> = [
	["prose", /^Refused: the learner just answered/],
	["lead-floor", /^Refused: the learner's last answer was/],
	["visual", /^Refused: your plan says this lesson needs a picture/],
	["narration", /^This response contains narration/],
	["key-check", /second model solved this question independently|printed output|second model checked this question before the learner sees it and flagged/],
];

const textOf = (content: unknown): string =>
	Array.isArray(content) ? content.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : typeof content === "string" ? content : "";

interface Row { n: number; move: string; tool: string; leadChars: number; proseChars: number; thinkingChars: number; outputTokens: number; ms: number }

function measure(messages: LhMessage[]) {
	const refusals: Record<string, number> = {};
	let otherErrors = 0;
	let pictureJobs = 0;
	let firstPicture = -1;
	let firstTeachQuestion = -1;
	// Figures wait for show_figure (owner, 2026-11-12): how many teach questions came before the first showing.
	let teachQuestions = 0;
	let teachQuestionsBeforeFirstShow: number | null = null;
	const briefs: string[] = [];
	messages.forEach((m: any, i) => {
		if (m.role === "toolResult" && m.isError) {
			const text = textOf(m.content);
			const gate = GATES.find(([, re]) => re.test(text))?.[0];
			if (gate) refusals[gate] = (refusals[gate] ?? 0) + 1;
			else otherErrors++;
		}
		if (m.role !== "assistant") return;
		for (const b of m.content ?? []) {
			if (b.type !== "toolCall") continue;
			if (b.name === "visual" || b.name === "demo") {
				pictureJobs++;
				briefs.push(String(b.arguments?.brief ?? ""));
				if (firstPicture < 0) firstPicture = i;
			}
			if (b.name === SHOW_FIGURE_TOOL && teachQuestionsBeforeFirstShow === null) teachQuestionsBeforeFirstShow = teachQuestions;
			if ((b.name === "quiz" || b.name === "explain") && b.arguments?.nodeId) {
				if (firstTeachQuestion < 0) firstTeachQuestion = i;
				teachQuestions++;
			}
		}
	});
	const duplicateJobs = briefs.length - new Set(briefs).size;
	const shown = shownFigureIds(messages);
	return {
		refusals,
		otherErrors,
		pictureJobs,
		duplicateJobs,
		pictureBeforeFirstTeachQuestion: firstTeachQuestion < 0 ? null : firstPicture >= 0 && firstPicture <= firstTeachQuestion,
		figuresDelivered: [...figuresOf(messages).values()].filter((f) => f.ok).length,
		figuresShown: shown.size,
		figureShowCalls: messages.reduce((n, m: any) => n + (m.role === "assistant" ? (m.content ?? []).filter((b: any) => b.type === "toolCall" && b.name === SHOW_FIGURE_TOOL).length : 0), 0),
		teachQuestionsBeforeFirstShow,
		unshownAtEnd: unshownFigures(messages).length,
	};
}

/** The reply that followed the learner's last answer: lead + text chars, thinking chars, output tokens (assistant messages after it). */
function replyAfterLastAnswer(messages: LhMessage[]): Omit<Row, "n" | "move" | "tool" | "ms"> {
	let from = 0;
	messages.forEach((m: any, i) => {
		if (m.role === "toolResult" && !m.isError && ["quiz", "explain", "probe", "recall", "ask_user_question"].includes(m.toolName)) from = i + 1;
	});
	let leadChars = 0, proseChars = 0, thinkingChars = 0, outputTokens = 0;
	for (const m of messages.slice(from) as any[]) {
		if (m.role !== "assistant") continue;
		outputTokens += m.usage?.output ?? 0;
		for (const b of m.content ?? []) {
			if (b.type === "text") proseChars += b.text.trim().length;
			else if (b.type === "thinking") thinkingChars += (b.thinking ?? "").length;
			else if (b.type === "toolCall") {
				const lead = typeof b.arguments?.lead === "string" ? b.arguments.lead.trim().length : 0;
				leadChars += lead;
				proseChars += lead;
				if (b.name === "send_to_user" && typeof b.arguments?.message === "string") proseChars += b.arguments.message.trim().length;
			}
		}
	}
	return { leadChars, proseChars, thinkingChars, outputTokens };
}

// ---- the run ---------------------------------------------------------------------------------------------------

async function main() {
	const created = await call("/api/chats", { method: "POST", body: JSON.stringify({ title: `Baseline: ${TOPIC}` }) });
	if (!created.ok) throw new Error(`create chat ${created.status}: ${await created.text()}`);
	const { id } = (await created.json()) as { id: string };
	const set = await call(`/api/chats/${id}/settings`, { method: "PUT", body: JSON.stringify({ model: { provider: PROVIDER, id: MODEL_ID }, thinkingLevel: THINKING, language: LANGUAGE }) });
	if (!set.ok) throw new Error(`settings ${set.status}: ${await set.text()}`);
	console.log(`[baseline] chat ${id} · ${PROVIDER}/${MODEL_ID} · thinking ${THINKING} · ${LANGUAGE}`);

	const rows: Row[] = [];
	let t0 = Date.now();
	await send(id, { type: "text", text: LINES.opening(TOPIC) });
	let questionNo = 0;
	let probeNo = 0;
	let teachNo = 0;
	for (let guard = 0; guard < MAX_QUESTIONS * 3 && questionNo < MAX_QUESTIONS; guard++) {
		const chat = await settle(id);
		if (chat.turnError) console.warn(`[baseline] turn error: ${JSON.stringify(chat.turnError).slice(0, 200)}`);
		const ms = Date.now() - t0;
		const pending = questionCallsOf(chat.messages).filter((q) => q.status === "answerable");
		t0 = Date.now();
		if (pending.length === 0) {
			// a turn that ended on text (the plan, a closing line): the learner goes on
			await send(id, { type: "text", text: LINES.start });
			continue;
		}
		const q = pending[0]!;
		const hasPlan = chat.messages.some((m: any) => m.role === "assistant" && m.content?.some((b: any) => b.type === "toolCall" && b.name === "plan_init"));
		const teaching = q.tool === "ask_user_question" ? hasPlan : q.tool === "quiz" || q.tool === "explain";
		const move = teaching ? SCRIPT[teachNo++ % SCRIPT.length]! : PROBE_SCRIPT[probeNo++ % PROBE_SCRIPT.length]!;
		const reply = replyAfterLastAnswer(chat.messages);
		rows.push({ n: questionNo + 1, move, tool: q.tool, ms, ...reply });
		console.log(`[baseline] q${questionNo + 1} ${q.tool} → ${move} · reply before it: ${reply.leadChars} lead / ${reply.proseChars} prose chars, ${reply.thinkingChars} thinking chars, ${reply.outputTokens} output tokens, ${(ms / 1000).toFixed(0)}s`);
		await send(id, { type: "answer", toolCallId: q.toolCallId, answer: answerFor(q.tool, q.input, move, !hasPlan) });
		questionNo++;
	}
	const finalChat = await settle(id);
	const summary = { chatId: id, topic: TOPIC, model: `${PROVIDER}/${MODEL_ID}`, thinking: THINKING, language: LANGUAGE, questions: questionNo, ...measure(finalChat.messages), rows };
	// what the tutor said to him, over the whole lesson: how much, how much of it is praise/filler, and (nb) how much reads as English
	const prose = tutorProse(finalChat.messages);
	const proseCharsTotal = prose.reduce((n, t) => n + t.length, 0);
	const filler = countFiller(prose, LANGUAGE);

	// the reply that followed each miss / confused answer is the number that matters
	// teach-phase rows only (a probe question carries no lead), and the prose that reached him, not just `lead`:
	// the tutor may answer in a text block or send_to_user instead
	const teach = (r: Row) => r.tool === "quiz" || r.tool === "explain";
	const after = (moves: Move[]) => rows.filter((r, i) => i > 0 && teach(r) && teach(rows[i - 1]!) && moves.includes(rows[i - 1]!.move as Move)).map((r) => r.proseChars);
	const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
	const report = {
		...summary,
		avgProseCharsAfterMiss: avg(after(["wrong", "dontknow"])),
		avgProseCharsAfterConfused: avg(after(["confused"])),
		avgProseCharsAfterRight: avg(after(["right"])),
		avgSecondsPerTurn: avg(rows.map((r) => Math.round(r.ms / 1000))),
		proseCharsTotal,
		fillerHits: filler.total,
		fillerPer1kChars: proseCharsTotal > 0 ? Math.round((filler.total / proseCharsTotal) * 100_000) / 100 : null,
		fillerByTerm: filler.byTerm,
		englishLeak: englishLeak(prose, LANGUAGE),
	};
	console.log(JSON.stringify(report, null, 2));
	if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
}

/** --compare a.json b.json: no server, no model turns; prints the two --out reports side by side. */
function compare(): void {
	const i = process.argv.indexOf("--compare");
	const [fileA, fileB] = [process.argv[i + 1], process.argv[i + 2]];
	if (!fileA || !fileB) throw new Error("usage: --compare a.json b.json");
	console.log(formatComparison(JSON.parse(readFileSync(fileA, "utf8")), JSON.parse(readFileSync(fileB, "utf8")), basename(fileA), basename(fileB)));
}

(process.argv.includes("--compare") ? Promise.resolve().then(compare) : main()).catch((err) => {
	console.error("[baseline] FAIL:", err);
	process.exit(1);
});
