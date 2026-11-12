"use client";

import type { ComponentProps, ReactNode } from "react";
import type { ExtraProps } from "streamdown";
import { MessageResponse, ToolContentResponse } from "@/components/ai-elements/message";
import { MarkdownDisplayOnlyContext, mdComponents } from "@/components/md-blocks";
import { cn } from "@/lib/utils";
import { repairMathForDisplay } from "@/src/core";

/**
 * Names and statements with their math and Markdown rendered, for the fork's
 * own surfaces (owner, 2026-11-12): the skill card, the course page, the graph
 * context card and the collapsed practice dock. Upstream v0.6.1 does the same
 * in the graph node card (NodeCardText) and the chains view; this is that
 * technique as two components.
 *
 * `.lh-prose` (the renderer's container) sets the chat font and size in
 * unlayered CSS, which beats Tailwind's type utilities. The variable overrides
 * are what keep the host's own type: the UI font here, the size and leading
 * from the caller (`[--lh-prose-size:…]`, `[--lh-prose-leading:…]`). `prose`
 * is for a host that already uses the chat font.
 */
const UI_TYPE =
	"[--font-prose:var(--font-ui)] [&_[data-streamdown=inline-code]]:[font-size:inherit] [&_[data-streamdown=inline-code]]:[color:inherit]";

/** A rendered block: paragraphs, display math, lists and code as the text has them. Never streamed. */
export function RichText({ children, className, prose = false }: { children: string; className?: string; prose?: boolean }) {
	return (
		<ToolContentResponse mode="static" className={cn(!prose && UI_TYPE, className)}>
			{children}
		</ToolContentResponse>
	);
}

/** What RichLine renders: the first line that is not blank, after the display repair (a text with encoded line breaks is
 *  several lines once repaired). Exported for tests. */
export function richLineSource(text: string): string {
	return (
		repairMathForDisplay(text)
			.split(/\r?\n/)
			.find((line) => line.trim() !== "") ?? ""
	);
}

/** A link inside a one-row line is text: the line can sit inside a button (the collapsed practice dock). */
function LineLink({ children }: ComponentProps<"a"> & ExtraProps) {
	return <span className="underline decoration-border underline-offset-2">{children}</span>;
}

// Resolved lazily, as host-markdown.tsx does: the message / md-blocks module graph is cyclic.
let lineComponents: typeof mdComponents & { a: typeof LineLink };
function getLineComponents() {
	return (lineComponents ??= { ...mdComponents, a: LineLink });
}
const LINK_SAFETY_OFF = { enabled: false };

/**
 * One row: the text's first line with its math rendered, clipped at the right edge. Display-only (no copy corners, no
 * link prompts), so nothing interactive is nested where the line sits. The outer box takes the layout classes and the
 * type variables; a value that is not a string passes through as plain text.
 */
export function RichLine({ children, className, prose = false }: { children: unknown; className?: string; prose?: boolean }) {
	if (typeof children !== "string") return <span className={cn("min-w-0 truncate", className)}>{children as ReactNode}</span>;
	return (
		<div className={cn("min-w-0", className)} data-rich-line="">
			<MarkdownDisplayOnlyContext.Provider value={true}>
				<MessageResponse
					mode="static"
					isAnimating={false}
					controls={false}
					linkSafety={LINK_SAFETY_OFF}
					components={getLineComponents()}
					className={cn("overflow-hidden whitespace-nowrap [&_p]:truncate", !prose && UI_TYPE)}
				>
					{richLineSource(children)}
				</MessageResponse>
			</MarkdownDisplayOnlyContext.Provider>
		</div>
	);
}
