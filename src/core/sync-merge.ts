/**
 * GitHub sync, the merge rules (fork addition, 2026-11-02). PURE, browser-safe.
 *
 * `mergeFile` resolves ONE file that both devices changed (a `merge` action
 * from computeSyncPlan: src/core/sync-plan.ts), or that one device deleted
 * while the other changed it. It sees text only:
 *
 *   base    the file as the last sync left it, or null when unknown (a first
 *           sync, or the old blob could not be fetched). Without a base every
 *           rule falls back to a safe union / the preferred side, and a
 *           deletion made on one side cannot be told from a line the other
 *           side added.
 *   local   this device's copy.      remote   the repo's copy.
 *   prefer  which side wins a tie the data cannot settle (no timestamp in the
 *           file). The caller decides it (newer file time / newer commit).
 *
 * Owner decisions (2026-11-02) this encodes:
 *   - newest wins and the loser is KEPT: a result's `loser` is the whole
 *     other version, for the caller to save as a .conflict copy outside the
 *     live data;
 *   - a delete against an edit keeps the edit, on every kind of file;
 *   - the graph ledgers merge line by line with deleted ids staying deleted;
 *   - settings travel only their portable part (portableSettings).
 *
 * Every merged file is written the way its store writes it (tab-indented
 * JSON, no trailing newline; ledgers one JSON line each), so a merge that
 * changes nothing produces no diff.
 */

export type Side = "local" | "remote";

export interface MergeInput {
	/** Repo path, forward-slashed (decides which rule applies). */
	path: string;
	base: string | null;
	/** null = deleted on this device. */
	local: string | null;
	/** null = deleted in the repo. */
	remote: string | null;
	prefer: Side;
}

export interface MergeResult {
	/** The merged file; null deletes it on both sides. */
	content: string | null;
	/** The version that lost, to keep as a .conflict copy; null when nothing was overridden. */
	loser: string | null;
	/** Plain-language lines for the sync status ("kept the newer chat, ..."). */
	notes: string[];
	/** Set when the file must be left alone on both sides (a newer app wrote it). */
	skipped: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const pretty = (v: unknown): string => JSON.stringify(v, null, "\t");

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
	if (isObj(a) && isObj(b)) {
		const ka = Object.keys(a);
		return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
	}
	return false;
}

function parseObj(text: string | null): Obj | null {
	if (text === null) return null;
	try {
		const v = JSON.parse(text) as unknown;
		return isObj(v) ? v : null;
	} catch {
		return null;
	}
}

function result(content: string | null, extra: Partial<Omit<MergeResult, "content">> = {}): MergeResult {
	return { content, loser: null, notes: [], skipped: null, ...extra };
}

const other = (i: MergeInput, side: Side): string | null => (side === "local" ? i.remote : i.local);
const own = (i: MergeInput, side: Side): string | null => (side === "local" ? i.local : i.remote);

/** The preferred side's whole file wins; the other is kept as the loser. */
function pickPreferred(i: MergeInput, note: string): MergeResult {
	return result(own(i, i.prefer), { loser: other(i, i.prefer), notes: [note] });
}

/** The side whose ISO `updatedAt` is later; a tie or a missing stamp goes to `prefer`. */
function laterSide(l: unknown, r: unknown, prefer: Side): Side {
	if (typeof l === "string" && typeof r === "string" && l !== r) return l > r ? "local" : "remote";
	return prefer;
}

/** The later of two ISO stamps. */
const maxIso = (a: unknown, b: unknown): unknown =>
	typeof a === "string" && typeof b === "string" ? (a > b ? a : b) : (a ?? b);

/**
 * One value, three-way: take the side that changed it since the base; if both
 * changed it differently, the `winner` side. `conflict` is set when a side's
 * different value was overridden.
 */
function threeWay(b: unknown, l: unknown, r: unknown, winner: Side, hasBase: boolean): { value: unknown; conflict: boolean } {
	if (deepEqual(l, r)) return { value: l, conflict: false };
	if (!hasBase) {
		// no base to say it was deleted: a value only one side has is kept
		if (l === undefined) return { value: r, conflict: false };
		if (r === undefined) return { value: l, conflict: false };
	}
	if (hasBase) {
		if (deepEqual(l, b)) return { value: r, conflict: false };
		if (deepEqual(r, b)) return { value: l, conflict: false };
	}
	return { value: winner === "local" ? l : r, conflict: true };
}

