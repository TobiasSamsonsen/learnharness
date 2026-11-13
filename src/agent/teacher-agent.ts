import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool, BeforeToolCallContext, PrepareNextTurnContext } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult } from "./tool-execute.ts";
import { providerEventObserver } from "./provider-events.ts";
import type { Usage } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { APP_IDENTITY, piEngineFor, type PiEngine } from "./models.ts";
import { effectivePromptSegments } from "./prompt-segments.ts";
import {
	askUserQuestionTool,
	createProberTools,
	createTeacherTools,
	type ProbeDoneContext,
	type ProberToolContext,
	type TeacherToolContext,
} from "./tools.ts";
import { practiceTools, createPracticeGate, type PracticeGate, type PracticeToolContext } from "./tools/practice.ts";
import { pluginProblemTools, isPluginProblemPoseAcknowledgment, type NativePluginProblemContribution } from "./plugin-problem-tools.ts";
import { placementProbeTool } from "./tools/course.ts";
import { healToolRecord, withArgumentHeal } from "./tools/heal.ts";
import { sendToUserApplies, sendToUserTool } from "./tools/send-to-user.ts";
import { makeNarrationGuard, narrationGuardApplies, SEND_TO_USER_DELIVERY_RULE } from "./narration-guard.ts";
import { CLAUDE_CODE_PROVIDER } from "./claude-code/constants.ts";
import { CLAUDE_CODE_TOOL_NAMES_RULE } from "./claude-code/tool-names-rule.ts";
import { createReadTool, readTool } from "./tools/read.ts";
import { quizInputObject, quizInputProblems } from "../core/question-core.ts";
import { figureInputProblems } from "../core/figures/index.ts";
import { circuitSolveTool, figureGuideTool } from "./tools/figures.ts";
import { readSketchTool } from "./tools/sketch.ts";
import { READ_SKETCH_TOOL, isDoubtfulReadResult, sketchIdsOf } from "../core/sketch-gate.ts";
import { QUESTION_TOOLS, TOGGLEABLE_TOOLS, type EnabledTools } from "../core/pending.ts";
import type { PluginToolContext } from "../core/plugins.ts";
import { toLlmMessages, nativeInputCause, PRACTICE_PROBLEM_TOOL, type SketchImageResolver } from "../core/native-messages.ts";
import { PROSE_GATED_TOOLS, proseGateBlocks, proseGateReason, proseGateRefusedLast } from "../core/prose-gate.ts";
import { leadFloorBlocks, leadFloorReason } from "../core/lead-floor-gate.ts";
import { VISUAL_GATE_REASON, visualGateBlocks } from "../core/visual-gate.ts";
import { SHOW_FIGURE_TOOL } from "../core/figure-show.ts";
import { createShowFigureTool } from "./tools/show-figure.ts";
import type { ChatGPTRequestCycle } from "./chatgpt-request-cycle.ts";
import { usageWasAdmitted } from "./subscription-request-cycle.ts";
import { PluginQuestionLedger, type NativePluginQuestionContribution } from "./plugin-question-tools.ts";
import { DEFAULT_LESSON_LANGUAGE, withLanguageDirective, type LessonLanguage } from "../core/language.ts";
import { paceSection, type Pace } from "../core/pace.ts";
import { difficultySection, type Difficulty } from "../core/difficulty.ts";
import { practiceGradeHook } from "./practice-grade.ts";

/**
 * The two teaching-side agents (docs/archive/probe-teach-split.md): the PROBER and
 * the TEACHER. Same transcript, different prompts and tool sets; the
 * chat-handler constructs ONE per request off the transcript's seam
 * (probe_done = teacher) — the STATELESS per-turn engine (docs/
 * docs/archive/pi-engine-swap.md §2): the persisted record is the source of truth, the
 * agent is rebuilt from it every POST and discarded at turn end.
 *
 * Engines are injectable so tests can pass a scripted faux engine and drive
 * deterministic lessons (see tests/chat-flow.test.ts).
 *
 * System prompts are COMPOSED per agent: system-prompt.md (the shared base:
 * agent, voice, philosophy, accuracy) + every numeric-prefix fragment in
 * that agent's directory (src/agent/prompts/prober/ or
 * src/agent/prompts/teacher/), in sorted filename order, then the shared/
 * fragments as a trailing appendix (question tools, learner files,
 * formatting) — the 2026-09-27 reorder: the agent's job and method lead,
 * the mechanics trail. Joined with `---` separators.
 *
 * ONLY numeric-prefix files load — the loader enforces the convention, so
 * non-fragment documentation (README.md, …) can live in the directories
 * without ever leaking into the model's prompt.
 */

