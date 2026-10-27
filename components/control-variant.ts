/**
 * The session controls' two looks (owner, 2026-10-25 — the bottom-bar
 * declutter): `pill` is the floating chrome (bordered, shadowed — the
 * course page, the model control); `edge` is the quiet ghost button on the
 * composer shell's bottom edge, where Sources and the language live now.
 */

export type ControlVariant = "pill" | "edge";

export const CONTROL_CLASS: Record<ControlVariant, string> = {
	pill: "lh-touch flex items-center gap-1.5 rounded-full border bg-card/85 px-2.5 py-1 shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted",
	edge: "lh-touch flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
};
