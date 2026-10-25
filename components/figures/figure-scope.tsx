"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { diagramScope } from "@/src/core";

/**
 * The figure scope (figures phase 1, owner 2026-10-26): the ```blocks
 * diagrams a ```plot may reference by id — those of the same question
 * (stem, options, explanation: the dock and card wrap all their fields)
 * or the same message (MessageResponse wraps its own text). Inner scopes
 * extend outer ones; the nearest definition of an id wins.
 */

const EMPTY: ReadonlyMap<string, string> = new Map();
const FigureScopeContext = createContext<ReadonlyMap<string, string>>(EMPTY);

export function useFigureScope(): ReadonlyMap<string, string> {
	return useContext(FigureScopeContext);
}

export function FigureScope({ texts, children }: { texts: ReadonlyArray<string | undefined>; children: ReactNode }) {
	const parent = useContext(FigureScopeContext);
	const key = texts.join("\u0000");
	const value = useMemo(() => {
		if (!key.includes("```blocks")) return parent;
		const own = diagramScope(texts.filter((t): t is string => typeof t === "string"));
		return own.size === 0 ? parent : new Map([...parent, ...own]);
		// texts is keyed by its joined content
	}, [parent, key]);
	return <FigureScopeContext.Provider value={value}>{children}</FigureScopeContext.Provider>;
}