/** Which agent's prompt directory to compose. Practice (2026-10-04)
 *  composes ONLY its own directory — see prompt-segments.ts. */
export type AgentKind = "prober" | "teacher" | "practice" | "placement";

/** Reserve conversation builtins even when role/mechanics/settings gates hide them.
 * New builtin names must join this catalog; actual turn tools are reserved too. */
export const CONVERSATION_TOOL_NAMES = Object.freeze([
	...QUESTION_TOOLS, ...TOGGLEABLE_TOOLS, "probe_done", "read", "ls", "find", "grep",
	"plan_init", "list_sessions", "list_propositions", "problem", "conclude", sendToUserTool.name,
	// The fork's builtins: reserved so no plugin can shadow them (the actual turn's tools are reserved too, this covers the gated-out ones).
	"read_sketch", "figure_guide", "circuit_solve", "probe",
	// show_figure (owner, 2026-11-12 — core/figure-show.ts): rides every teacher, like read_sketch.
	"show_figure",
] as const);

// P2 (2026-09-19): segment discovery + override resolution live in ONE
// canonical place now — src/store/prompt-overrides.ts (listSourceSegments
// mirrors this loader's rules, shared/ included). The agent imports it for
// the static-file seam; the local fragment discovery helpers are retired.

/** Exported for tests: assert what composes into the model's prompt.
 *  Composition order: shared base → shared/ fragments (both agents, the
 *  sources-v1 seam for cross-agent doctrine) → the agent's own fragments.
 *
 *  P2 reconciliation (2026-09-19): composition is DELEGATED to the store
 *  module's effectivePromptSegments — one canonical segment-discovery
 *  rule (its listSourceSegments mirrors this loader's, now including
 *  shared/) — so per-segment OVERRIDES ride the same path: a segment
 *  whose switch is ON and whose override file exists composes the
 *  override text instead of the source. `switches` is the settings
 *  record's agent.prompts map (absent key = off), threaded per turn via
 *  AgentBuildOptions.promptSwitches; a switches-less call composes pure
 *  source (byte-identical to the pre-refactor loader — pinned in
 *  tests/prompt-overrides.test.ts). Overrides are a static-file read
 *  through config paths, not request state — the store import carries no
 *  chat/job machinery. */
export function composeInstructions(kind: AgentKind, switches?: Record<string, boolean>): string {
	const segments = effectivePromptSegments(kind, switches ?? {});
	return segments
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText))
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

// The switch-free source composition, cached per kind (module-load once).
// With promptSwitches provided, baseAgentOptions composes FRESH per turn —
// an override file written while its switch is ON must flip the next
// turn's composition; the cache serves only the switches-less path.
const composedInstructions: Record<AgentKind, string> = {
	prober: composeInstructions("prober"),
	teacher: composeInstructions("teacher"),
	practice: composeInstructions("practice"),
	placement: composeInstructions("placement"),
};

// Money channel (wave 4): the chat-handler passes a per-turn collector;
// every model call's usage lands in the chat record's turns log
// (ChatStore.appendTurnUsage). The narrow param keeps the seam honest.
export type StepUsageCollector = (usage: Usage) => void;

