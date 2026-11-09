/**
 * THE WEAK-MODEL ARGUMENT HEAL — the pure core (owner, 2026-10-09 —
 * generalize the 2026-10-04 practice heal; see agent/tools/heal.ts for
 * the registry-wide wiring story). Lives in core because BOTH seams need
 * it (the tool-parts law: display parses mirror boundary coercion or a
 * healed-at-boundary call whose record keeps the RAW arguments renders
 * as an invisible pending quiz):
 *
 *   - the agent boundary: pi's prepareArguments seam, BEFORE TypeBox
 *     validation (withArgumentHeal / healToolRecord);
 *   - the display parse: tool-parts' parseQuizInput, before
 *     boundaryParse — the persisted record keeps raw arguments, so the
 *     same wobble heals on read.
 *
 * Born of the GLM incident (owner, 2026-10-04): 19 consecutive rejected
 * `problem` calls, every one carrying `"mode": "\"recall\""` — a
 * JSON-string-encoded enum — while TypeBox's error text `must be equal
 * to constant` never named the expected values, so the model re-emitted
 * the identical payload each time; the 2026-10-09 whitehead session ran
 * the same loop on quiz `type` for ten turns. A STRING value where the
 * schema expects a literal union / boolean / null / number / array is
 * JSON.parse-d and kept when the parsed value satisfies the expectation.
 * Well-formed args pass through UNTOUCHED (same reference); unhealable
 * values stay for validation to reject honestly.
 */

/** One property schema of a TypeBox object (the shapes this fork emits:
 * literal unions carry anyOf[{const}], scalars carry type). */
type PropSchema = {
	type?: string;
	const?: unknown;
	anyOf?: PropSchema[];
};

/** The literal values a property accepts ([] when it is not a literal
 *  union / bare literal). */
function literalsOf(prop: PropSchema): unknown[] {
	if (prop.anyOf) return prop.anyOf.flatMap((m) => literalsOf(m));
	return "const" in prop ? [prop.const] : [];
}

/** Does the property accept null (Type.Null standalone or as a union
 *  member)? */
function acceptsNull(prop: PropSchema): boolean {
	if (prop.type === "null") return true;
	return (prop.anyOf ?? []).some((m) => m.type === "null");
}

/** JSON.parse that never throws (undefined for malformed input). */
function tryParse(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/** A leaked XML parameter boundary inside a string value (2026-10-25, a
 *  Matte 1 placement probe): the model's tool-call text format bled into
 *  the JSON, so `skill` carried `sk_…</parameter>\n<parameter
 *  name="question">La $A=…` and `question` was missing. */
const LEAKED_BOUNDARY = /<\/parameter>\s*<parameter name="([^"]+)">/g;

/** Split leaked boundaries back into their fields — only when every named
 *  field is a schema property, absent from the args, and named once;
 *  anything else stays for validation to reject honestly. */
function healLeakedParameters(args: Record<string, unknown>, properties: Record<string, PropSchema>): Record<string, unknown> {
	let healed: Record<string, unknown> | null = null;
	for (const [key, raw] of Object.entries(args)) {
		if (typeof raw !== "string" || !raw.includes("</parameter>")) continue;
		const parts = raw.split(LEAKED_BOUNDARY); // [value, name, value, name, value, …]
		if (parts.length < 3) continue;
		const fields: [string, string][] = [];
		for (let i = 1; i < parts.length; i += 2) fields.push([parts[i]!, parts[i + 1]!.replace(/\s*<\/parameter>\s*$/, "")]);
		const names = fields.map(([name]) => name);
		const target = healed ?? args;
		const ok = names.every((name, i) => name in properties && !(name in target) && names.indexOf(name) === i);
		if (!ok) continue;
		healed ??= { ...args };
		healed[key] = parts[0];
		for (const [name, value] of fields) healed[name] = value;
	}
	return healed ?? args;
}

/** A leaked JSON boundary inside a string value (2026-11-07, a Matte 1
 *  review): the model's object quoting broke inside `statement`, so the rest
 *  of the call (`","mode":"recall","modelSolution":"…","skills":[…]}`) rode
 *  inside that one string and every other required field was missing. The
 *  validation rejected it and the model had to send the call again. */
const LEAKED_JSON_FIELD = /",\s*"([A-Za-z_]\w*)"\s*:/;

/** LaTeX commands that begin with `n`: a literal backslash-n before one of
 *  these is LaTeX, not a newline. */
