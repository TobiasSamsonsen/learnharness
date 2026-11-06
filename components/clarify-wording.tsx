"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ClarifyLayer, type ClarifyLayerProps } from "@/components/clarify-layer";
import { CALL_ATTRIBUTE } from "@/components/clarify-anchor";
import { cn } from "@/lib/utils";

/**
 * The wording of a question or practice problem as a markable passage (owner design, 2026-11-06): the learner can mark a phrase
 * of the stem or context and ask the tutor what it means, as with the lesson text. The passage carries the message the call sits
 * in and the call itself, so the thread re-finds its line in the dock now and in the answered card later. Options and fields stay
 * outside it: tapping an option must never compete with marking text.
 *
 * In the dock (`dock`) the margin bubbles live beside the wording, in a gutter of this wrapper, because the dock sits outside
 * the transcript the main layer measures. Chat provides the layer's props through ClarifyDockContext; without them (tests, other
 * hosts) the wording is still markable and simply has no bubble.
 */

export const ClarifyDockContext = createContext<ClarifyLayerProps | null>(null);

export function ClarifyWording({ messageId, callId, dock = false, className, children }: {
	/** The native message and the call: without both (an older host) the wording is plain content. */
	messageId: string | undefined;
	callId: string | undefined;
	/** Render the margin bubbles beside the wording (the dock); the transcript's own layer covers answered cards. */
	dock?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const layer = useContext(ClarifyDockContext);
	if (!messageId || !callId) return <div className={className}>{children}</div>;
	const passage = (
		<div className={cn("lh-source-passage", className)} data-source-message-id={messageId} {...{ [CALL_ATTRIBUTE]: callId }}>
			{children}
		</div>
	);
	if (!dock || !layer) return passage;
	// room for the bubbles only while this question has one (a thread, or the line just marked)
	const hasBubble = layer.threads.some((t) => t.anchor.messageId === messageId && t.anchor.callId === callId)
		|| (layer.draft?.anchor.messageId === messageId && layer.draft?.anchor.callId === callId);
	return (
		<div className={cn("relative", hasBubble && "pr-10")}>
			{passage}
			<ClarifyLayer {...layer} />
		</div>
	);
}
