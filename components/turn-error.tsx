"use client";

import { turnErrorDisplay } from "@/src/core";

/**
 * The chat banner's text for a failed turn (owner, 2026-11-13). A provider failure used to show as its raw JSON; a
 * recognised cause (out of credit, quota, a rejected key, the provider down, a timeout) reads as a phrase, with the
 * provider's own words one click away. Anything else is shown as before.
 */
export function TurnErrorText({ message }: { message: string }) {
	const { phrase, detail } = turnErrorDisplay(message);
	if (!phrase) return <span>Something went wrong: {message}</span>;
	return (
		<span data-testid="turn-error-text">
			Something went wrong: the model provider reports {phrase}.
			<details className="mt-1 text-xs text-muted-foreground">
				<summary className="cursor-pointer">Details</summary>
				<span className="break-words">{detail}</span>
			</details>
		</span>
	);
}
