/**
 * The evidence digest behind the Adapt button (fork addition, 2026-11-11). PURE, browser-safe.
 *
 * Adapt regenerates the profile from TRANSCRIPTS, never from the previous
 * profile, so the digest is built from the chats alone: per concluded problem
 * (skill, outcome, rung, miss class, verdict cut to 300 characters, date) and
 * per teach/learn chat a tally of its quiz and probe answers plus the wording
 * of the questions it was most confidently wrong on. Newest chats first,
 * capped at ~24k tokens (the oldest are cut, and the digest says so).
 */

import { LEARNER_CLAIMS_MAX, LEARNER_CLAIM_CHATS_MAX, LEARNER_CLAIM_TEXT_MAX, type LearnerClaim, type LearnerClaimKind } from "./learner.ts";
import { OVERCONFIDENT_AT, learnerEventsOf, type LearnerChatInput } from "./learner-fold.ts";

/** Adapt needs evidence from at least this many sessions. */
export const ADAPT_MIN_SESSIONS = 3;
/** A claim is solid with at least this many events… */
export const CLAIM_MIN_EVENTS = 3;
/** …from at least this many chats; fewer is marked tentative. */
export const CLAIM_MIN_CHATS = 2;
/** ~24k tokens at ~4 characters a token. */
export const ADAPT_DIGEST_MAX_CHARS = 96_000;
export const DIGEST_VERDICT_MAX = 300;
/** Per teach/learn chat: how many high-confidence misses are quoted, and how long each quote is. */
export const DIGEST_MISSED_QUESTIONS_MAX = 5;
export const DIGEST_QUESTION_MAX = 200;

/** A chat as the digest reads it. */
export interface DigestChat extends LearnerChatInput {
	/** The chat's last activity, ISO: orders the digest newest first. */
	updatedAt: string;
}

export interface AdaptDigest {
	text: string;
	/** The chats the digest lists: the only ids a claim may cite. */
	chatIds: string[];
	/** Chats that carry evidence (listed or cut). */
	sessions: number;
	/** Evidence from at least ADAPT_MIN_SESSIONS sessions. */
	ready: boolean;
	/** The oldest chats were left out to fit the cap. */
	truncated: boolean;
}

const cut = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** One chat's block, or null when it carries no evidence. */
function chatBlock(chat: DigestChat, skillName: (id: string) => string | undefined): string | null {
	const e = learnerEventsOf(chat);
	if (e.concluded.length > 0) {
		const lines = [`CHAT ${chat.id} (practice, ${dayOf(Math.max(...e.concluded.map((c) => c.at)))}), ${e.concluded.length} concluded problem${e.concluded.length === 1 ? "" : "s"}:`];
		for (const c of e.concluded) {
			const skills = c.skills.map((s) => skillName(s) ?? s).join(", ");
			lines.push(
				`- ${dayOf(c.at)} · ${c.outcome} · rung ${c.rung ?? "none"} · miss: ${c.missClass ?? "none"}${skills ? ` · skills: ${skills}` : ""} · verdict: ${cut(c.verdict, DIGEST_VERDICT_MAX)}`,
			);
		}
		return lines.join("\n");
	}
	if (e.answers.length > 0) {
		const wrong = e.answers.filter((a) => !a.dontKnow && a.correct === false);
		const wrongHigh = wrong.filter((a) => a.confidence !== undefined && a.confidence >= OVERCONFIDENT_AT);
		const dontKnow = e.answers.filter((a) => a.dontKnow).length;
		const lines = [
			`CHAT ${chat.id} (lesson, ${dayOf(Math.max(...e.answers.map((a) => a.at)))}): ${e.answers.length} answers, ${wrong.length} wrong, ${wrongHigh.length} wrong at stated confidence >= ${OVERCONFIDENT_AT}, ${dontKnow} "I don't know"`,
		];
		for (const a of wrongHigh.slice(0, DIGEST_MISSED_QUESTIONS_MAX)) {
			lines.push(`- wrong at ${a.confidence}%: ${cut(a.questionText, DIGEST_QUESTION_MAX)}`);
		}
		return lines.join("\n");
	}
	return null;
}

/** The digest of these chats (any order). `skillName` maps a skill id to its display name where one is known. */
export function buildAdaptDigest(chats: readonly DigestChat[], skillName: (id: string) => string | undefined = () => undefined): AdaptDigest {
	const ordered = [...chats].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
	const blocks: string[] = [];
	const chatIds: string[] = [];
	let sessions = 0;
	let size = 0;
	let truncated = false;
	for (const chat of ordered) {
		const block = chatBlock(chat, skillName);
		if (block === null) continue;
		sessions++;
		if (truncated || size + block.length + 2 > ADAPT_DIGEST_MAX_CHARS) {
			truncated = true;
			continue;
		}
		blocks.push(block);
		chatIds.push(chat.id);
		size += block.length + 2;
	}
	return { text: blocks.join("\n\n"), chatIds, sessions, ready: sessions >= ADAPT_MIN_SESSIONS, truncated };
}

/** What the Adapt model submits. */
export interface AdaptSubmission {
	claims: Array<{ kind: LearnerClaimKind; text: string; events: number; chats: string[] }>;
	gaps: string[];
}

/** What the learner reviews: the claims, and what the evidence could not show. Never stored. */
export interface AdaptDraft {
	claims: LearnerClaim[];
	gaps: string[];
	/** Chats that carried evidence. */
	sessions: number;
	/** Whether the oldest chats were left out of the digest. */
	truncated: boolean;
}

/** A schema-valid submission that breaks a pipeline law, as a message for the model to fix; null = accept. */
export function adaptProblem(sub: AdaptSubmission): string | null {
	if (sub.claims.length > LEARNER_CLAIMS_MAX) return `submit at most ${LEARNER_CLAIMS_MAX} claims`;
	const long = sub.claims.find((c) => c.text.trim().length > LEARNER_CLAIM_TEXT_MAX);
	if (long) return `a claim's text must be at most ${LEARNER_CLAIM_TEXT_MAX} characters: shorten "${long.text.slice(0, 40)}…"`;
	return null;
}

/** The draft from a submission, with the server's own bookkeeping: cited chats must be ones the digest lists (strays
 *  dropped, a claim left with none is dropped), `tentative` is decided here (fewer than CLAIM_MIN_EVENTS events or
 *  CLAIM_MIN_CHATS chats), never taken from the model. */
export function finalizeAdapt(sub: AdaptSubmission, digest: Pick<AdaptDigest, "chatIds" | "sessions" | "truncated">): AdaptDraft {
	const known = new Set(digest.chatIds);
	const claims: LearnerClaim[] = [];
	for (const c of sub.claims) {
		if (claims.length >= LEARNER_CLAIMS_MAX) break;
		const text = c.text.trim();
		const chats = [...new Set(c.chats.map((id) => id.trim()).filter((id) => known.has(id)))].slice(0, LEARNER_CLAIM_CHATS_MAX);
		if (!text || text.length > LEARNER_CLAIM_TEXT_MAX || chats.length === 0) continue;
		const events = Math.max(Math.floor(c.events), chats.length, 1);
		claims.push({ kind: c.kind, text, events, chats, tentative: events < CLAIM_MIN_EVENTS || chats.length < CLAIM_MIN_CHATS });
	}
	const gaps = sub.gaps.map((g) => g.trim()).filter(Boolean).slice(0, 8);
	return { claims, gaps, sessions: digest.sessions, truncated: digest.truncated };
}