const LATEX_N_COMMAND = /\\n(?:eq|e|u|abla|ot|otin|i|less|geq|leq|mid|parallel|prec|subset|sim|cong|exists|ewline)(?![A-Za-z])/;

/** A broken-quoting string carries `\n` as two characters, and often its
 *  LaTeX with every backslash doubled (`\\begin`, `\\\\` for a row break):
 *  halve a doubled row break and a doubled backslash before a letter, and
 *  make the newlines newlines again, except where they start a LaTeX command. */
function unescapeNewlines(text: string): string {
	return text
		.replace(/\\\\\\\\/g, "\\\\")
		.replace(/\\\\(?=[A-Za-z])/g, "\\")
		.split(/(\\n(?:[A-Za-z]+)?)/)
		.map((piece) => (piece.startsWith("\\n") && !LATEX_N_COMMAND.test(piece) ? "\n" + piece.slice(2) : piece))
		.join("");
}

/** Re-split a string whose tail is the rest of the call's JSON object —
 *  only when the tail parses (a missing closing brace is allowed: the real
 *  tails ended at the string's end), every field it names is a schema
 *  property named once, and the fields are either ALL absent from the args
 *  (they are filled in, and the strings unescaped, see above) or ALL already
 *  present (2026-11-09, a Matte 1 lesson: a quiz `lead` ended in
 *  `", "question": "…"` beside a proper `question`, so the learner read the
 *  question twice, as JSON debris). In that duplicate case the tail is cut,
 *  the existing fields win and the head is kept exactly as written (the
 *  display layer repairs its escapes); anything else stays for validation to
 *  reject honestly. */
function healLeakedJsonFields(args: Record<string, unknown>, properties: Record<string, PropSchema>): Record<string, unknown> {
	for (const [key, value] of Object.entries(args)) {
		if (typeof value !== "string") continue;
		const match = LEAKED_JSON_FIELD.exec(value);
		if (!match || !(match[1]! in properties)) continue;
		const head = value.slice(0, match.index);
		const text = "{" + value.slice(match.index + match[0].indexOf('"', 1)).trim();
		const tail = tryParse(text) ?? tryParse(text + "}");
		if (typeof tail !== "object" || tail === null || Array.isArray(tail)) continue;
		const fields = tail as Record<string, unknown>;
		const names = Object.keys(fields);
		if (!names.every((name) => name in properties && name !== key)) continue;
		if (names.every((name) => !(name in args))) {
			const healed: Record<string, unknown> = { ...args, [key]: unescapeNewlines(head) };
			for (const [name, field] of Object.entries(fields)) healed[name] = typeof field === "string" ? unescapeNewlines(field) : field;
			return healed;
		}
		if (names.every((name) => name in args)) return { ...args, [key]: head };
	}
	return args;
}

export function healEncodedArguments(
	args: unknown,
	schema: { properties?: Record<string, PropSchema> },
): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const properties = schema.properties;
	if (!properties) return args;
	args = healLeakedParameters(args as Record<string, unknown>, properties);
	args = healLeakedJsonFields(args as Record<string, unknown>, properties);
	let healed: Record<string, unknown> | null = null;
	for (const [key, prop] of Object.entries(properties)) {
		const raw = (args as Record<string, unknown>)[key];
		if (typeof raw !== "string") continue;
		const parsed = tryParse(raw);
		let fixed: unknown;
		const literals = literalsOf(prop);
		if (literals.length > 0) {
			if (literals.includes(raw)) continue; // already a valid member
			if (literals.includes(parsed)) fixed = parsed;
		}
		// The literal branch does not cover null (Type.Null carries no
		// const) — a union of literals ∪ null must also accept "null".
		if (fixed === undefined && acceptsNull(prop) && parsed === null) fixed = null;
		if (fixed === undefined && prop.type === "boolean" && typeof parsed === "boolean") {
			fixed = parsed;
		}
		if (
			fixed === undefined &&
			(prop.type === "number" || prop.type === "integer") &&
			typeof parsed === "number"
		) {
			fixed = parsed;
		}
		if (fixed === undefined && prop.type === "array" && Array.isArray(parsed)) fixed = parsed;
		if (fixed !== undefined) {
			healed ??= { ...(args as Record<string, unknown>) };
			healed[key] = fixed;
		}
	}
	return healed ?? args;
}
