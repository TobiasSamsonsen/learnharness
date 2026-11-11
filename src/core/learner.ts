/**
 * The learner profile's stored shape (fork addition, 2026-11-11). PURE, browser-safe.
 *
 * ONE global profile, kept in settings.json under `learner` and synced key by
 * key. It has two stored keys, deliberately separate so a device that edits
 * the note never overwrites the applied claims (sync replaces nested objects
 * wholesale):
 *
 *   note     the learner's own words on how they learn best, quoted to the
 *            tutor as data;
 *   applied  the claims the learner reviewed and pressed Apply on (the Adapt
 *            draft itself is never stored).
 *
 * The automatic mistake fold is NOT stored: it is derived from transcripts on
 * read (learner-fold.ts).
 */

/** The most characters the learner's own note may hold. */
export const LEARNER_NOTE_MAX = 1000;
/** The most characters one applied claim's text may hold. */
export const LEARNER_CLAIM_TEXT_MAX = 300;
/** The most claims a profile may hold. */
export const LEARNER_CLAIMS_MAX = 12;
/** The most chat ids one claim may cite. */
export const LEARNER_CLAIM_CHATS_MAX = 12;

export const LEARNER_CLAIM_KINDS = ["mistake", "calibration", "what-helped", "pacing"] as const;
export type LearnerClaimKind = (typeof LEARNER_CLAIM_KINDS)[number];

/** One statement about the learner, with the evidence behind it. */
export interface LearnerClaim {
	kind: LearnerClaimKind;
	/** What the claim says, trimmed and non-empty. */
	text: string;
	/** How many events (concluded problems, answers) support it, a whole number from 1. */
	events: number;
	/** The chats those events come from. */
	chats: string[];
	/** Whether the evidence is below the bar (>= 3 events in >= 2 chats): shown to the tutor as tentative. */
	tentative: boolean;
}

export interface LearnerSettings {
	note?: string;
	applied?: LearnerClaim[];
}

export function isLearnerClaimKind(value: unknown): value is LearnerClaimKind {
	return LEARNER_CLAIM_KINDS.some((k) => k === value);
}

/** A note as stored: trimmed, and absent when empty. */
export function normalizeLearnerNote(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** One claim, strictly: the first problem found is the error. Unknown keys are dropped. */
export function parseLearnerClaim(raw: unknown): { ok: true; claim: LearnerClaim } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "a claim must be an object" };
	const r = raw as Record<string, unknown>;
	if (!isLearnerClaimKind(r.kind)) {
		return { ok: false, error: `a claim's kind must be one of: ${LEARNER_CLAIM_KINDS.join(", ")}` };
	}
	if (typeof r.text !== "string" || r.text.trim() === "") return { ok: false, error: "a claim's text must be a non-empty string" };
	const text = r.text.trim();
	if (text.length > LEARNER_CLAIM_TEXT_MAX) {
		return { ok: false, error: `a claim's text must be at most ${LEARNER_CLAIM_TEXT_MAX} characters` };
	}
	if (typeof r.events !== "number" || !Number.isInteger(r.events) || r.events < 1) {
		return { ok: false, error: "a claim's events must be a whole number of at least 1" };
	}
	if (!Array.isArray(r.chats) || r.chats.some((c) => typeof c !== "string" || c.trim() === "")) {
		return { ok: false, error: "a claim's chats must be a list of chat ids" };
	}
	const chats = [...new Set((r.chats as string[]).map((c) => c.trim()))];
	if (chats.length > LEARNER_CLAIM_CHATS_MAX) {
		return { ok: false, error: `a claim may cite at most ${LEARNER_CLAIM_CHATS_MAX} chats` };
	}
	if (typeof r.tentative !== "boolean") return { ok: false, error: "a claim's tentative must be true or false" };
	return { ok: true, claim: { kind: r.kind, text, events: r.events, chats, tentative: r.tentative } };
}

/** The applied claims, strictly (the request side): too many claims or any bad claim is an error. Empty means none. */
export function parseLearnerApplied(raw: unknown): { ok: true; applied: LearnerClaim[] | undefined } | { ok: false; error: string } {
	if (!Array.isArray(raw)) return { ok: false, error: "applied must be a list of claims" };
	if (raw.length > LEARNER_CLAIMS_MAX) return { ok: false, error: `applied may hold at most ${LEARNER_CLAIMS_MAX} claims` };
	const claims: LearnerClaim[] = [];
	for (const item of raw) {
		const parsed = parseLearnerClaim(item);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		claims.push(parsed.claim);
	}
	return { ok: true, applied: claims.length > 0 ? claims : undefined };
}

/** The sanitizer's side (a settings file on disk): clamp, never reject. A bad claim drops, extra claims and chat ids are cut, a long note is cut. */
export function sanitizeLearner(raw: Record<string, unknown>): LearnerSettings {
	const out: LearnerSettings = {};
	if (typeof raw.note === "string") {
		const note = normalizeLearnerNote(raw.note.slice(0, LEARNER_NOTE_MAX));
		if (note !== undefined) out.note = note;
	}
	if (Array.isArray(raw.applied)) {
		const claims: LearnerClaim[] = [];
		for (const item of raw.applied) {
			if (claims.length >= LEARNER_CLAIMS_MAX) break;
			// Cut an over-long chat list first: the strict parser would reject it.
			const cut = item && typeof item === "object" && !Array.isArray(item) && Array.isArray((item as { chats?: unknown }).chats)
				? { ...(item as object), chats: (item as { chats: unknown[] }).chats.slice(0, LEARNER_CLAIM_CHATS_MAX) }
				: item;
			const parsed = parseLearnerClaim(cut);
			if (parsed.ok) claims.push(parsed.claim);
		}
		if (claims.length > 0) out.applied = claims;
	}
	return out;
}