/** Three-way over a plain object, key by key, descending `depth` more levels into nested objects. */
function mergeObject3(b: Obj | null, l: Obj, r: Obj, winner: Side, depth: number): { value: Obj; conflict: boolean } {
	const out: Obj = {};
	let conflict = false;
	for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
		const lv = l[key];
		const rv = r[key];
		const bv = b?.[key];
		if (depth > 0 && isObj(lv) && isObj(rv) && !deepEqual(lv, rv) && (b === null || isObj(bv) || bv === undefined)) {
			const inner = mergeObject3(isObj(bv) ? bv : null, lv, rv, winner, depth - 1);
			out[key] = inner.value;
			conflict ||= inner.conflict;
			continue;
		}
		const m = threeWay(bv, lv, rv, winner, b !== null);
		conflict ||= m.conflict;
		if (m.value !== undefined) out[key] = m.value;
	}
	return { value: out, conflict };
}

/** Union of two lists by a key, `a`'s entries first, each key once; later sorted by `sortKey` when given. */
function unionBy<T>(a: readonly T[], b: readonly T[], key: (t: T) => string | null, sortKey?: (t: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const t of [...a, ...b]) {
		const k = key(t);
		if (k !== null) {
			if (seen.has(k)) continue;
			seen.add(k);
		}
		out.push(t);
	}
	return sortKey ? out.map((t, i) => ({ t, i })).sort((x, y) => (sortKey(x.t) < sortKey(y.t) ? -1 : sortKey(x.t) > sortKey(y.t) ? 1 : x.i - y.i)).map((x) => x.t) : out;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const idOf = (v: unknown): string | null => (isObj(v) ? str(v.id) : null);

// ─── Chats ─────────────────────────────────────────────────────────────────

const CHAT_VERSION = 1;

function isIdPrefix(shorter: readonly unknown[], longer: readonly unknown[]): boolean {
	return shorter.length <= longer.length && shorter.every((m, i) => idOf(m) !== null && idOf(m) === idOf(longer[i]));
}

/**
 * Messages are append-only (nothing edits, regenerates or deletes one), so
 * two copies of a chat are normally one a prefix of the other: take the
 * longer. If both appended different messages the order cannot be
 * interleaved (tool-call pairing and the compaction cut depend on it): the
 * newer chat wins whole and the other is kept as the loser. The append-only
 * logs (turns, extractions, clarify threads) union by id; title, settings and
 * tree take whichever side changed them since the base.
 */
function mergeChat(i: MergeInput & { local: string; remote: string }): MergeResult {
	const l = parseObj(i.local);
	const r = parseObj(i.remote);
	if (!l || !r) return pickPreferred(i, "a chat file could not be read; kept the preferred copy");
	const b = parseObj(i.base);
	if ((typeof l.version === "number" && l.version > CHAT_VERSION) || (typeof r.version === "number" && r.version > CHAT_VERSION)) {
		return result(i.local, { skipped: "this chat was written by a newer version of the app" });
	}
	const newer = laterSide(l.updatedAt, r.updatedAt, i.prefer);
	const winner = newer === "local" ? l : r;
	const lm = arr(l.messages);
	const rm = arr(r.messages);
	const out: Obj = { ...winner };
	const notes: string[] = [];
	let loser: string | null = null;

	if (isIdPrefix(lm, rm)) out.messages = rm;
	else if (isIdPrefix(rm, lm)) out.messages = lm;
	else {
		// Diverged: `winner` already supplies messages and the logs below.
		loser = other(i, newer);
		notes.push("this chat was continued on both devices; kept the newer one and saved the other as a conflict copy");
	}
	const diverged = loser !== null;

	if (!diverged) {
		out.turns = unionBy(arr(l.turns), arr(r.turns), idOf, (t) => (isObj(t) ? (str(t.at) ?? "") : ""));
		out.extractions = unionBy(arr(l.extractions), arr(r.extractions), (x) => (isObj(x) ? str(x.startedAt) : null), (x) =>
			isObj(x) ? (str(x.startedAt) ?? "") : "",
		);
		out.clarifyThreads = unionBy(arr(l.clarifyThreads), arr(r.clarifyThreads), idOf).map((t) => {
			if (!isObj(t)) return t;
			const same = (side: Obj) => arr(side.clarifyThreads).find((x) => idOf(x) === t.id);
			const lt = same(l);
			const rt = same(r);
			if (!isObj(lt) || !isObj(rt)) return t;
			return { ...t, entries: unionBy(arr(lt.entries), arr(rt.entries), idOf, (e) => (isObj(e) ? (str(e.at) ?? "") : "")) };
		});
		for (const k of ["turns", "extractions", "clarifyThreads"]) if (arr(out[k]).length === 0 && !(k in winner)) delete out[k];
		for (const key of ["title", "settings", "tree"]) {
			const m = threeWay(b?.[key], l[key], r[key], newer, b !== null);
			if (m.value === undefined) delete out[key];
			else out[key] = m.value;
			if (m.conflict) {
				loser ??= other(i, newer);
				notes.push(`the chat's ${key} was changed on both devices; kept the newer`);
			}
		}
	}
	out.updatedAt = maxIso(l.updatedAt, r.updatedAt);
	out.version = CHAT_VERSION;
	return result(pretty(out), { loser, notes });
}

// ─── Courses ───────────────────────────────────────────────────────────────

const COURSE_VERSION = 1;
/** Fields that move together (an approval sets all four): taken from one side as a unit. */
const COURSE_UNIT = ["status", "skills", "draft", "error"] as const;

function mergeCourse(i: MergeInput & { local: string; remote: string }): MergeResult {
	const l = parseObj(i.local);
	const r = parseObj(i.remote);
	if (!l || !r) return pickPreferred(i, "a course file could not be read; kept the preferred copy");
	const b = parseObj(i.base);
	if ((typeof l.version === "number" && l.version > COURSE_VERSION) || (typeof r.version === "number" && r.version > COURSE_VERSION)) {
		return result(i.local, { skipped: "this course was written by a newer version of the app" });
	}
	const newer = laterSide(l.updatedAt, r.updatedAt, i.prefer);
	const out: Obj = { ...(newer === "local" ? l : r) };
	const notes: string[] = [];
	let loser: string | null = null;
	const overridden = (what: string) => {
		loser ??= other(i, newer);
		notes.push(`the course's ${what} was changed on both devices; kept the newer`);
	};

	for (const key of ["title", "language", "note"]) {
		const m = threeWay(b?.[key], l[key], r[key], newer, b !== null);
		if (m.value === undefined) delete out[key];
		else out[key] = m.value;
		if (m.conflict) overridden(key);
	}
	// The unit moves together: whichever side changed any of it since the base,
	// or (both changed) the newer. Without a base, the newer side's.
	const pick = (side: Obj) => Object.fromEntries(COURSE_UNIT.filter((k) => k in side).map((k) => [k, side[k]]));
	const lu = pick(l);
	const ru = pick(r);
	const bu = b ? pick(b) : null;
	const unit = threeWay(bu, lu, ru, newer, b !== null);
	for (const k of COURSE_UNIT) delete out[k];
	Object.assign(out, unit.value as Obj);
	if (unit.conflict) overridden("approval state");

	out.drafts = unionBy(arr(l.drafts), arr(r.drafts), (d) => (isObj(d) ? str(d.startedAt) : null), (d) => (isObj(d) ? (str(d.startedAt) ?? "") : ""));
	if (arr(out.drafts).length === 0) delete out.drafts;
	out.updatedAt = maxIso(l.updatedAt, r.updatedAt);
	out.version = COURSE_VERSION;
	return result(pretty(out), { loser, notes });
}

// ─── Graph ledgers (JSONL) ─────────────────────────────────────────────────

interface Line {
	text: string;
	rec: Obj;
}

/** Valid lines only; a torn line is skipped, the way the stores' readers skip it. */
function parseLines(text: string | null): Line[] {
	if (text === null) return [];
	const out: Line[] = [];
	for (const raw of text.split("\n")) {
		const t = raw.trim();
		if (t.length === 0) continue;
		try {
			const rec = JSON.parse(t) as unknown;
			if (isObj(rec)) out.push({ text: t, rec });
		} catch {
			/* torn append */
		}
	}
	return out;
}

const writeLines = (lines: readonly Line[]): string => lines.map((x) => x.text).join("\n") + (lines.length > 0 ? "\n" : "");

/**
 * nodes / chains / skills: each line is a whole record with an `id`; the
 * FIRST line of an id defines it, later lines add to it. Line-level three-way
 * against the base: a line the base had survives only if BOTH sides still have
 * it (a side that rewrote or dropped it, as a source deletion does, removes
 * it), then each side's new lines are added. An id the base had that a side no
 * longer has at all is deleted on that side: all its lines go, even new ones
 * from the other side. Lines are grouped by id, oldest `createdAt` first, so
 * the defining line stays first. With no base this is a plain union.
 */
function mergeIdLedger(i: MergeInput): MergeResult {
	const l = parseLines(i.local);
	const r = parseLines(i.remote);
	const baseLines = i.base === null ? null : parseLines(i.base);
	const idOfLine = (x: Line) => str(x.rec.id);
	const preferred = i.prefer === "local" ? l : r;
	const secondary = i.prefer === "local" ? r : l;

	let survivors: Line[];
	const dropped: string[] = [];
	if (baseLines === null) {
		survivors = unionBy([...preferred, ...secondary], [], (x) => x.text);
	} else {
		const inL = new Set(l.map((x) => x.text));
		const inR = new Set(r.map((x) => x.text));
		const inBase = new Set(baseLines.map((x) => x.text));
		const keepBase = new Set(baseLines.filter((x) => inL.has(x.text) && inR.has(x.text)).map((x) => x.text));
		const alive = (x: Line) => (inBase.has(x.text) ? keepBase.has(x.text) : true);
		survivors = unionBy([...preferred.filter(alive), ...secondary.filter(alive)], [], (x) => x.text);
		const idsL = new Set(l.map(idOfLine));
		const idsR = new Set(r.map(idOfLine));
		const gone = new Set<string>();
		for (const x of baseLines) {
			const id = idOfLine(x);
			if (id !== null && (!idsL.has(id) || !idsR.has(id))) gone.add(id);
		}
		survivors = survivors.filter((x) => {
			const id = idOfLine(x);
			if (id !== null && gone.has(id)) {
				dropped.push(id);
				return false;
			}
			return true;
		});
	}

	// group by id (first appearance), each group oldest createdAt first, ties in assembled order
	const groups = new Map<string, Line[]>();
	const loose: Line[] = [];
	for (const x of survivors) {
		const id = idOfLine(x);
		if (id === null) loose.push(x);
		else groups.set(id, [...(groups.get(id) ?? []), x]);
	}
	const created = (x: Line) => str(x.rec.createdAt) ?? "";
	const ordered = [...groups.values()].flatMap((g) =>
		g.map((x, n) => ({ x, n })).sort((a, b) => (created(a.x) < created(b.x) ? -1 : created(a.x) > created(b.x) ? 1 : a.n - b.n)).map((e) => e.x),
	);
	const notes = dropped.length > 0 ? [`${new Set(dropped).size} deleted item(s) in the graph stayed deleted`] : [];
	return result(writeLines([...ordered, ...loose]), { notes });
}

/** coverage.jsonl: derived and self-healing; one row per chat, the later `foldedAt` wins. */
function mergeCoverage(i: MergeInput): MergeResult {
	const byChat = new Map<string, Line>();
	for (const x of [...parseLines(i.local), ...parseLines(i.remote)]) {
		const chat = str(x.rec.chatId);
		if (chat === null) continue;
		const have = byChat.get(chat);
		if (!have || (str(x.rec.foldedAt) ?? "") > (str(have.rec.foldedAt) ?? "")) byChat.set(chat, x);
	}
	return result(writeLines([...byChat.values()]));
}

// ─── Small JSON files ──────────────────────────────────────────────────────

/** positions.json is rebuildable: the newer `updatedAt` wins whole. */
function mergePositions(i: MergeInput & { local: string; remote: string }): MergeResult {
	const l = parseObj(i.local);
	const r = parseObj(i.remote);
	if (!l || !r) return pickPreferred(i, "the layout file could not be read; kept the preferred copy");
	const side = laterSide(l.updatedAt, r.updatedAt, i.prefer);
	return result(own(i, side));
}

/** format.json: the higher format version, so an older device never lowers the stamp. */
function mergeFormat(i: MergeInput & { local: string; remote: string }): MergeResult {
	const l = parseObj(i.local);
	const r = parseObj(i.remote);
	if (!l || !r) return pickPreferred(i, "the graph format file could not be read; kept the preferred copy");
	const lv = typeof l.version === "number" ? l.version : 0;
	const rv = typeof r.version === "number" ? r.version : 0;
	return result(own(i, lv === rv ? i.prefer : lv > rv ? "local" : "remote"));
}

/** A JSON object with no timestamp: top-level key by key, `depth` more levels into nested objects. */
function mergeSections(i: MergeInput & { local: string; remote: string }, depth: number): MergeResult {
	const l = parseObj(i.local);
	const r = parseObj(i.remote);
	if (!l || !r) return pickPreferred(i, "a settings file could not be read; kept the preferred copy");
	const m = mergeObject3(parseObj(i.base), l, r, i.prefer, depth);
	return m.conflict
		? result(pretty(m.value), { loser: other(i, i.prefer), notes: ["a setting was changed on both devices; kept the preferred one"] })
		: result(pretty(m.value));
}

// ─── Settings: the portable part ───────────────────────────────────────────

/** Top-level sections that travel whole. */
const PORTABLE_SECTIONS = ["version", "agent", "models", "graph", "compaction"] as const;
/** `general` travels only these; the rest of it (dictationEngine, autoUpdate) is per device. */
const PORTABLE_GENERAL = ["language", "pace", "difficulty"] as const;

/** Sorted keys, tab-indented: two devices holding the same settings produce the same bytes. */
export function canonicalJson(v: unknown): string {
	const sort = (x: unknown): unknown =>
		Array.isArray(x)
			? x.map(sort)
			: isObj(x)
				? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]))
				: x;
	return JSON.stringify(sort(v), null, "\t");
}

