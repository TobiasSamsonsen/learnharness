import { repairMathForDisplay } from "@/src/core";

/**
 * A one-line plain-text teaser of a question, for the collapsed dock bar and the "Check your understanding" card
 * (owner, 2026-11-10: the card showed `lim_xto0g(x)` and `**which …`, raw LaTeX and markdown). The strip is one line and
 * truncates, so the math is flattened to readable symbols rather than rendered. PURE.
 */

/** LaTeX commands that have a plain symbol. Anything else keeps its bare name (`\lim` → `lim`, `\sin` → `sin`). */
const SYMBOLS: Readonly<Record<string, string>> = {
	to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftrightarrow: "⇔", infty: "∞",
	varepsilon: "ε", epsilon: "ε", delta: "δ", Delta: "Δ", alpha: "α", beta: "β", gamma: "γ", theta: "θ",
	lambda: "λ", mu: "μ", pi: "π", sigma: "σ", Sigma: "Σ", omega: "ω", phi: "φ", varphi: "φ", rho: "ρ", tau: "τ",
	le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", pm: "±", mp: "∓",
	cdot: "·", times: "×", div: "÷", in: "∈", notin: "∉", subset: "⊂", cup: "∪", cap: "∩", forall: "∀", exists: "∃",
	sum: "Σ", prod: "Π", int: "∫", partial: "∂", nabla: "∇", ldots: "…", dots: "…", cdots: "…",
	left: "", right: "", big: "", Big: "", quad: " ", qquad: " ", mathrm: "", mathbf: "", mathbb: "", operatorname: "",
};

export function teaserText(q: string): string {
	return repairMathForDisplay(q)
		.replace(/```[\s\S]*?```/g, " code ") // a fenced block is not a teaser
		.replace(/`([^`]*)`/g, "$1") // inline code
		.replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links
		.replace(/\*\*(.+?)\*\*/g, "$1") // bold (only `**`: `__init__` is a name, not emphasis)
		.replace(/\\\(([\s\S]*?)\\\)/g, "$1") // \(...\) inline math
		.replace(/\\\[([\s\S]*?)\\\]/g, "$1") // \[...\] display math
		.replace(/\$\$?([^$]*)\$\$?/g, "$1") // $...$ and $$...$$ math
		.replace(/\\(?:text|mathrm|mathbf|mathbb|operatorname)\{([^{}]*)\}/g, "$1")
		.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
		.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
		.replace(/\\([a-zA-Z]+)/g, (_, name: string) => SYMBOLS[name] ?? name)
		.replace(/\\[,;:! ]/g, " ")
		.replace(/\^\{([^{}]*)\}/g, "^$1")
		.replace(/_\{([^{}]*)\}/g, "_$1")
		.replace(/[{}]/g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([→←⇒⇔≤≥≠≈])\s*/g, " $1 ") // relations and arrows read better spaced
		.replace(/\s+/g, " ")
		.trim();
}
