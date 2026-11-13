/**
 * turn-fallback — "Retry on <model>" for a failed turn (owner, 2026-11-13). Never automatic: when a turn fails with a
 * recognised provider failure (credit, quota, a rejected key, the provider down, a timeout), the banner offers one
 * press that moves THIS session to the Cheap slot's model and retries. Only between API-key models: a subscription
 * route (Claude Code, ChatGPT, Copilot, ...) never gets the button and is never the target, so the rule that
 * subscriptions do not fall back stays. Pure.
 */

import { turnErrorDisplay } from "./grade-failure.ts";

export interface FallbackCatalog {
	slots: { strong: { model: { provider: string; id: string } } | null; cheap: { model: { provider: string; id: string } } | null };
	/** `envVar` is empty for subscription and native CLI routes. */
	providers: ReadonlyArray<{ id: string; envVar: string; keyPresent: boolean }>;
}

export interface FallbackTarget {
	provider: string;
	id: string;
}

/** The model to offer, or null: the failure must be a recognised provider one, the session's model an API-key one, and
 *  the Cheap slot a different, usable API-key model. `session` is "provider:id" (the picker's value), absent = the
 *  Strong slot (a session's default). */
export function retryFallbackModel(input: { error: string | undefined; session: string | undefined; catalog: FallbackCatalog | undefined }): FallbackTarget | null {
	const { error, session, catalog } = input;
	if (!error || !catalog || turnErrorDisplay(error).phrase === null) return null;
	let current: { provider: string; id: string } | null = null;
	if (session) {
		const at = session.indexOf(":");
		if (at > 0) current = { provider: session.slice(0, at), id: session.slice(at + 1) };
	} else current = catalog.slots.strong?.model ?? null;
	const cheap = catalog.slots.cheap?.model;
	if (!current || !cheap) return null;
	if (current.provider === cheap.provider && current.id === cheap.id) return null;
	const apiKey = (provider: string, needKey: boolean): boolean => {
		const row = catalog.providers.find((p) => p.id === provider);
		return !!row && row.envVar !== "" && (!needKey || row.keyPresent);
	};
	return apiKey(current.provider, false) && apiKey(cheap.provider, true) ? { provider: cheap.provider, id: cheap.id } : null;
}
