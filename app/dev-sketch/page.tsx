"use client";

// TEMP: phone check of the sketch view (never commit)
import { SketchView } from "@/components/sketch/sketch-view";

export default function DevSketch() {
	// the real docks close the view; here X goes home so the button can be tried
	return <SketchView label="Problem" statement="Draw a right triangle and label the sides." inkKey="dev-sketch" onSubmit={async () => true} onClose={() => (window.location.href = "/")} />;
}