/**
 * The part of settings.json that travels between devices (owner decision,
 * 2026-11-02): models, agent, graph, compaction and general.language/pace/difficulty.
 * customProvider, claudeCode, dictation, appearance, notices,
 * general.dictationEngine/autoUpdate and any unknown key stay on the device.
 * null when the text is not a JSON object.
 */
export function portableSettings(json: string): string | null {
	const s = parseObj(json);
	if (!s) return null;
	const out: Obj = {};
	for (const k of PORTABLE_SECTIONS) if (k in s) out[k] = s[k];
	if (isObj(s.general)) {
		const g = Object.fromEntries(PORTABLE_GENERAL.filter((k) => k in (s.general as Obj)).map((k) => [k, (s.general as Obj)[k]]));
		if (Object.keys(g).length > 0) out.general = g;
	}
	return canonicalJson(out);
}

/**
 * The device's full settings.json after taking in `portable` (another
 * device's portableSettings): the portable keys are replaced by the incoming
 * ones, everything else is left exactly as it was.
 */
export function applyPortableSettings(localFull: string | null, portable: string): string {
	const local = parseObj(localFull) ?? {};
	const incoming = parseObj(portable);
	if (!incoming) return localFull ?? pretty(local);
	const out: Obj = { ...local };
	for (const k of PORTABLE_SECTIONS) {
		if (k in incoming) out[k] = incoming[k];
		else if (k !== "version") delete out[k];
	}
	const general: Obj = isObj(local.general) ? { ...local.general } : {};
	const inGeneral = isObj(incoming.general) ? incoming.general : {};
	for (const k of PORTABLE_GENERAL) {
		if (k in inGeneral) general[k] = inGeneral[k];
		else delete general[k];
	}
	if (Object.keys(general).length > 0) out.general = general;
	else delete out.general;
	return pretty(out);
}

