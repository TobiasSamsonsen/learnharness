import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { UserSettings } from "./settings.ts";

/**
 * The Claude-subscription preset (fork addition, 2026-10-24): model and
 * volume settings tuned for a usage-capped Claude plan run through the
 * claude-code provider. PURE — the server applies it (merging into the
 * record), the settings UI describes it from the same data.
 *
 *   strong (prober, teacher, practice)  Sonnet, medium — every learner turn
 *   planner (the planning turn only)    Opus, medium — one turn a lesson, and
 *                                       the whole lesson follows its plan
 *   cheap (researcher, extractor,       Haiku, low — summarizing and
 *          auditor)                     structuring, the most frequent calls
 *   demoBuilder                         Sonnet, low — it writes working code
 *   checker (answer keys)               follows strong (Sonnet) — Opus would
 *                                       catch more, but it runs on every
 *                                       question; set it per role if wanted
 *   vision (visual maker, PDF reader,   Sonnet, low — math pages and figures
 *           source-material profiles)
 *
 * Plus volume: extraction in 12k-token batches (a third as many runs) and
 * compaction at 100k tokens (every turn re-reads the whole context).
 */

const pick = (id: string, thinkingLevel: ThinkingLevel) => ({ model: { provider: "claude-code", id }, thinkingLevel });

export const CLAUDE_SUBSCRIPTION_PRESET = {
	models: {
		strong: pick("claude-sonnet-5-5", "medium"),
		cheap: pick("claude-haiku-5-5", "low"),
		vision: pick("claude-sonnet-5-5", "low"),
	},
	roles: {
		planner: pick("claude-opus-5-5", "medium"),
		demoBuilder: pick("claude-sonnet-5-5", "low"),
	},
	extractionChunkTokens: 12_288,
	compactionThresholdTokens: 100_000,
} as const;

/** The record with the preset merged in — every other setting kept. Pure. */
export function withClaudeSubscriptionPreset(record: UserSettings | null): UserSettings {
	const r: UserSettings = record ?? { version: 1 };
	const p = CLAUDE_SUBSCRIPTION_PRESET;
	return {
		...r,
		models: { ...r.models, ...p.models },
		agent: { ...r.agent, models: { ...r.agent?.models, ...p.roles } },
		graph: { ...r.graph, extractionChunkTokens: p.extractionChunkTokens },
		compaction: { ...r.compaction, thresholdTokens: p.compactionThresholdTokens },
	};
}
