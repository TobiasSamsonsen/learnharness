import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { SyncStatus } from "../src/core/index.ts";
import { SyncSection } from "../components/settings/sync-section.tsx";

/**
 * Settings → Sync (components/settings/sync-section.tsx), rendered against a
 * fetch stub. Pinned: the first view says what is missing and keeps Sync now
 * off, Sync now runs a round and shows its outcome, and a failed round reads
 * as a line of text. (Typing into the fields cannot be simulated in linkedom:
 * the requests those buttons make are tested in sync-client.test.ts.)
 */

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
	configured: false,
	repo: null,
	hasToken: false,
	running: false,
	lastRunAt: null,
	lastOkAt: null,
	error: null,
	last: null,
	skipped: [],
	conflictCopies: 0,
	...over,
});

interface Call {
	method: string;
	url: string;
	body: unknown;
}

/** Mount the section with a router-style fetch stub; returns helpers and the call log. */
async function mount(routes: Record<string, (call: Call) => { status?: number; json: unknown }>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const calls: Call[] = [];
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
			calls.push(call);
			const route = routes[`${call.method} ${url}`];
			assert.ok(route, `unexpected request: ${call.method} ${url}`);
			const r = route(call);
			return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<SyncSection />);
	});
	const q = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
	const click = async (id: string) => {
		await act(async () => {
			q<HTMLButtonElement>(id)!.click();
		});
	};
	const cleanup = () => {
		act(() => {
			root.unmount();
		});
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	return { q, click, calls, cleanup };
}

describe("Settings → Sync", () => {
	it("says what is missing and keeps Sync now off until a repo and token are set", async () => {
		const ui = await mount({
			"GET /api/sync": () => ({ json: status() }),
			"GET /api/settings": () => ({ json: { settings: null } }),
		});
		try {
			assert.match(ui.q("sync-status")!.textContent ?? "", /Not set up/);
			assert.equal(ui.q<HTMLButtonElement>("sync-run")!.hasAttribute("disabled"), true);
			assert.equal(ui.q("sync-token-remove"), null, "nothing to remove yet");
			assert.equal(ui.q("sync-error"), null);
		} finally {
			ui.cleanup();
		}
	});

	it("runs a round on Sync now and shows how it went", async () => {
		const ready = status({ configured: true, repo: "me/sync", hasToken: true });
		const synced = status({
			...ready,
			lastOkAt: "2026-03-01T14:02:00",
			last: { at: "2026-03-01T14:02:00", idle: false, pulled: 2, pushed: 1, merged: 0, deleted: 0, conflicts: 0, skipped: 0, notes: [] },
		});
		let ran = false;
		const ui = await mount({
			"GET /api/sync": () => ({ json: ran ? synced : ready }),
			"GET /api/settings": () => ({ json: { settings: { sync: { repo: "me/sync" } } } }),
			"POST /api/sync/run": () => {
				ran = true;
				return { json: synced };
			},
		});
		try {
			assert.match(ui.q("sync-status")!.textContent ?? "", /Ready/);
			assert.equal(ui.q<HTMLButtonElement>("sync-run")!.hasAttribute("disabled"), false);
			await ui.click("sync-run");
			assert.match(ui.q("sync-status")!.textContent ?? "", /2 received · 1 sent/);
		} finally {
			ui.cleanup();
		}
	});

	it("shows what a replace would do and runs it only after a confirm", async () => {
		const ready = status({ configured: true, repo: "me/sync", hasToken: true });
		const done = status({
			...ready,
			lastOkAt: "2026-03-01T14:02:00",
			last: { at: "2026-03-01T14:02:00", idle: false, pulled: 4, pushed: 0, merged: 0, deleted: 2, conflicts: 0, skipped: 0, notes: [], replaced: { written: 4, removed: 2, backup: "replaced-x" } },
		});
		let replaced = false;
		const ui = await mount({
			"GET /api/sync": () => ({ json: replaced ? done : ready }),
			"GET /api/settings": () => ({ json: { settings: { sync: { repo: "me/sync" } } } }),
			"POST /api/sync/replace": (c) => {
				if ((c.body as { dryRun?: boolean }).dryRun) return { json: { preview: { write: { chats: 4 }, remove: { chats: 2 } }, error: null } };
				replaced = true;
				return { json: done };
			},
		});
		try {
			assert.equal(ui.q("sync-replace-confirm"), null, "nothing is asked until the link is pressed");
			await ui.click("sync-replace-open");
			assert.match(ui.q("sync-replace-remove")!.textContent ?? "", /2 chats/);
			assert.match(ui.q("sync-replace-write")!.textContent ?? "", /4 chats/);
			assert.equal(replaced, false, "opening the confirmation changes nothing");
			await ui.click("sync-replace-cancel");
			assert.equal(ui.q("sync-replace-confirm"), null);
			assert.equal(replaced, false, "cancel changes nothing");
			await ui.click("sync-replace-open");
			await ui.click("sync-replace-confirm-run");
			assert.equal(replaced, true);
			assert.equal(ui.q("sync-replace-confirm"), null, "the panel closes");
			assert.match(ui.q("sync-status")!.textContent ?? "", /Replaced from the repo .* 4 received · 2 removed/);
			assert.deepEqual(ui.calls.filter((c) => c.method === "POST").map((c) => c.body), [{ dryRun: true }, { dryRun: true }, { confirm: true }]);
		} finally {
			ui.cleanup();
		}
	});

	it("keeps the replace link off until a repo and token are set", async () => {
		const ui = await mount({
			"GET /api/sync": () => ({ json: status() }),
			"GET /api/settings": () => ({ json: { settings: null } }),
		});
		try {
			assert.equal(ui.q<HTMLButtonElement>("sync-replace-open")!.hasAttribute("disabled"), true);
		} finally {
			ui.cleanup();
		}
	});

	it("shows a failed round as an error line, not a crash", async () => {
		const failed = status({ configured: true, repo: "me/sync", hasToken: true, error: { code: "auth", message: "GitHub refused the token." } });
		const ui = await mount({
			"GET /api/sync": () => ({ json: failed }),
			"GET /api/settings": () => ({ json: { settings: { sync: { repo: "me/sync" } } } }),
		});
		try {
			assert.equal(ui.q("sync-status")!.textContent, "GitHub refused the token.");
		} finally {
			ui.cleanup();
		}
	});
});