// ─── Materials ─────────────────────────────────────────────────────────────

const STATUS_RANK: Record<string, number> = { ready: 2, error: 1, reading: 0 };
const rank = (m: unknown): number => (isObj(m) ? (STATUS_RANK[str(m.status) ?? ""] ?? 0) : 0);

function readMaterials(text: string | null): Obj[] | null {
	if (text === null) return [];
	try {
		const v = JSON.parse(text) as unknown;
		return Array.isArray(v) ? v.filter(isObj) : null;
	} catch {
		return null;
	}
}

/**
 * The part of a materials index that travels: every item except those still
 * "reading". A reading item is being profiled by a worker on ONE device;
 * syncing it would make the other device start its own profile (a second paid
 * model run) and the two could disagree about its outcome. It travels once it
 * is ready or has failed. null when the text is not a JSON list.
 */
export function portableMaterials(json: string): string | null {
	const items = readMaterials(json);
	return items === null ? null : pretty(items.filter((m) => m.status !== "reading"));
}

/**
 * This device's materials index after taking in another device's portable
 * list: the incoming items replace everything that travels, and this device's
 * own still-reading items are kept (they are not in the incoming list).
 */
export function applyPortableMaterials(localFull: string | null, portable: string): string {
	const local = readMaterials(localFull) ?? [];
	const incoming = readMaterials(portable);
	if (incoming === null) return localFull ?? pretty(local);
	const ids = new Set(incoming.map((m) => str(m.id)));
	return pretty([...incoming, ...local.filter((m) => m.status === "reading" && !ids.has(str(m.id)))]);
}

