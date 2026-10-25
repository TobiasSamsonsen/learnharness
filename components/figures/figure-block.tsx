"use client";

import { useEffect, useRef, useState } from "react";
import { MaximizeIcon } from "lucide-react";
import { useIsCodeFenceIncomplete } from "streamdown";
import { computePlot, FigureError, parseBlocks, parsePlot, type FigureLang } from "@/src/core";
import { MermaidError } from "@/components/mermaid-error";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { chartSize, useSessionMermaid } from "@/components/session-overlay";
import { Hint } from "@/components/ui/hint";
import { renderBlocksSvg } from "@/components/figures/blocks-svg";
import { renderPlotSvg } from "@/components/figures/plot-svg";
import { withInk } from "@/components/figures/figure-label";
import { useFigureScope } from "@/components/figures/figure-scope";

/**
 * A ```blocks / ```plot figure in the message flow (figures phase 1,
 * owner 2026-10-26) — the MermaidInline pattern: a quiet skeleton while
 * the fence streams, the house error card when it does not parse, the
 * hover corner with copy + full-screen. The figure is drawn at the
 * session's text size, so its labels match the prose around it.
 */
export function FigureInline({ lang, source, copy }: { lang: FigureLang; source: string; copy: React.ReactNode }) {
	const incomplete = useIsCodeFenceIncomplete();
	const scope = useFigureScope();
	const overlay = useSessionMermaid();
	const holderRef = useRef<HTMLDivElement>(null);
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (incomplete) return;
		let cancelled = false;
		setSvg(null);
		setError(null);
		const fontPx = Number.parseFloat(getComputedStyle(holderRef.current ?? document.body).fontSize) || 15;
		(async () => {
			try {
				const out = lang === "blocks" ? await renderBlocksSvg(parseBlocks(source), fontPx) : renderPlotSvg(computePlot(parsePlot(source), scope), fontPx);
				if (!cancelled) setSvg(out);
			} catch (err) {
				if (!cancelled) setError(err instanceof FigureError ? `line ${err.line}: ${err.message}` : err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [lang, source, scope, attempt, incomplete]);

	if (error !== null) return <MermaidError chart={source} error={error} retry={() => setAttempt((a) => a + 1)} />;
	return (
		<div ref={holderRef} data-testid="md-figure" data-figure={lang} className="group/md relative my-4" aria-busy={svg === null}>
			{svg === null ? (
				<div className="flex justify-center p-4">
					<span className="inline-block size-4 animate-spin rounded-full border border-current border-b-2 text-muted-foreground" />
				</div>
			) : (
				<>
					{/* shrink to the column, down to 3/4 of natural size; past that, scroll */}
					<div className="mx-auto flex w-full justify-center-safe overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full [&_svg]:min-w-[var(--fig-min)]" style={{ ["--fig-min" as string]: `${Math.round(chartSize(svg).w * 0.75)}px` }} dangerouslySetInnerHTML={{ __html: svg }} />
					<div className="absolute top-0 right-0 flex items-start gap-0.5">
						{copy}
						{overlay && (
							<Hint label="Open full-screen" side="bottom">
								<button
									type="button"
									aria-label="Expand figure"
									data-testid="md-figure-expand"
									className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/md:opacity-100"
									onClick={(e) => {
										blurAfterPointerClick(e);
										overlay.openFigure(withInk(svg), true);
									}}
								>
									<MaximizeIcon className="size-3.5" />
								</button>
							</Hint>
						)}
					</div>
				</>
			)}
		</div>
	);
}