/** Per-request construction options (the handler wires all of these). */
export interface AgentBuildOptions {
	/** Model + stream function — tests inject a scripted faux engine. */
	engine?: PiEngine;
	callPurpose?: { background: boolean };
	requestCycle?: ChatGPTRequestCycle;
	/** The initial transcript, as pi messages (the record IS agent state). */
	messages?: AgentMessage[];
	/** Money channel: one call per model request. */
	onUsage?: StepUsageCollector;
	/** Append-only reference updates before each already-scheduled internal
	 * model call. Does not schedule an extra call or interrupt live output. */
	contextUpdates?: (messages: readonly AgentMessage[]) => AgentMessage[];
	/** Validate the actual selected context after prepared/queued messages
	 * join, before dispatch. Throws through the SDK's normal failed-response
	 * lifecycle, never through the conversion seam. */
	validateContext?: (messages: readonly AgentMessage[]) => void;
	/** Tests may pass a bare tool registry to drive deterministic flows.
	 *  An explicit registry is NEVER toggle-filtered — the caller owns it. */
	tools?: Record<string, AgentTool<any>>;
	/** Server-owned per-turn resolver. Additive only; explicit tools test overrides
	 * bypass contributions entirely. No conversation identity means no factory call. */
	pluginContributions?: (context: PluginToolContext, reservedToolNames: readonly string[]) => {
		instructions: readonly string[];
		tools: readonly AgentTool<any>[];
		questionTypes?: readonly NativePluginQuestionContribution[];
		problemTypes?: readonly NativePluginProblemContribution[];
	};
	/** The resolved per-user tool toggles (core/pending EnabledTools — the
	 *  2026-09-19 P2 bridge: Platform's chat-handler passes
	 *  effective.agent.tools; the factories drop any tool explicitly false.
	 *  THE DEFINITIVE toggleable set is TOGGLEABLE_TOOLS (job tools only);
	 *  the filtering is generic, but writes validate against the list). */
	toolToggles?: EnabledTools;
	/** Per-segment system-prompt override SWITCHES (the settings record's
	 *  agent.prompts map, absent key = off — same keys the settings routes
	 *  and effectivePromptSegments use). Provided → the prompt composes
	 *  fresh per turn, honoring enabled overrides (switch on + file
	 *  exists); absent → the cached pure-source composition. */
	promptSwitches?: Record<string, boolean>;
	/** The lesson's language (fork addition): its core/language.ts
	 *  conversation directive is appended to the prompt. Absent = English. */
	language?: LessonLanguage;
	/** The session's pace and the learner's time note (fork addition, 2026-11-01 — core/pace.ts). Only the prober and the
	 *  teacher are paced; Thorough with no note adds nothing to the prompt. */
	pace?: { level: Pace; note?: string };
	/** The session's problem difficulty (fork addition, 2026-11-07 — core/difficulty.ts). Only the practice
	 *  agent is sized by it; absent adds nothing. */
	difficulty?: Difficulty;
	/** The session's frozen `<learner>` block (fork addition, 2026-11-11 — ChatSettings.learnerProfile). Only the teacher
	 *  and the practice agent get it (not the prober, not the placement test); absent or empty adds nothing. */
	learner?: string;
	/** The lesson's source material (fork addition): its system-prompt
	 *  section (core/materials.ts materialsPromptSection) and the lookup
	 *  tools (tools/materials.ts), added to every conversation agent. */
	materials?: { section: string; tools: AgentTool<any>[] };
	/** The course section (fork addition — docs/courses.md §4): a course
	 *  session's per-turn rules (core/course-session.ts), appended after
	 *  the material, and its tools (a Learn session's finish_lesson —
	 *  tools/course.ts), added to the registry. */
	course?: { section: string; tools?: AgentTool<any>[] };
	/** Sketch answers (fork addition, 2026-10-26): loads a stored sketch
	 *  page for the model projection (server/sketches.ts sketchImagesFor).
	 *  Absent → sketches reach the model as text stubs. */
	sketchImages?: SketchImageResolver;
	/** Native conversation identity: the existing persisted chat id, reused
	 * across reconstructed prober, teacher, and practice Agents.
	 * Debug: when set AND LH_PROVIDER_EVENTS=1, raw provider stream events
	 *  (pre-normalization) append to data/debug/provider-events/
	 *  <chatId>.jsonl via providerEventObserver — the GLM-truncation /
	 *  DeepSeek-id incident layer. Absent or env-off → no observer. */
	chatId?: string;
}

/**
 * The turn's question-stop rule (docs/archive/pi-engine-swap.md §2; Wave A
 * 2026-09-26, owner Option A): a question tool call (quiz /
 * ask_user_question) that RESOLVED — its synthetic "question posed" result
 * is not an error — ends the run: the learner's answer arrives as the next
 * POST. A call that FAILED authoring validation (error result) must NOT
 * stop the run — the model retries within the same turn, exactly the old
 * InvalidToolInputError semantics.
 *
 * Question results also carry terminate: true (tool-execute's
 * questionResult), so single-question batches stop natively at the pi
 * loop's own batch check; this finishTurn hook (0.87.1 rename of
 * shouldStopAfterTurn) is the
 * belt-and-suspenders HALF for the mixed batch (a question + other calls
 * in one message) that terminate-only semantics would let run on — the
 * learner cannot answer while a turn is in flight (per-chat 409), so a
 * cleanly-posed question MUST always end the turn. Practice's problem pose
 * has the same wait-for-the-learner contract, including mixed output/problem
 * batches; failed poses must still retry. maxTurns is gone
 * (owner ruling 2026-09-25: no maximum-agent-turns net on the teaching
 * turn).
 */
