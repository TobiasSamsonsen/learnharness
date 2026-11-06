import { notFound } from "next/navigation";
import { DevSketch } from "./dev-sketch";

/**
 * A harness for the sketch view on a phone (docs/development.md, "Checking a change on a phone"): the view with a throwaway ink
 * key, so ink can be seeded and the erasers tried without a lesson. Development only: in a production build (the desktop app,
 * the Android bundle) the route is a 404.
 */
export default function DevSketchPage() {
	if (process.env.NODE_ENV === "production") notFound();
	return <DevSketch />;
}