/**
 * index.json is a list keyed by `id`. An item one side removed is removed
 * only if the other side did not change it since the base (a delete against an
 * edit keeps the edit). An item on both sides keeps the further-along status
 * (ready over error over still-reading) and any reading profile.
 */
function mergeMaterials(i: MergeInput): MergeResult {
	const l = readMaterials(i.local);
	const r = readMaterials(i.remote);
	if (!l || !r) return pickPreferred(i, "a materials list could not be read; kept the preferred copy");
	const b = readMaterials(i.base);
	const baseById = new Map((b ?? []).map((m) => [str(m.id), m] as const));
	const rById = new Map(r.map((m) => [str(m.id), m] as const));
	const lById = new Map(l.map((m) => [str(m.id), m] as const));
	const out: Obj[] = [];
	// the base's order first, then what is new, local before remote
	for (const m of [...(b ?? []), ...l, ...r]) {
		const id = str(m.id);
		if (id === null || out.some((x) => x.id === id)) continue;
		const lm = lById.get(id);
		const rm = rById.get(id);
		const bm = baseById.get(id);
		if (!lm && !rm) continue; // gone from both sides
		if (lm && rm) {
			// only one side changed it since the base: that side's version
			if (bm && deepEqual(lm, bm)) {
				out.push(rm);
				continue;
			}
			if (bm && deepEqual(rm, bm)) {
				out.push(lm);
				continue;
			}
			const localWins = rank(lm) === rank(rm) ? i.prefer === "local" : rank(lm) > rank(rm);
			const win = localWins ? lm : rm;
			const lose = localWins ? rm : lm;
			out.push(!str(win.profile) && str(lose.profile) ? { ...win, profile: lose.profile } : win);
		} else {
			const present = (lm ?? rm) as Obj;
			// absent on one side: a deletion if the base had it and this side did not touch it
			if (bm && deepEqual(present, bm)) continue;
			out.push(present);
		}
	}
	return result(pretty(out));
}