function makeQuestionStopper(kind: AgentKind) {
	return (context: {
		message: { content: Array<{ type: string; id?: string; name?: string }> };
		toolResults: Array<{ toolCallId: string; toolName?: string; isError?: boolean; details?: unknown }>;
	}): boolean => {
		// A read_sketch that left doubts open ends the turn even in a mixed batch
		// (a refused conclude beside it would otherwise let the model carry on
		// and write the paragraph the card is waiting to hold back).
		if (context.toolResults.some(isDoubtfulReadResult)) return true;
		const called = new Set(
			context.message.content
				.filter((c) => c.type === "toolCall" && c.name !== undefined && (
					(QUESTION_TOOLS as readonly string[]).includes(c.name) ||
					(kind === "practice" && c.name === PRACTICE_PROBLEM_TOOL)
				))
				.map((c) => c.id!),
		);
		if (called.size === 0) return false;
		// Stop only when every question/problem pose resolved cleanly.
		for (const result of context.toolResults) {
			if (called.has(result.toolCallId) && result.isError) return false;
		}
		return true;
	};
}

/** How many times one teacher gate (prose, lead floor, visual) may refuse within one run before it lets the call through. */
export const GATE_REFUSAL_CAP = 3;

/** A refusal counter for one run: `refuse(gate, blocks, reason)` is the block result while `gate` has refused at most
 *  GATE_REFUSAL_CAP times, then undefined (the gate lets the call through). A gate that does not block is not counted. */
export function makeGateRefusals(cap = GATE_REFUSAL_CAP) {
	const refusals: Record<string, number> = {};
	return (gate: string, blocks: boolean, reason: string): { block: true; reason: string } | undefined => {
		if (!blocks) return undefined;
		refusals[gate] = (refusals[gate] ?? 0) + 1;
		return refusals[gate]! > cap ? undefined : { block: true, reason };
	};
}

/** The force-text step (owner, 2026-10-27): after the prose gate refuses a
 *  question, the next request is sent without the gated tools, so only text
 *  can come back; the one after it gets them back. Not on Claude Code, for
 *  now: it cannot change tools inside a live session, so each change would
 *  respawn `claude` and replay the transcript. */
const FORCE_TEXT_OFF_PROVIDERS: readonly string[] = ["claude-code"];

const hasGatedTool = (list: ReadonlyArray<{ name: string }> | undefined): boolean =>
	(list ?? []).some((t) => PROSE_GATED_TOOLS.includes(t.name));

/** The pace section for this agent: only the prober and the teacher are paced (practice and the course
 *  placement test have their own prompts); "" when there is nothing to add. */
function paceFor(kind: AgentKind, pace: AgentBuildOptions["pace"]): string {
	if (!pace || (kind !== "prober" && kind !== "teacher")) return "";
	return paceSection(kind, pace.level, pace.note);
}

/** The difficulty section: only the practice agent is sized by it (the teacher and the prober are not);
 *  "" when there is nothing to add. */
function difficultyFor(kind: AgentKind, difficulty: AgentBuildOptions["difficulty"]): string {
	if (!difficulty || kind !== "practice") return "";
	return difficultySection(difficulty);
}

/** The learner-profile block: the teacher and the practice agent only; "" when there is none. */
function learnerFor(kind: AgentKind, learner: string | undefined): string {
	return kind === "teacher" || kind === "practice" ? (learner ?? "") : "";
}

/** The conversation agent's composed system prompt for one turn — the single
 *  source for the agent itself and for a side call that must read the same
 *  prompt (the clarification call, server/clarify.ts). */
export function agentSystemPrompt(
	kind: AgentKind,
	opts: Pick<AgentBuildOptions, "promptSwitches" | "language" | "materials" | "course" | "pace" | "difficulty" | "learner">,
): string {
	const composed = opts.promptSwitches ? composeInstructions(kind, opts.promptSwitches) : composedInstructions[kind]!;
	return withLanguageDirective(
		[composed, opts.materials?.section, opts.course?.section, paceFor(kind, opts.pace), difficultyFor(kind, opts.difficulty), learnerFor(kind, opts.learner)].filter(Boolean).join("\n\n"),
		opts.language ?? DEFAULT_LESSON_LANGUAGE,
		"conversation",
	);
}

