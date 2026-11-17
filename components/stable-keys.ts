/**
 * Stable React keys for the transcript's messages (owner, 2026-11-17: the plan
 * text blinked at the end of a turn). A live message is minted client-side
 * with a temporary id; the server stamps the real one when the turn is stored
 * (src/server/turn-service.ts), and the settle swaps one for the other. Keyed
 * by id, React would unmount the whole message and mount a new one. This keeps
 * the old key for a message whose id was swapped: ids that left and ids that
 * arrived in the same render pair up by role and order, when their counts match.
 * PURE, browser-safe.
 */

export interface KeyedMessage {
	id: string;
	role: string;
}

export interface KeyState {
	ids: string[];
	roles: string[];
	keys: string[];
}

export const EMPTY_KEY_STATE: KeyState = { ids: [], roles: [], keys: [] };

/** The keys for `messages`, given the previous render's state. Never repeats a key. */
export function nextKeyState(prev: KeyState, messages: readonly KeyedMessage[]): KeyState {
	const prevKeyById = new Map<string, string>();
	prev.ids.forEach((id, i) => {
		if (id) prevKeyById.set(id, prev.keys[i]!);
	});
	const nowIds = new Set(messages.map((m) => m.id).filter(Boolean));

	// Swap candidates: ids that vanished and ids that arrived, per role, in order.
	const removed = new Map<string, string[]>(); // role -> prev keys of vanished messages
	prev.ids.forEach((id, i) => {
		if (!id || nowIds.has(id)) return;
		const role = prev.roles[i]!;
		removed.set(role, [...(removed.get(role) ?? []), prev.keys[i]!]);
	});
	const added = new Map<string, number>(); // role -> how many new ids arrived
	for (const m of messages) {
		if (m.id && !prevKeyById.has(m.id)) added.set(m.role, (added.get(m.role) ?? 0) + 1);
	}
	const pairs = new Map<string, string[]>();
	for (const [role, keys] of removed) {
		if (added.get(role) === keys.length) pairs.set(role, [...keys]);
	}

	const used = new Set<string>();
	const keys = messages.map((m, i) => {
		let key = m.id ? prevKeyById.get(m.id) : undefined;
		if (key === undefined && m.id) key = pairs.get(m.role)?.shift();
		if (key === undefined) key = m.id || `m-${i}`;
		if (used.has(key)) key = `${key}#${i}`;
		used.add(key);
		return key;
	});
	return { ids: messages.map((m) => m.id), roles: messages.map((m) => m.role), keys };
}
