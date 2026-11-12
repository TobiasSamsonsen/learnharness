"use client";

import type { ArtifactPartProps, FigureEntry } from "@/src/core";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";

/**
 * The show_figure card (owner, 2026-11-12 — src/core/figure-show.ts): a
 * finished visual or demo, shown where the tutor brought it in. The view joins
 * the figure onto the part from its hidden delivery marker by job id, so the
 * invert switch writes to that marker and every showing shares it. Nothing
 * renders while the call runs, when it was refused, or when the figure is not
 * in this chat (yet): the learner never sees a figure being made.
 */
export function ShowFigureCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	const figure = part.figure as FigureEntry | undefined;
	if (!figure || !figure.ok) return null;
	const rawCaption = (part.input as { caption?: unknown } | null | undefined)?.caption;
	const caption = typeof rawCaption === "string" && rawCaption.trim() ? rawCaption.trim() : undefined;
	const inverted = figure.ui?.inverted ?? false;
	if (figure.kind === "visual") {
		return <VisualOutputCard output={figure.result} messageId={figure.steerId} initialInverted={inverted} caption={caption} />;
	}
	return (
		<div data-testid="show-figure-demo">
			<DemoOutputCard output={figure.result} messageId={figure.steerId} initialInverted={inverted} />
			{caption && (
				<p className="mt-2 text-sm text-muted-foreground" data-testid="figure-caption">
					{caption}
				</p>
			)}
		</div>
	);
}