function baseAgentOptions(
	kind: AgentKind,
	opts: AgentBuildOptions,
	tools: AgentTool<any, any>[],
	nodeExists?: (nodeId: string) => boolean,
	practice?: {
		gate: PracticeGate;
		graphNodes: PracticeToolContext["graphNodes"];
		/** The session's skills and difficulty: a plugin-posed problem passes the same admission as a native one. */
		courseSkills?: PracticeToolContext["courseSkills"];
		difficulty?: PracticeToolContext["difficulty"];
	},
	/** The practice grader's hook (fork): runs after a conclude. Only the practice agent has one. */
	afterToolCall?: ReturnType<typeof practiceGradeHook>,
) {
	// Practice never reaches the role fallback (the handler ALWAYS injects
	// the session's conversation engine — practice rides the same
	// conversation-spec resolution as teaching); the cast keeps AgentKind
	// ("practice" is not a ModelRole) honest about that.
	const engine = opts.engine ?? piEngineFor(kind as "prober" | "teacher");
	const stopper = makeQuestionStopper(kind);
	const forceText = kind === "teacher" && !FORCE_TEXT_OFF_PROVIDERS.includes(engine.model.provider);
	// Upstream's narration guard (v0.5.0) rides beside the fork's prose gate: its delivery rule is
	// appended to the conversation prompt when it applies, its hooks are chained below.
	const narrationGuard = narrationGuardApplies(kind, engine.model, opts.tools !== undefined);
	const narrationHooks = narrationGuard ? makeNarrationGuard() : undefined;
	const composedPrompt = agentSystemPrompt(kind, opts);
	// Appended in order: the narration rule (teacher), then the claude-code tool-name rule (every kind, claude-code only).
	const builtinPrompt = [
		composedPrompt,
		narrationGuard ? SEND_TO_USER_DELIVERY_RULE : undefined,
		engine.model.provider === CLAUDE_CODE_PROVIDER ? CLAUDE_CODE_TOOL_NAMES_RULE : undefined,
	].filter((part): part is string => part !== undefined).join("\n\n---\n\n");
	// The fork's own builtins join the registry BEFORE it is bound and reserved below, so plugins can neither shadow
	// them nor lose them. read_sketch (Android plan M2) rides EVERY agent, always — practice builds its own (it shares
	// the conclude gate). A caller-owned registry (opts.tools — the tests') is never touched.
	if (!opts.tools && !tools.some((t) => t.name === READ_SKETCH_TOOL)) {
		tools = [...tools, ...Object.values(healToolRecord({ read_sketch: readSketchTool({ known: () => sketchIdsOf(opts.messages ?? []) }) }))];
	}
	// show_figure (owner, 2026-11-12 — core/figure-show.ts) rides the teacher, always: a finished visual/demo stays
	// hidden until it is called. It reads the RUN's history (the agent's state), so a figure handed in mid-run is found.
	if (!opts.tools && kind === "teacher" && !tools.some((t) => t.name === SHOW_FIGURE_TOOL)) {
		tools = [...tools, ...Object.values(healToolRecord({ show_figure: createShowFigureTool({ messages: () => agent.state.messages }) }))];
	}
	if (opts.materials) tools = [...tools, ...opts.materials.tools];
	if (opts.course?.tools) tools = [...tools, ...opts.course.tools];
	// Bind native read and preserve the kind/model-aware Claude output gate
	// before resolving additive plugins. Explicit registries remain caller-owned.
	const builtinTools = [
		...tools.map((tool) => tool.name === "read" && tool.execute === readTool.execute
			? { ...tool, execute: createReadTool(engine.model).execute as AgentTool<any>["execute"] }
			: tool),
		...(sendToUserApplies(kind, engine.model, opts.tools !== undefined)
			? [withArgumentHeal(sendToUserTool)]
			: []),
	];
	const contributions = kind !== "placement" && opts.tools === undefined && opts.chatId && opts.pluginContributions
		? opts.pluginContributions({ chatId: opts.chatId, agent: kind }, [...CONVERSATION_TOOL_NAMES, ...builtinTools.map(tool => tool.name)])
		: undefined;
	const questionLedger = contributions?.questionTypes?.length && opts.chatId
		? new PluginQuestionLedger(contributions.questionTypes, opts.chatId, nodeExists) : undefined;
	const problemTools = kind === "practice" && practice && opts.chatId
		? pluginProblemTools(contributions?.problemTypes ?? [], opts.chatId, practice.gate, practice.graphNodes, { courseSkills: practice.courseSkills, difficulty: practice.difficulty }) : [];
	// Never replace the builtin prompt or tools, or mutate an already-running Agent.
	const systemPrompt = contributions?.instructions.length
		? [builtinPrompt, ...contributions.instructions].join("\n\n---\n\n")
		: builtinPrompt;
	const agentTools = contributions ? [...builtinTools, ...contributions.tools, ...(questionLedger?.tools ?? []), ...problemTools] : builtinTools;
	// The force-text step (fork): after the prose gate refuses a question, hide the gated tools for one request, then give
	// the whole registry back (contributions included, so a plugin's tools are never lost to it).
	const forceTextUpdate = (turn: PrepareNextTurnContext) => {
		if (!hasGatedTool(agentTools)) return undefined;
		const hidden = !hasGatedTool(turn.context.tools);
		const refused = proseGateRefusedLast(turn.context.messages);
		if (refused && !hidden) {
			return { context: { ...turn.context, tools: (turn.context.tools ?? []).filter((t) => !PROSE_GATED_TOOLS.includes(t.name)) } };
		}
		if (!refused && hidden) return { context: { ...turn.context, tools: agentTools } };
		return undefined;
	};
	// Debug recorder (owner, 2026-10-04): raw provider events when
	// LH_PROVIDER_EVENTS=1 and the caller handed a chatId; undefined is
	// the normal no-observer path (tests, env-off).
	const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, kind) : undefined;
	const seenInputs = new Set((opts.messages ?? []).map((m) => (m as { id?: string }).id).filter(Boolean));
	const agent = new Agent({
		identity: APP_IDENTITY,
		sessionId: opts.chatId,
		initialState: {
			systemPrompt,
			model: engine.model,
			thinkingLevel: engine.level,
			tools: agentTools,
			messages: opts.messages ?? [],
		},
		streamFn: engine.streamFn,
		...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
		// All hooks share the SDK's one beforeToolCall, and none overwrites another. In order: the prose gate (owner,
		// 2026-10-25 — core/prose-gate.ts: the TEACHER's quiz/explain is refused when nothing visible reached the learner
		// since his last graded answer; the refusal is an error result the model retries on, in the same turn), the lead
		// floor (owner, 2026-11-10 — core/lead-floor-gate.ts: a miss needs a real explanation, not a one-line filler) and
		// the visual gate (core/visual-gate.ts: a plan that calls for a picture gets it dispatched before the first teach
		// question); then upstream's narration guard (narration-marked thinking is not delivery); then the plugin
		// question ledger's exact-occurrence binding, which never refuses.
		...(kind === "teacher" || questionLedger || narrationHooks ? (() => {
			// A refusal cap (owner, 2026-11-10): after GATE_REFUSAL_CAP refusals by one gate in this run, that gate lets
			// the call through, so a model that keeps failing it cannot loop. Run-local: the agent is built once per turn.
			const refuse = makeGateRefusals();
			return {
				beforeToolCall: async (call: BeforeToolCallContext, signal?: AbortSignal) => {
					const { assistantMessage, toolCall, context } = call;
					if (kind === "teacher") {
						const refused =
							refuse("prose", proseGateBlocks(context.messages, assistantMessage, toolCall.id, toolCall.name), proseGateReason(toolCall.name))
							?? refuse("lead-floor", leadFloorBlocks(context.messages, assistantMessage, toolCall.id, toolCall.name), leadFloorReason(toolCall.name))
							?? refuse(
								"visual",
								visualGateBlocks(context.messages, toolCall.name, (context.tools ?? []).map((t) => t.name), assistantMessage, toolCall.id),
								VISUAL_GATE_REASON,
							);
						if (refused) return refused;
					}
					const guarded = await narrationHooks?.beforeToolCall?.(call, signal);
					if (guarded?.block) return guarded;
					questionLedger?.validatedCall(call);
					return undefined;
				},
			};
		})() : {}),
		// The narration guard's after-hook (teacher) and the practice grader's (practice) never meet on one agent.
		...(narrationHooks?.afterToolCall ? { afterToolCall: narrationHooks.afterToolCall } : afterToolCall ? { afterToolCall } : {}),
		// 0.87.1: shouldStopAfterTurn → finishTurn. Same call point (after
		// tool results attach, before turn_end) and `{ action: "end" }` still
		// exits BEFORE the steering poll — the parked-marker stranding our
		// Wave C registerLiveAgent-before-runPiTurn design depends on.
		// undefined preserves normal scheduling (the old boolean false).
		finishTurn: (turn) => {
			// A plugin question's acknowledgment (or a plugin problem's pose) ends the run, like a native question.
			if (turn.toolResults.some(result => questionLedger?.isAcknowledgment(result) || (kind === "practice" && isPluginProblemPoseAcknowledgment(result))) || stopper(turn)) return { action: "end" };
			// The forced text-only reply is in: one more request, tools back.
			if (
				forceText &&
				hasGatedTool(agentTools) &&
				!hasGatedTool(turn.context.tools) &&
				turn.message.stopReason === "stop" &&
				turn.message.content.some((b) => b.type === "text" && b.text.trim().length > 0) &&
				!turn.message.content.some((b) => b.type === "toolCall")
			)
				return { action: "continue" };
			return undefined;
		},
		// Wave C (2026-09-26, owner correction same day): markers handed to a
		// live run drain from pi's STEERING queue — the lesson loop is one
		// continuous teach→quiz→teach run, so delivery must inject at turn
		// boundaries INSIDE the run, not wait for it to stop (follow-ups).
		// "all" joins every handed marker at one boundary, matching the idle
		// wake's carry-everything semantics (the default "one-at-a-time"
		// would spend one teacher turn per marker).
		steeringMode: "all",
		// Wave B (owner-approved 2026-09-26): the model-facing conversion is
		// THE app seam — markers flatten to their canonical user text
		// (HANDOFF_TEXT / steer text, all single-sourced),
		// UI-only markers (plan-block) drop, the app's id fields strip, and
		// an abort's dangling question call gets its INTERRUPTED result. It
		// must never throw (pi's convertToLlm contract).
		convertToLlm: (messages) => toLlmMessages(messages, { sketchImage: opts.sketchImages }),
		// Two sources may change the next request, and neither may silence the other (the later of two spreads would):
		// the force-text step (fork) and upstream's side-conversation updates (new exchanges appended before the request).
		...(forceText || opts.contextUpdates ? { prepareNextTurnWithContext: (turn: PrepareNextTurnContext) => {
			const forced = forceText ? forceTextUpdate(turn) : undefined;
			const messages = opts.contextUpdates?.((forced?.context ?? turn.context).messages as AgentMessage[]) ?? [];
			if (!forced && messages.length === 0) return undefined;
			return { ...(forced ?? {}), ...(messages.length ? { messages } : {}) };
		} } : {}),
		prepareRequest: (request) => {
			if (opts.callPurpose) {
				let learner = false, automatic = false;
				const messages = request.context.messages;
				for (const message of messages) {
					const id = (message as { id?: string }).id;
					const cause = nativeInputCause(message, messages.slice(0, messages.indexOf(message)));
					if (cause === "neutral") continue;
					if (id && seenInputs.has(id)) continue;
					if (id) seenInputs.add(id);
					if (cause === "learner" && id) learner = true;
					else automatic = true; // missing/unrecognized identity never grants foreground
				}
				if (automatic) opts.callPurpose.background = true;
				else if (learner) opts.callPurpose.background = false;
			}
			opts.requestCycle?.prepare(request);
			try { opts.validateContext?.(request.context.messages); }
			catch (error) {
				opts.requestCycle?.rejectLocalRequest();
				throw error;
			}
		},
	});
	questionLedger?.bind(agent);
	if (opts.onUsage) {
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "assistant" && "usage" in event.message) {
				// A cancelled call is not a billed step (partial/estimated
				// usage on an aborted message is not money spent).
				if (event.message.stopReason === "aborted" || !usageWasAdmitted(event.message.usage) || (opts.requestCycle && !opts.requestCycle.acceptsUsage(event.message))) return;
				opts.onUsage!(event.message.usage);
			}
		});
	}
	return agent;
}

