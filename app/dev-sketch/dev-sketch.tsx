"use client";

import { useSyncExternalStore } from "react";
import { SketchView } from "@/components/sketch/sketch-view";

const noSubscribe = () => () => {};

/** The harness's view. Client only: on its first render the sketch view reads the Android bridge and the stored ink, which the
 *  server cannot know, so rendering it on the server produced a hydration mismatch (the dev overlay's "1 Issue"). */
export function DevSketch() {
	const client = useSyncExternalStore(noSubscribe, () => true, () => false);
	if (!client) return null;
	// the real docks close the view; here X goes home so the button can be tried
	return <SketchView label="Problem" statement="Draw a right triangle and label the sides." inkKey="dev-sketch" onSubmit={async () => true} onClose={() => (window.location.href = "/")} />;
}
