"use client";

/**
 * THE NOTIFICATION CHANNEL'S CLIENT HALF (push-architecture slice 3,
 * 2026-10-02): ONE EventSource("/api/events") per open window, held for
 * the window's lifetime — the channel that retires the app's poll
 * lattice. Every server-initiated change arrives as a named SSE frame;
 * consumers respond by fetching truth (notify → fetch, the architecture's
 * whole trick — see src/core/events.ts and server/events-stream.ts).
 *
 * This file is the ONE place in the app that knows EventSource exists.
 * Auto-reconnect is EventSource's own — never fought, always exploited:
 * every (re)open fires the resync callbacks, so a reconnect heals with
 * one ordinary fetch per consumer (a dev-server restart self-heals here).
 *
 * Shape: the provider holds a hub (window-local fan-out — the client twin
 * of the server bus; per-window, NOT globalThis: each window's connection
 * is its own) and wires ONE source into it. The hooks are thin: latest-ref
 * callbacks (events fire between renders — never trust a stale closure)
 * plus hub membership for the component's lifetime.
 *
 * TEST SEAM: `connect` injects the source factory — the hub + wiring are
 * plain functions the tests drive directly (no React, no server); the
 * React glue is an adapter seam like lh:turn-state (untested by
 * precedent, components/session.ts).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { SERVER_EVENT_TYPES, type ServerEventType, type ServerEvents } from "@/src/core";

/** The minimal source surface the provider consumes — EventSource behind
 *  this in production, fakes in tests. */
export interface NotifySource {
	close(): void;
	onOpen(cb: () => void): void;
	onEvent(name: string, cb: (data: string) => void): void;
	/** The connection broke (the server went away, or has not come back yet). The source reconnects by itself and calls onOpen when it has. */
	onError?(cb: () => void): void;
}

export function openEventsChannel(): NotifySource {
	const es = new EventSource("/api/events");
	return {
		close: () => es.close(),
		onOpen: (cb) => {
			es.onopen = () => cb();
		},
		onEvent: (name, cb) => {
			es.addEventListener(name, (ev) => cb((ev as MessageEvent).data));
		},
		onError: (cb) => {
			es.onerror = () => cb();
		},
	};
}

/** The per-window fan-out: typed subscriptions over one source. Listener
 *  errors are isolated per the bus's law (one bad consumer never breaks
 *  the window), and dispatch iterates a snapshot (an unsubscribe during
 *  dispatch is safe). */
export function createNotifyHub() {
	const byType = new Map<string, Set<(data: never) => void>>();
	const resyncs = new Set<() => void>();
	// Can the server be reached? True until the channel errors, true again when it reopens (fork addition, 2026-11-03:
	// after the Android app rests an unused server, the page stays up while the server starts again, and Send waits for it).
	let reachable = true;
	const reachableListeners = new Set<() => void>();
	return {
		reachable: () => reachable,
		setReachable(next: boolean) {
			if (next === reachable) return;
			reachable = next;
			for (const cb of [...reachableListeners]) cb();
		},
		subscribeReachable(cb: () => void) {
			reachableListeners.add(cb);
			return () => {
				reachableListeners.delete(cb);
			};
		},
		subscribe<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void) {
			const set = byType.get(type) ?? new Set<(data: never) => void>();
			byType.set(type, set);
			const slot = cb as unknown as (data: never) => void;
			set.add(slot);
			return () => set.delete(slot);
		},
		/** Resync callbacks: fired on the source's every (re)open — "you may
		 *  have missed events while disconnected; refetch". A consumer that
		 *  mounts while ALREADY open gets no fire (it missed nothing by
		 *  birth); its own mount fetch is its initial truth. */
		onResync(cb: () => void) {
			resyncs.add(cb);
			return () => resyncs.delete(cb);
		},
		/** One named frame arrived: parse, fan out. Unparseable frames are
		 *  dropped loudly — the channel's payloads are tiny and schemaless,
		 *  a bad frame must never half-fire. */
		dispatch(name: string, raw: string) {
			const set = byType.get(name);
			if (!set) return;
			let payload: unknown;
			try {
				payload = JSON.parse(raw);
			} catch (err) {
				console.error(`[events] unparseable frame for ${name}:`, err);
				return;
			}
			for (const cb of [...set]) {
				try {
					(cb as unknown as (data: unknown) => void)(payload);
				} catch (err) {
					console.error(`[events] ${name} handler failed:`, err);
				}
			}
		},
		fireOpen() {
			for (const cb of [...resyncs]) {
				try {
					cb();
				} catch (err) {
					console.error("[events] resync handler failed:", err);
				}
			}
		},
	};
}