/**
 * The PROBER (agent A): the quizzing tool (quiz, or explain under free
 * recall — no nodeId either way) + ask + probe_done, lean on
 * probing doctrine. Its whole job is bracketing the learner's edge and
 * concluding with the assessment (probe_done) — which also queues the
 * handoff wake (see tools/probe.ts) and is the transcript seam the
 * handler keys teacher construction on.
 */
export function createProberAgent(ctx: ProberToolContext, opts: AgentBuildOptions = {}) {
	return baseAgentOptions("prober", opts, Object.values(createProberTools(ctx, opts.toolToggles)));
}

/**
 * The TEACHER (agent B): enters at planning (the probe is already
 * concluded — its assessment is in the transcript), owns plan_init and the
 * full toolset (teach questions with validated nodeId, the map, research,
 * demos).
 */
export function createTeacherAgent(
	// Optional so tests can construct a bare mock-driven agent (no storage
	// wiring): without ctx the tools fall back to the validation-free
	// question set. The handler ALWAYS passes ctx (the composition root).
	ctx?: TeacherToolContext,
	opts: AgentBuildOptions = {},
) {
	const tools = opts.tools ?? (ctx ? createTeacherTools(ctx, opts.toolToggles) : bareQuestionTools());
	return baseAgentOptions("teacher", opts, Object.values(tools), ctx
		? nodeId => ctx.chatStore.getChat(ctx.chatId)?.tree?.nodes.some(node => node.id === nodeId) ?? false
		: undefined);
}