// ─── Entry point ───────────────────────────────────────────────────────────

/** Resolve one file both devices changed. Never throws on bad data: an unreadable file falls back to the preferred side. */
export function mergeFile(input: MergeInput): MergeResult {
	const { local, remote } = input;
	if (local === null && remote === null) return result(null);
	if (local === null || remote === null) {
		return result(local ?? remote, { notes: ["kept the edited copy of a file the other device deleted"] });
	}
	if (local === remote) return result(local);
	const i = { ...input, local, remote };
	const p = input.path;

	if (/^chats\/[^/]+\.json$/.test(p)) return mergeChat(i);
	if (/^courses\/[^/]+\.json$/.test(p)) return mergeCourse(i);
	if (/^graph\/(?:nodes|chains|skills)\.jsonl$/.test(p)) return mergeIdLedger(i);
	if (p === "graph/coverage.jsonl") return mergeCoverage(i);
	if (p === "graph/positions.json") return mergePositions(i);
	if (p === "graph/format.json") return mergeFormat(i);
	if (p === "graph/render-settings.json") return mergeSections(i, 1);
	if (p === "settings.json") return mergeSections(i, 1);
	if (/^materials\/[^/]+\/index\.json$/.test(p)) return mergeMaterials(i);
	// prompt overrides, material text, sketch files and anything else: the preferred copy wins
	// (sketch ids are write-once, so a real difference there is rare).
	return pickPreferred(i, "both devices changed this file; kept the preferred copy and saved the other");
}
