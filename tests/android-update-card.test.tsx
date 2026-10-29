/**
 * The update card of the Android app (owner, 2026-10-29): its render and its bridge lines. The shell's side is
 * UpdateWireTest.kt; the lines must stay in step with UpdateWire.kt.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const { AndroidUpdateNotice, ANDROID_RELEASE_NOTES_URL, UPDATE_LINES } = await import("../components/android-update-card.tsx");

describe("the Android update card", () => {
	it("says what is ready, offers Update and Not now, and links the notes", () => {
		const html = renderToStaticMarkup(<AndroidUpdateNotice onNotNow={() => {}} onUpdate={() => {}} />);
		assert.match(html, /A new version of LearnHarness is ready/);
		assert.match(html, /It downloads over Wi-Fi and the app restarts when it is done\./);
		assert.match(html, /data-testid="android-update-start"[^>]*>Update</);
		assert.match(html, /data-testid="android-update-later"[^>]*>Not now</);
		assert.match(html, new RegExp(`href="${ANDROID_RELEASE_NOTES_URL.replace(/[.*+?^${}()|[\]\/]/g, "\$&")}"`));
	});

	it("uses the very lines UpdateWire.kt parses and answers", () => {
		assert.deepEqual(UPDATE_LINES, { probe: "update probe", available: "update available", start: "update start", later: "update later" });
	});
});
