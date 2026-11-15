/**
 * Where the unsent ink of every page is kept (owner plan, 2026-11-15). localStorage is 5 MiB for the whole origin and its
 * writes are synchronous; the WebView's IndexedDB quota is gigabytes. This is the small async seam ink-memory writes through:
 * an IndexedDB implementation for the app, and an in-memory one for tests (Node has no IndexedDB).
 *
 * A record is the page's JSON text with the stamp of the write that made it (the stamp lets a restore pick the newer of this
 * and the small synchronous localStorage mirror). Records are small in number (one per page, one per undo history).
 */

export interface InkRecord {
	t: number;
	text: string;
}

export interface InkStore {
	get(key: string): Promise<InkRecord | null>;
	set(key: string, record: InkRecord): Promise<void>;
	remove(keys: string[]): Promise<void>;
}

const DB_NAME = "lh-ink";
const STORE = "kv";

/** The IndexedDB store, or null where there is no IndexedDB (a private window, an old WebView, Node). */
export function indexedDbInkStore(): InkStore | null {
	let factory: IDBFactory | undefined;
	try {
		factory = typeof indexedDB === "undefined" ? undefined : indexedDB;
	} catch {
		factory = undefined;
	}
	if (!factory) return null;
	const idb = factory;
	// Android may evict an origin's storage under pressure unless it is marked persistent; asking is free and best-effort.
	try {
		void navigator.storage?.persist?.();
	} catch {
		// not available
	}
	let opened: Promise<IDBDatabase> | null = null;
	const open = (): Promise<IDBDatabase> =>
		(opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const req = idb.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				req.result.createObjectStore(STORE);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => {
				opened = null;
				reject(req.error ?? new Error("IndexedDB did not open"));
			};
			req.onblocked = () => {
				opened = null;
				reject(new Error("IndexedDB is blocked"));
			};
		}));
	// One transaction per call; the promise settles when the transaction has COMPLETED (committed), not when the request fired.
	const run = async (mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest | undefined): Promise<unknown> => {
		const db = await open();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const req = body(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(req?.result);
			tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
		});
	};
	return {
		async get(key) {
			const value = (await run("readonly", (s) => s.get(key))) as InkRecord | undefined;
			return value && typeof value.t === "number" && typeof value.text === "string" ? value : null;
		},
		async set(key, record) {
			await run("readwrite", (s) => s.put(record, key));
		},
		async remove(keys) {
			await run("readwrite", (s) => {
				for (const k of keys) s.delete(k);
				return undefined;
			});
		},
	};
}

/** A store in memory, for tests: `failWrites` makes every write reject (a full or broken database), `failReads` every read. */
export function memoryInkStore(): InkStore & { data: Map<string, InkRecord>; failWrites: boolean; failReads: boolean; delayMs: number } {
	const data = new Map<string, InkRecord>();
	const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const store = {
		data,
		failWrites: false,
		failReads: false,
		delayMs: 0,
		async get(key: string) {
			if (store.delayMs) await wait(store.delayMs);
			if (store.failReads) throw new Error("read failed");
			return data.get(key) ?? null;
		},
		async set(key: string, record: InkRecord) {
			if (store.delayMs) await wait(store.delayMs);
			if (store.failWrites) throw new DOMException("full", "QuotaExceededError");
			data.set(key, record);
		},
		async remove(keys: string[]) {
			if (store.delayMs) await wait(store.delayMs);
			if (store.failWrites) throw new DOMException("full", "QuotaExceededError");
			for (const k of keys) data.delete(k);
		},
	};
	return store;
}
