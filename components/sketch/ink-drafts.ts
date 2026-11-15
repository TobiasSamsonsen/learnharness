/**
 * The client half of the server copy of unsent ink (owner plan, 2026-11-15; server side in src/store/ink-drafts.ts).
 *
 * localStorage is the first layer, but it is 5 MB and shared by every page's ink: when it is full, or the WebView is gone, the
 * page used to be lost. Here the page's unsent strokes are also PUT to the server a few seconds after drawing stops, DELETEd
 * once the page is sent or cleared, and fetched back when the page is opened with no ink of its own. Every failure is silent
 * (the server can be asleep or killed): the local copy still stands.
 */

export const DRAFT_PUSH_DELAY_MS = 3000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetch | null = typeof window !== "undefined" && typeof fetch === "function" && process.env.NODE_ENV !== "test" ? (i, init) => fetch(i, init) : null;
let delay = DRAFT_PUSH_DELAY_MS;

/** Test seam: a fetch to use (null switches the drafts off) and the push delay. */
export function configureInkDrafts(opts: { fetch: Fetch | null; delayMs?: number }): void {
	fetcher = opts.fetch;
	delay = opts.delayMs ?? DRAFT_PUSH_DELAY_MS;
	timers.forEach((t) => clearTimeout(t));
	timers.clear();
	waiting.clear();
	lastPushed.clear();
	queues.clear();
}

export const inkDraftsEnabled = (): boolean => fetcher !== null;

const url = (key: string) => `/api/ink-drafts/${encodeURIComponent(key)}`;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const waiting = new Map<string, string>();
const lastPushed = new Map<string, string>();
// one request at a time per key, in order: a DELETE (the page was sent) must never be overtaken by an older PUT
const queues = new Map<string, Promise<void>>();

function enqueue(key: string, job: () => Promise<void>): Promise<void> {
	const run = (queues.get(key) ?? Promise.resolve()).then(job, job).catch(() => {});
	queues.set(key, run);
	return run;
}

async function push(key: string, text: string): Promise<void> {
	if (!fetcher) return;
	const res = await fetcher(url(key), { method: "PUT", headers: { "Content-Type": "application/json" }, body: text });
	if (res.ok) lastPushed.set(key, text);
}

/** The page's unsent strokes JSON, to be copied to the server after a pause (the newest text per key wins). */
export function scheduleDraftPush(key: string, text: string): void {
	if (!fetcher || lastPushed.get(key) === text) return;
	waiting.set(key, text);
	clearTimeout(timers.get(key));
	timers.set(
		key,
		setTimeout(() => flushDraft(key), delay),
	);
}

/** Send what is waiting for this key now. */
export function flushDraft(key: string): void {
	clearTimeout(timers.get(key));
	timers.delete(key);
	const text = waiting.get(key);
	waiting.delete(key);
	if (text !== undefined) void enqueue(key, () => push(key, text));
}

/** Send everything waiting (the page is being hidden). */
export function flushAllDrafts(): void {
	for (const key of [...waiting.keys()]) flushDraft(key);
}

/** The page was sent or cleared: the server copy goes, and a push still waiting is cancelled. */
export function dropDraft(key: string): void {
	if (!fetcher) return;
	clearTimeout(timers.get(key));
	timers.delete(key);
	waiting.delete(key);
	lastPushed.delete(key);
	const f = fetcher;
	void enqueue(key, async () => void (await f(url(key), { method: "DELETE" })));
}

/** The server's copy of this page's unsent ink (the strokes JSON), or null. */
export async function fetchDraft(key: string): Promise<string | null> {
	if (!fetcher) return null;
	try {
		await (queues.get(key) ?? Promise.resolve());
		const res = await fetcher(url(key));
		if (!res.ok) return null;
		const text = await res.text();
		lastPushed.set(key, text);
		return text;
	} catch {
		return null;
	}
}
