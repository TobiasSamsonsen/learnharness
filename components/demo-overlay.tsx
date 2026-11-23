"use client";

import { useRef } from "react";
import { XIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { buildDemoSrcDoc } from "@/components/artifacts/demo-card";
import { InteractionLayerOwner, useInteractionLayer } from "./interaction-layers";

/**
 * Demo focus (owner, 2026-11-23): the demo card's fullscreen button. Same
 * session-scoped shell as MermaidOverlay (absolute inside the session area,
 * so the drag bar stays; X and Esc close) but no pan/zoom stage: a demo is
 * a live page, so the iframe fills the body and scrolls on its own (nothing
 * behind it scrolls while the focus is open). The overlay mounts a FRESH
 * iframe, so the demo restarts from its initial state; the inline copy keeps
 * its own state. The caller's invert state carries over.
 */
export function DemoOverlay({
	html,
	title,
	inverted = false,
	onClose,
}: {
	html: string;
	title: string;
	inverted?: boolean;
	onClose: () => void;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const layer = useInteractionLayer({
		kind: "view", enabled: true, rootRef,
		onClose: () => { onClose(); return "closed"; },
	});
	return (
		<InteractionLayerOwner.Provider value={layer.id}>
			<div
				ref={rootRef}
				data-testid="demo-overlay"
				className="pointer-events-auto absolute inset-0 z-40 flex flex-col bg-background/80 p-4 backdrop-blur-sm"
				style={{ zIndex: 100 + layer.order }}
				role="region"
				aria-label="Demo focus"
			>
				<div className="mb-2 flex items-center gap-2">
					<span className="shrink-0 text-sm font-medium">Demo</span>
					<span className="min-w-0 truncate text-xs text-muted-foreground">{title}</span>
					<Hint label="Close" binding="escape" side="left">
						<button
							type="button"
							onClick={onClose}
							aria-label="Close"
							data-testid="demo-overlay-close"
							className="ml-auto rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<XIcon className="size-4" />
						</button>
					</Hint>
				</div>
				<iframe
					title={title}
					// allow-scripts ONLY, exactly like the inline card.
					sandbox="allow-scripts"
					srcDoc={buildDemoSrcDoc(html)}
					className="min-h-0 w-full flex-1 rounded-xl border bg-white"
					style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
					data-testid="demo-overlay-iframe"
				/>
			</div>
		</InteractionLayerOwner.Provider>
	);
}
