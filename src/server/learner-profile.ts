/**
 * The learner profile's birth snapshot (fork addition, 2026-11-11): reads the
 * settings' `learner` section and every chat that carries evidence, folds them
 * (core/learner-fold.ts) and renders the `<learner>` block (core/learner-profile.ts).
 * Called once per new session; the result is frozen into the chat record.
 */

import type { DigestChat } from "../core/learner-digest.ts";
import { learnerEventsOfAll, foldLearner } from "../core/learner-fold.ts";
import { learnerSection } from "../core/learner-profile.ts";
import { stores } from "./stores.ts";

/** Every chat that can carry evidence (not placement tests), with its last activity. */
export function digestChats(): DigestChat[] {
	const out: DigestChat[] = [];
	for (const summary of stores.chatStore.listChats()) {
		const mode = summary.course?.mode;
		if (mode === "placement") continue;
		const record = stores.chatStore.getChat(summary.id);
		if (!record) continue;
		out.push({
			id: record.id,
			updatedAt: record.updatedAt,
			...(record.kind ? { kind: record.kind } : {}),
			...(record.course ? { course: record.course } : {}),
			messages: record.messages,
		});
	}
	return out;
}

/** The `<learner>` block for a session being born now; "" when the profile is empty (the prompt then stays byte-identical). */
export function learnerSnapshot(now: number = Date.now()): string {
	const learner = stores.settingsStore.readSettings()?.learner;
	const fold = foldLearner(learnerEventsOfAll(digestChats()), now);
	return learnerSection({ note: learner?.note, applied: learner?.applied, fold });
}
