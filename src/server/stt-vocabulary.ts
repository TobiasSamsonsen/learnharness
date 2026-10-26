import { dictationVocabulary } from "../core/dictation-vocabulary.ts";
import type { LessonLanguage } from "../core/language.ts";
import { stores } from "./stores.ts";

/**
 * A chat's dictation vocabulary (Android plan M4), cached per chat. The
 * pieces of one dictation run arrive seconds apart on an unchanged record,
 * so the fold over the whole transcript runs once per record revision
 * (its `updatedAt`), not once per piece.
 */

const cache = new Map<string, { revision: string; vocabulary: string }>();
const MAX_CACHED = 50;

/** The chat's vocabulary prompt; empty for no chat, an unknown chat, or a lesson without terms yet. */
export function vocabularyForChat(chatId: string | null, language: LessonLanguage): string {
	if (!chatId) return "";
	const record = stores.chatStore.getChat(chatId);
	if (!record) return "";
	const revision = `${record.updatedAt}|${language}`;
	const hit = cache.get(chatId);
	if (hit?.revision === revision) return hit.vocabulary;
	const vocabulary = dictationVocabulary({ messages: record.messages, tree: record.tree, language });
	cache.delete(chatId);
	cache.set(chatId, { revision, vocabulary });
	if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
	return vocabulary;
}
