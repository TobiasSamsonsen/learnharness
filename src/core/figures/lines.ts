/**
 * The line format every figure family shares (figures phase 1). PURE.
 * One statement per line, `#` starts a comment (outside quotes), a
 * trailing `"…"` is the statement's label, and errors carry the line.
 */

import { ExprError } from "./expr.ts";

/** A figure error the author (the model) reads: the line it is on, the
 *  problem, and — when the parser knows — what the line should look like. */
export class FigureError extends Error {
	constructor(
		readonly line: number,
		message: string,
	) {
		super(message);
	}
}

export interface Statement {
	line: number;
	/** The statement without its comment and label. */
	text: string;
	label?: string;
}

/** Split a figure source into statements (blank and comment-only lines
 *  dropped). A label is the LAST quoted string on the line. */
export function statements(source: string): Statement[] {
	const out: Statement[] = [];
	source.split(/\r?\n/).forEach((raw, i) => {
		let text = "";
		let inQuote = false;
		for (const c of raw) {
			if (c === '"') inQuote = !inQuote;
			if (c === "#" && !inQuote) break;
			text += c;
		}
		if (inQuote) throw new FigureError(i + 1, "a label is missing its closing quote");
		let label: string | undefined;
		const m = /"([^"]*)"\s*$/.exec(text);
		if (m) {
			label = m[1];
			text = text.slice(0, m.index);
		}
		if (text.includes('"')) throw new FigureError(i + 1, "a label goes at the end of its line");
		text = text.trim();
		if (text) out.push({ line: i + 1, text, ...(label !== undefined ? { label } : {}) });
	});
	return out;
}

/** Split on commas outside parentheses and brackets. */
export function splitTopLevel(text: string, sep = ","): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	for (const c of text) {
		if (c === "(" || c === "[") depth++;
		if (c === ")" || c === "]") depth--;
		if (c === sep && depth === 0) {
			parts.push(cur.trim());
			cur = "";
		} else cur += c;
	}
	parts.push(cur.trim());
	return parts;
}

/** `a..b` with numeric ends. */
export function parseRange(text: string, line: number, what: string): [number, number] {
	const m = /^\s*(-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*\.\.\s*(-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*$/.exec(text);
	if (!m) throw new FigureError(line, `${what} must be a range like 0..10`);
	const a = Number(m[1]);
	const b = Number(m[2]);
	if (!(b > a)) throw new FigureError(line, `${what} must run from a smaller to a larger number`);
	return [a, b];
}

/** `[lo, hi]` as two expression sources. */
export function parseInterval(text: string, line: number, what: string): [string, string] {
	const m = /^\s*\[(.+)\]\s*$/.exec(text);
	const parts = m ? splitTopLevel(m[1]!) : [];
	if (parts.length !== 2 || !parts[0] || !parts[1]) throw new FigureError(line, `${what} must be an interval like [-1, 1]`);
	return [parts[0], parts[1]];
}

/** Run a parse step, turning expression errors into line errors. */
export function onLine<T>(line: number, fn: () => T, context?: string): T {
	try {
		return fn();
	} catch (err) {
		if (err instanceof FigureError) throw err;
		if (err instanceof ExprError) throw new FigureError(line, `${context ? `${context}: ` : ""}${err.message}`);
		throw err;
	}
}

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
