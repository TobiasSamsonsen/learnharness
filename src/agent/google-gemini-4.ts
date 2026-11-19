import type { Api, Model, Provider } from "@earendil-works/pi-ai";

/**
 * Gemini 4 Hydrogen and Neon on the built-in `google` provider (AI Studio,
 * GEMINI_API_KEY). Neither is in any published pi-ai catalog yet (1.5.2 ships
 * only gemini-4-argon), so they are added here. Ids, context, output cap and
 * prices are from Google's own model and pricing pages (checked 2026-11-19).
 * Shape and request path are gemini-4-argon's: usesGoogleThinkingLevel already
 * matches gemini-4-*, so the adapter sends thinkingLevel, never thinkingBudget
 * (Gemini 4 answers a budget with HTTP 400).
 *
 * Thinking: low/medium/high only. Gemini 4 cannot switch thinking off and
 * rejects MINIMAL with HTTP 400. Hydrogen and Neon also accept XHIGH, but
 * pi-ai's Google adapter has no XHIGH mapping, so it stays null (owner decision).
 *
 * Neon has no free tier: a free-tier key lists it, then fails at request time.
 */
const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const THINKING_LEVELS = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
} as const;

function geminiFourModel(id: string, name: string, input: number, output: number, cacheRead: number): Model<"google-generative-ai"> {
	return {
		id,
		name,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: GOOGLE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input, output, cacheRead, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
		thinkingLevelMap: { ...THINKING_LEVELS },
	};
}

export const GEMINI_4_MODELS: readonly Model<"google-generative-ai">[] = [
	geminiFourModel("gemini-4-hydrogen", "Gemini 4 Hydrogen", 1.5, 7.5, 0.075),
	geminiFourModel("gemini-4-neon", "Gemini 4 Neon", 3, 15, 0.15),
];

/** The provider with the Gemini 4 entries added. An entry the catalog already
 *  has (same id) wins, so a pi-ai release that ships these models takes over. */
export function withGeminiFourModels<P extends Provider<Api>>(provider: P): P {
	const missing = <M extends { id: string; type?: string }>(models: readonly M[]) => {
		const have = new Set(models.filter((m) => (m.type ?? "chat") === "chat").map((m) => m.id));
		return GEMINI_4_MODELS.filter((m) => !have.has(m.id));
	};
	return {
		...provider,
		getModels: () => {
			const models = provider.getModels();
			return [...models, ...missing(models)];
		},
		...(provider.getAllModels && {
			getAllModels: () => {
				const models = provider.getAllModels!();
				return [...models, ...missing(models)];
			},
		}),
	};
}