/** The bare teach question set (tests, bare agents): quiz with the shared
 *  authoring refinement (quizInputProblems, run in execute — returns an
 *  invalidInputResult isError result the model retries on, pi 1.0
 *  convention) but NO per-session nodeId check (no record to read),
 *  plus ask. */
export function bareQuestionTools(): Record<string, AgentTool<any>> {
	// A typed const (not an inline literal): the specific AgentTool typing
	// gives execute its precise Static input; heterogeneous records take
	// AgentTool<any>, whose loose Static would smudge it to unknown.
	const quiz: AgentTool<typeof quizInputObject> = {
		name: "quiz",
		label: "quiz",
		description: "Ask the learner a graded question.",
		parameters: quizInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...quizInputProblems(input), ...figureInputProblems(input)];
			if (problems.length > 0) return invalidInputResult("quiz", problems);
			return questionResult();
		},
	};
	// healToolRecord (owner, 2026-10-09 — the whitehead generalization):
	// the bare quiz carried NO prepareArguments at all — not even the
	// options-unwrap; now it gets the full standard heal like every tool.
	return healToolRecord({
		quiz,
		ask_user_question: askUserQuestionTool,
		figure_guide: figureGuideTool,
		circuit_solve: circuitSolveTool,
	});
}

/**
 * The PRACTITIONER (practice sessions, owner design 2026-10-04): built
 * from turn 1 of a kind:"practice" session — no prober→teacher split,
 * no plan tools, no question tools. Its ENTIRE registry is
 * problem + conclude (tools/practice.ts); the doctrine prompt
 * (prompts/practice/) carries the method. A successful problem pose ends
 * the run, natively for a problem-only batch and via the shared stop hook
 * for a mixed batch (including caller-injected legacy output tools).
 * Practice uses ordinary final prose, not the explicit output tool.
 */