/** Wire one source into a hub — the provider's ENTIRE effect body, factored
 *  out so the wiring is testable without React. Returns the disconnect. */
export function wireSource(source: NotifySource, hub: ReturnType<typeof createNotifyHub>): () => void {
	for (const name of SERVER_EVENT_TYPES) source.onEvent(name, (raw) => hub.dispatch(name, raw));
	source.onOpen(() => {
		hub.setReachable(true);
		hub.fireOpen();
	});
	source.onError?.(() => hub.setReachable(false));
	return () => source.close();
}

// ── the React glue ──────────────────────────────────────────────────────────

const EventsContext = createContext<ReturnType<typeof createNotifyHub> | null>(null);

/** Mount children under a ready-made hub (tests, isolated adapters): the provider without its own channel. */
export function NotifyHubProvider({ hub, children }: { hub: ReturnType<typeof createNotifyHub>; children: ReactNode }) {
	return <EventsContext.Provider value={hub}>{children}</EventsContext.Provider>;
}

/** Transport adapters may also be mounted in isolation with an injected bridge. */
export function useNotifyHub() { return useContext(EventsContext); }

/** How often a broken channel looks for the server, and how it asks (injectable for tests). */
export const SERVER_PROBE_MS = 500;
async function serverAnswers(): Promise<boolean> {
	try {
		return (await fetch("/api/health", { cache: "no-store" })).ok;
	} catch {
		return false;
	}
}

export function ServerEventsProvider({ children, connect, probe }: { children: ReactNode; connect?: () => NotifySource; probe?: () => Promise<boolean> }) {
	const hub = useMemo(() => createNotifyHub(), []);
	// Bumped to open a fresh channel at once instead of waiting out the browser's own reconnect delay.
	const [attempt, setAttempt] = useState(0);
	useEffect(() => wireSource((connect ?? openEventsChannel)(), hub), [hub, connect, attempt]);
	// While the channel is broken (the Android app rested an unused server, or it is restarting), look for the server twice a
	// second; the moment it answers the page is reachable again, resyncs, and opens a fresh channel.
	const reachable = useSyncExternalStore(hub.subscribeReachable, hub.reachable, () => true);
	useEffect(() => {
		if (reachable) return;
		let cancelled = false;
		const id = setInterval(() => {
			void (probe ?? serverAnswers)().then((up) => {
				if (!up || cancelled) return;
				// The server answers, so it is reachable now. Do not wait for the new channel to report open: a browser only does that
				// when the server's first bytes arrive, which can be a whole heartbeat (25 s) away, and Send would stay off meanwhile.
				hub.setReachable(true);
				hub.fireOpen(); // every consumer refetches what it missed while the server was away
				setAttempt((n) => n + 1);
			});
		}, SERVER_PROBE_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [reachable, hub, probe]);
	return <EventsContext.Provider value={hub}>{children}</EventsContext.Provider>;
}

/** Subscribe to one event type for this component's lifetime. The callback
 *  is a latest-ref: pass inline closures freely — the freshest render's
 *  closure runs, so state captured at the last completed render is safe to
 *  read (the provider re-stores it every render). */
export function useServerEvent<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void): void {
	const hub = useContext(EventsContext);
	if (!hub) throw new Error("useServerEvent requires <ServerEventsProvider>");
	const cbRef = useRef(cb);
	cbRef.current = cb;
	useEffect(() => {
		const off = hub.subscribe(type, (payload) => cbRef.current(payload));
		return () => {
			off();
		};
	}, [hub, type]);
}

/**
 * Can this window reach its server right now? False from the moment the live channel breaks until it reopens. True when there is
 * no provider (an isolated component) or before the channel has ever failed. The composer's Send waits on it.
 */
export function useServerReachable(): boolean {
	const hub = useContext(EventsContext);
	return useSyncExternalStore(
		(cb) => (hub ? hub.subscribeReachable(cb) : () => {}),
		() => (hub ? hub.reachable() : true),
		() => true,
	);
}

/** Refetch truth on every (re)connect of the window's channel — the
 *  self-heal seam for EventSource reconnects and dev-server restarts. */
export function useServerResync(cb: () => void): void {
	const hub = useContext(EventsContext);
	if (!hub) throw new Error("useServerResync requires <ServerEventsProvider>");
	const cbRef = useRef(cb);
	cbRef.current = cb;
	useEffect(() => {
		const off = hub.onResync(() => cbRef.current());
		return () => {
			off();
		};
	}, [hub]);
}
