/**
 * The learner profile's server seams (fork addition, 2026-11-11): the stats the
 * Settings page shows (GET /api/learner) and the on-demand Adapt run (POST
 * /api/learner/adapt). Both read the chats and fold or digest them on the
 * spot; nothing is stored here. A draft returns to the page; only the claims
 * the learner Applies are written (PUT /api/settings/learner).
 */

import { draftLearnerClaims } from "../agent/subagents/adapt.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { mergeSkillLines } from "../core/skills.ts";
import { ADAPT_MIN_SESSIONS, buildAdaptDigest, finalizeAdapt, type AdaptDraft } from "../core/learner-digest.ts";
import { foldLearner, learnerEventsOfAll, type LearnerStats } from "../core/learner-fold.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { digestChats } from "./learner-profile.ts";
import { stores } from "./stores.ts";

/** Two minutes, like the practice grader: a digest is a long read. */
const ADAPT_TIMEOUT_MS = 120_000;

/** The automatic layer for the Settings page: everything, including what is still below the floors. */
export function learnerStats(now: number = Date.now()): LearnerStats {
	const chats = digestChats();
	const fold = foldLearner(learnerEventsOfAll(chats), now);
	const digest = buildAdaptDigest(chats);
	return { fold, sessions: digest.sessions, adaptReady: digest.ready, adaptMinSessions: ADAPT_MIN_SESSIONS };
}

export type AdaptOutcome =
	| { ok: true; draft: AdaptDraft }
	| { ok: false; status: 409 | 503 | 502; error: string };

/** Run Adapt: digest the chats, draft claims on the grader role (the strong slot). Never stores anything. */
export async function runAdapt(signal?: AbortSignal): Promise<AdaptOutcome> {
	const chats = digestChats();
	const skills = new Map(mergeSkillLines(stores.skillStore.readSkillLines(), new Set(stores.graphStore.readNodes().map((n) => n.id))).map((s) => [s.id, s.name]));
	const digest = buildAdaptDigest(chats, (id) => skills.get(id));
	if (!digest.ready) {
		return { ok: false, status: 409, error: `Adapt needs evidence from at least ${ADAPT_MIN_SESSIONS} sessions; there are ${digest.sessions} so far.` };
	}
	const spec = resolveRoleSpec("grader", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, status: 503, error: "No model is configured yet: pick the strong model in Settings first." };
	try {
		const submission = await draftLearnerClaims(digest.text, {
			engine: piEngineForSpec(spec),
			signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(ADAPT_TIMEOUT_MS)]),
		});
		return { ok: true, draft: finalizeAdapt(submission, digest) };
	} catch (err) {
		return { ok: false, status: 502, error: `Adapt failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}