export function createPracticeAgent(ctx: PracticeToolContext, opts: AgentBuildOptions = {}) {
	// The practice grader (owner, 2026-11-09): a concluded problem's per-skill grades come from a second model, written into the conclude result.
	const gradeHook = ctx.courseSkills ? practiceGradeHook({ courseSkills: ctx.courseSkills, ...(ctx.difficulty ? { difficulty: ctx.difficulty } : {}), ...(ctx.sessionModel ? { sessionModel: ctx.sessionModel } : {}) }) : undefined;
	// Explicit test registries bypass all builtin construction and contributions.
	if (opts.tools !== undefined) return baseAgentOptions("practice", opts, Object.values(opts.tools), undefined, undefined, gradeHook);
	const gate = createPracticeGate(ctx);
	return baseAgentOptions("practice", opts, Object.values(practiceTools(ctx, gate)), undefined,
		{ gate, graphNodes: ctx.graphNodes, courseSkills: ctx.courseSkills, difficulty: ctx.difficulty }, gradeHook);
}

/**
 * The PLACEMENT TESTER (course placement test, owner 2026-10-25): a
 * conversation session built from turn 1 like practice — no probe→teach
 * split, no plan. Its registry is the skill-tagged multiple-choice probe
 * (tools/course.ts) + ask; its doctrine is prompts/placement/ plus the
 * course section. The answers are the evidence (core/mastery.ts).
 */
export function createPlacementAgent(ctx: { skills: () => ReadonlyArray<{ id: string; name: string }> }, opts: AgentBuildOptions = {}) {
	const tools = opts.tools ?? healToolRecord({ probe: placementProbeTool(ctx.skills), ask_user_question: askUserQuestionTool, figure_guide: figureGuideTool, circuit_solve: circuitSolveTool });
	return baseAgentOptions("placement", opts, Object.values(tools));
}

export type ProberAgent = ReturnType<typeof createProberAgent>;
export type TeacherAgent = ReturnType<typeof createTeacherAgent>;
export type PracticeAgent = ReturnType<typeof createPracticeAgent>;
export type PlacementAgent = ReturnType<typeof createPlacementAgent>;
export type TeachingAgent = ProberAgent | TeacherAgent | PracticeAgent | PlacementAgent;

