import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { ChatSessionComposer } from "../components/composer.tsx";
import { createNotifyHub, NotifyHubProvider, ServerEventsProvider, SERVER_PROBE_MS, useServerReachable, useServerResync, type NotifySource } from "../components/server-events.tsx";

/**
 * While the server is not reachable (the Android app rested it and it is starting again) the page stays up: the composer's
 * Send is disabled and says so, and the provider looks for the server twice a second and reconnects the moment it answers.
 */

/** A client render (the live state is deliberately ignored by server rendering, which must match the first client paint). */
async function mountComposer(hub: ReturnType<typeof createNotifyHub> | null, draft = "What is a limit?") {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const g = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, navigator: g.navigator ?? { userAgent: "", platform: "" }, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const el = (
		<ChatSessionComposer busy={false} value={draft} revision={0} onChange={() => {}} onSend={() => {}} onStop={() => {}} sendAllowed dictationActive={false} />
	);
	await act(async () => {
		root.render(hub ? <NotifyHubProvider hub={hub}>{el}</NotifyHubProvider> : el);
	});
	return {
		send: () => document.querySelector<HTMLButtonElement>('button[aria-label="Send"]'),
		placeholder: () => document.querySelector('[role="textbox"]')?.getAttribute("data-placeholder"),
		text: () => document.querySelector('[role="textbox"]')?.textContent,
		change: (fn: () => void) => act(async () => fn()),
		cleanup: () => {
			act(() => {
				root.unmount();
			});
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete g[key];
			}
		},
	};
}

describe("the composer while the server is starting", () => {
	it("sends as usual when the server is reachable", async () => {
		const ui = await mountComposer(createNotifyHub());
		try {
			assert.ok(ui.send(), "the Send button is there");
			assert.equal(ui.send()!.hasAttribute("disabled"), false);
			assert.match(ui.placeholder() ?? "", /Ask, answer, or steer the lesson/);
		} finally {
			ui.cleanup();
		}
	});

	it("disables Send and says the server is starting, keeping what was typed, then recovers by itself", async () => {
		const hub = createNotifyHub();
		hub.setReachable(false);
		const ui = await mountComposer(hub);
		try {
			assert.equal(ui.send()!.hasAttribute("disabled"), true, "Send waits for the server");
			assert.match(ui.placeholder() ?? "", /Starting the server/);
			assert.match(ui.text() ?? "", /What is a limit\?/, "the draft is still there");
			await ui.change(() => hub.setReachable(true)); // the server answered
			assert.equal(ui.send()!.hasAttribute("disabled"), false, "Send is back");
			assert.match(ui.placeholder() ?? "", /Ask, answer, or steer the lesson/);
		} finally {
			ui.cleanup();
		}
	});

	it("an empty draft keeps Send off even when the server is reachable", async () => {
		const ui = await mountComposer(createNotifyHub(), "");
		try {
			assert.equal(ui.send()!.hasAttribute("disabled"), true);
		} finally {
			ui.cleanup();
		}
	});

	it("has no provider in some mounts, and then nothing waits", async () => {
		const ui = await mountComposer(null);
		try {
			assert.equal(ui.send()!.hasAttribute("disabled"), false);
		} finally {
			ui.cleanup();
		}
	});
});

describe("ServerEventsProvider looks for a returning server", () => {
	it("goes unreachable on a channel error, probes, reconnects when the probe answers, and is reachable again on open", async () => {
		const dom = parseHTML("<html><body><div id='root'></div></body></html>");
		const g = globalThis as Record<string, unknown>;
		const previous = new Map<string, PropertyDescriptor | undefined>();
		for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, navigator: g.navigator ?? { userAgent: "", platform: "" }, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		const sources: { open: () => void; fail: () => void; closed: boolean }[] = [];
		const connect = (): NotifySource => {
			let onOpen = () => {};
			let onError = () => {};
			const handle = { open: () => onOpen(), fail: () => onError(), closed: false };
			sources.push(handle);
			return {
				close: () => {
					handle.closed = true;
				},
				onOpen: (cb) => {
					onOpen = cb;
				},
				onEvent() {},
				onError: (cb) => {
					onError = cb;
				},
			};
		};
		let serverUp = false;
		let probes = 0;
		const probe = async () => {
			probes++;
			return serverUp;
		};
		let resyncs = 0;
		function Show() {
			useServerResync(() => {
				resyncs++;
			});
			return <span id="reach">{String(useServerReachable())}</span>;
		}
		const text = () => document.getElementById("reach")?.textContent;
		const wait = (ms: number) =>
			act(async () => {
				await new Promise((r) => setTimeout(r, ms));
			});
		const { createRoot } = await import("react-dom/client");
		const root = createRoot(document.getElementById("root")!);
		try {
			await act(async () => {
				root.render(
					<ServerEventsProvider connect={connect} probe={probe}>
						<Show />
					</ServerEventsProvider>,
				);
			});
			assert.equal(text(), "true");
			assert.equal(sources.length, 1);

			await act(async () => {
				sources[0]!.fail(); // the server went away
			});
			assert.equal(text(), "false");

			await wait(SERVER_PROBE_MS * 2 + 100); // still down: it keeps looking, and keeps the same channel
			assert.ok(probes >= 2, `probed ${probes} times`);
			assert.equal(sources.length, 1, "no reconnect while the server is down");

			serverUp = true; // the server is back
			await wait(SERVER_PROBE_MS + 150);
			assert.equal(text(), "true", "reachable as soon as the probe answers, without waiting for the new channel to report open");
			assert.equal(resyncs, 1, "every consumer was told to refetch what it missed");
			assert.equal(sources.length, 2, "a fresh channel was opened as soon as the probe answered");
			assert.equal(sources[0]!.closed, true, "the broken one was closed");

			await act(async () => {
				sources[1]!.open(); // the new channel's own open (whenever it comes) changes nothing that was already right
			});
			assert.equal(text(), "true");

			const before = probes;
			await wait(SERVER_PROBE_MS * 2);
			assert.equal(probes, before, "it stops probing once reachable");
		} finally {
			act(() => {
				root.unmount();
			});
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete g[key];
			}
		}
	});
});
