import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import DevSketchPage from "../app/dev-sketch/page.tsx";

/**
 * /dev-sketch is a phone harness for the sketch view (docs/development.md). It must not be part of a shipped build:
 * in production the route is a 404; in development and tests it renders.
 */

const original = process.env.NODE_ENV;
const setEnv = (value: string) => {
	(process.env as Record<string, string | undefined>).NODE_ENV = value;
};
afterEach(() => setEnv(original ?? "test"));

describe("/dev-sketch is development only", () => {
	it("renders its harness outside production", () => {
		setEnv("development");
		const element = DevSketchPage();
		assert.ok(React.isValidElement(element), "an element, not a 404");
	});

	it("is a 404 in a production build (Next's notFound error, never an element)", () => {
		setEnv("production");
		assert.throws(
			() => DevSketchPage(),
			(error: unknown) => /404/.test(String((error as { digest?: unknown }).digest ?? error)),
		);
	});
});
