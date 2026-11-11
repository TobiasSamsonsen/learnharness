import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createInteractionLayers, type CloseOutcome, type CloseReason, type InteractionLayer } from "../components/interaction-layers.tsx";

/**
 * The Android hardware back (fork): the shell dispatches `lh:back` and the shared layers answer it — the topmost
 * ELIGIBLE layer is asked to close with reason "back", and the answer says whether the shell has more to do
 * (false: nothing was open, so it goes back in history, then exits). Replaces the fork's own back stack
 * (components/back-layers.ts, retired when the dialogs moved onto the shared layers).
 */
function fixture() {
	const { document } = parseHTML("<html><body></body></html>");
	const store = createInteractionLayers();
	const reasons: string[] = [];
	function add(id: string, kind: InteractionLayer["kind"], ownerId?: string, onClose?: (reason: CloseReason) => CloseOutcome | void) {
		const root = document.createElement("div");
		document.body.appendChild(root);
		const unregister = store.register({
			id, kind, ownerId, rootRef: { current: root },
			onClose: onClose && ((reason) => { reasons.push(`${id}:${reason}`); return onClose(reason); }),
		});
		return { unregister };
	}
	return { store, add, reasons };
}

describe("dispatchBack — the Android back through the shared layers", () => {
	it("is false when no layer is open, so the shell goes on to history and exit", () => {
		const { store } = fixture();
		assert.equal(store.dispatchBack(), false);
	});

	it("closes the topmost layer with the reason \"back\" and says it was consumed", () => {
		const { store, add, reasons } = fixture();
		add("view", "view", undefined, () => "closed");
		const popup = add("menu", "popup", "view", () => { popup.unregister(); return "closed"; });
		assert.equal(store.dispatchBack(), true);
		assert.deepEqual(reasons, ["menu:back"], "the popup above the view goes first, and only it");
		assert.equal(store.dispatchBack(), true);
		assert.deepEqual(reasons, ["menu:back", "view:back"]);
	});

	it("a blocked, pending or step-only top layer still consumes the back, and nothing underneath is closed", () => {
		for (const outcome of ["blocked", "pending", "handled-without-close"] as const) {
			const { store, add, reasons } = fixture();
			add("under", "view", undefined, () => "closed");
			add("busy", "modal", undefined, () => outcome);
			assert.equal(store.dispatchBack(), true, outcome);
			assert.deepEqual(reasons, ["busy:back"], outcome);
		}
	});

	it("a layer with no close handler (nothing can dismiss it) consumes the back too", () => {
		const { store, add, reasons } = fixture();
		add("under", "view", undefined, () => "closed");
		add("fixed", "modal");
		assert.equal(store.dispatchBack(), true);
		assert.deepEqual(reasons, [], "no handler, no close, and the layer under a modal is not reachable");
	});

	it("a modal makes the layers beneath it ineligible, like Escape", () => {
		const { store, add, reasons } = fixture();
		add("page", "view", undefined, () => "closed");
		add("dialog", "modal", undefined, () => "closed");
		assert.equal(store.dispatchBack(), true);
		assert.deepEqual(reasons, ["dialog:back"]);
	});
});
