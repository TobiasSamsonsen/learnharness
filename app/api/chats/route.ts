import { chainsForSelection, formatChainLine } from "@/src/core";
import { newGraphContextMessage, type GraphContextPick } from "@/src/core";
import { compactionInFlight, createChat, isTurnRunning, listChats, parseDifficultyField, parsePaceField, parsePaceNoteField, stampNewSession, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem, Difficulty, Pace } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown; pace?: unknown; paceNote?: unknown; difficulty?: unknown };
	// The new-session setup panel's pace and time note (fork addition, 2026-11-01): strict, before anything is created.
	let pace: Pace | undefined;
	if (body.pace !== undefined) {
		const parsed = parsePaceField(body.pace);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		pace = parsed.pace;
	}
	let paceNote: string | undefined;
	if (body.paceNote !== undefined) {
		const parsed = parsePaceNoteField(body.paceNote);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		paceNote = parsed.note;
	}
	// The new-session setup panel's problem difficulty (fork addition, 2026-11-07): strict, like the pace.
	let difficulty: Difficulty | undefined;
	if (body.difficulty !== undefined) {
		const parsed = parseDifficultyField(body.difficulty);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		difficulty = parsed.difficulty;
	}
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	const kind = body.kind === "practice" ? ("practice" as const) : undefined;
	const chat = createChat(titleFromPrompt(title || "Untitled session"), kind);
	// The birth stamp — the session's model, thinking level and language
	// (server/chats.ts stampNewSession).
	stampNewSession(chat.id, { ...(pace ? { pace } : {}), ...(paceNote ? { paceNote } : {}), ...(difficulty ? { difficulty } : {}) });
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(picks, chainLines)]);
	}
	return Response.json({ id: chat.id, title: chat.title });
}
