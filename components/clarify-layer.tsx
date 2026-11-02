"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquareIcon, SendIcon, XIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import type { AskMark } from "@/components/ask-selection";
import { findAnchorRange, passagesOf, spreadBubbles } from "@/components/clarify-anchor";
import { enterSends } from "@/components/enter-submits";
import { DRAFT_KEY, type ClarifyTarget, type ClarifyThreads } from "@/components/use-clarify-threads";
import { CLARIFY_QUESTION_MAX, type ClarifyThread } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The margin threads (owner design, 2026-11-02): a small bubble in the transcript's right gutter beside the line the learner
 * marked, which opens a floating card with the quoted text, the tutor's answers and a field for follow-ups. The bubbles
 * stay on their lines for good (the threads ride the record). Render this INSIDE the transcript's find root: it positions
 * its bubbles against the passages that root holds, and re-finds each line by its anchor (clarify-anchor.ts) whenever the
 * text or the layout changes — a Range is never kept, because the text re-renders.
 *
 * The card is `position: fixed` in a portal (the transcript clips and scrolls its own content), clamped to the viewport and
 * kept above the quiz dock, so it never covers the question being answered.
 */

/** A bubble is 24px in a 44px touch area; neighbouring lines closer than this are pushed apart. */
const BUBBLE_GAP = 36;
const CARD_WIDTH = 416;
const CARD_MAX_HEIGHT = 460;
const CARD_MIN_HEIGHT = 220;

interface CardPlace {
	left: number;
	top: number;
	width: number;
	maxHeight: number;
}

/** Where a card goes: left of its bubble (over the text), inside the viewport and the scroller, above the dock. A bubble
 *  scrolled out of view, or hidden behind the dock by the keyboard, pins the card to the nearest edge of that area: the card
 *  never disappears under the learner (the learner closes it). Pure for tests. */
export function placeCard(
	bubble: { left: number; top: number; bottom: number },
	view: { width: number; height: number },
	limits: { minTop: number; dockTop: number | null },
): CardPlace {
	const minTop = limits.minTop + 8;
	// above the dock when there is room for a card there; with the keyboard up the dock sits high and the room is gone, so the
	// card then only keeps clear of the keyboard (the bottom of the viewport)
	const viewBottom = view.height - 8;
	const dockRoom = limits.dockTop !== null && limits.dockTop - 8 - minTop >= CARD_MIN_HEIGHT;
	const limitBottom = dockRoom ? Math.min(viewBottom, limits.dockTop! - 8) : viewBottom;
	const width = Math.min(CARD_WIDTH, view.width - 16);
	const left = Math.max(8, bubble.left - width - 8);
	const top = Math.max(minTop, Math.min(bubble.top - 8, limitBottom - CARD_MIN_HEIGHT));
	return { left, top, width, maxHeight: Math.max(120, Math.min(CARD_MAX_HEIGHT, limitBottom - top)) };
}

export interface ClarifyLayerProps {
	threads: readonly ClarifyThread[];
	busyKey: ClarifyThreads["busyKey"];
	error: ClarifyThreads["error"];
	ask: ClarifyThreads["ask"];
	/** Text just marked and not asked about yet: it gets a bubble and an open card with the field focused. */
	draft: AskMark | null;
	/** The draft is over (its first question went out, or the learner closed the card). */
	onDraftDone: () => void;
}

export function ClarifyLayer({ threads, busyKey, error, ask, draft, onDraftDone }: ClarifyLayerProps) {
	const layerRef = useRef<HTMLDivElement>(null);
	const bubbleEls = useRef(new Map<string, HTMLElement>());
	const cardRef = useRef<HTMLDivElement>(null);
	const [tops, setTops] = useState<Record<string, number>>({});
	const [openKey, setOpenKey] = useState<string | null>(null);
	const [place, setPlace] = useState<CardPlace | null>(null);

	// A freshly marked passage opens its card; clearing the draft closes it.
	useEffect(() => {
		if (draft) setOpenKey(DRAFT_KEY);
		else setOpenKey((k) => (k === DRAFT_KEY ? null : k));
	}, [draft]);

	// ── bubble positions: re-find every anchor against the live text ──
	const measure = useCallback(() => {
		const layer = layerRef.current;
		const root = layer?.parentElement;
		if (!layer || !root) return;
		const items = [
			...threads.map((t) => ({ key: t.id, anchor: t.anchor })),
			...(draft ? [{ key: DRAFT_KEY, anchor: draft.anchor }] : []),
		];
		const layerTop = layer.getBoundingClientRect().top;
		const found: { key: string; top: number }[] = [];
		for (const item of items) {
			const range = findAnchorRange(root, item.anchor);
			const line = range ? (range.getClientRects?.()[0] ?? range.getBoundingClientRect?.()) : undefined;
			if (line && (line.width > 0 || line.height > 0)) {
				// centred on the first line of the marked text
				found.push({ key: item.key, top: line.top - layerTop + line.height / 2 - 12 });
				continue;
			}
			// the text is gone from the page: the bubble keeps to the top of its message
			const passage = passagesOf(root, item.anchor.messageId)[0];
			if (passage) found.push({ key: item.key, top: passage.getBoundingClientRect().top - layerTop + 4 });
		}
		const placed = spreadBubbles(found.map((f) => f.top), BUBBLE_GAP);
		const next: Record<string, number> = {};
		found.forEach((f, i) => {
			next[f.key] = Math.round(placed[i]!);
		});
		setTops((prev) => {
			const a = Object.keys(prev);
			return a.length === Object.keys(next).length && a.every((k) => prev[k] === next[k]) ? prev : next;
		});
	}, [threads, draft]);

	useLayoutEffect(() => {
		measure();
	}, [measure]);

	useEffect(() => {
		const layer = layerRef.current;
		const root = layer?.parentElement;
		if (!layer || !root || (threads.length === 0 && !draft)) return;
		let frame = 0;
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measure);
		};
		// text streaming in, KaTeX settling, images and a resize all move lines; our own bubbles do not count
		const mutations = new MutationObserver((records) => {
			if (records.some((r) => !layer.contains(r.target))) schedule();
		});
		mutations.observe(root, { childList: true, subtree: true, characterData: true });
		const resize = new ResizeObserver(schedule);
		resize.observe(root);
		window.addEventListener("resize", schedule);
		return () => {
			cancelAnimationFrame(frame);
			mutations.disconnect();
			resize.disconnect();
			window.removeEventListener("resize", schedule);
		};
	}, [measure, threads.length, draft]);

	// ── the card: placed against its bubble, above the dock ──
	const placeNow = useCallback(() => {
		const el = openKey ? bubbleEls.current.get(openKey) : undefined;
		if (!el) return setPlace(null);
		const r = el.getBoundingClientRect();
		const scroller = layerRef.current?.closest('[role="log"]');
		const dock = document.querySelector("[data-dock-block]");
		const next = placeCard(
			{ left: r.left, top: r.top, bottom: r.bottom },
			// the keyboard shrinks the visual viewport; the card must stay above it
			{ width: window.innerWidth, height: Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight) },
			{ minTop: scroller?.getBoundingClientRect().top ?? 0, dockTop: dock ? dock.getBoundingClientRect().top : null },
		);
		setPlace((prev) => (prev && next && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.maxHeight === next.maxHeight ? prev : next));
	}, [openKey]);

	useLayoutEffect(() => {
		placeNow();
	}, [placeNow, tops]);

	// While a card is open it is re-placed every frame: the scroller, the on-screen keyboard (the Android shell resizes the web view for
	// it, and its resize events arrive late and unevenly) and the dock's height all move the limits, and a card under the keyboard
	// takes its field's focus with it. Three rect reads per frame; nothing re-renders unless the place changed.
	useEffect(() => {
		if (!openKey) return;
		let frame = 0;
		const tick = () => {
			placeNow();
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [openKey, placeNow]);

	// read through a ref: a state updater must not call the parent's setter
	const openRef = useRef(openKey);
	openRef.current = openKey;
	const close = useCallback(() => {
		if (openRef.current === DRAFT_KEY) onDraftDone();
		setOpenKey(null);
	}, [onDraftDone]);

	// a tap outside the card and its bubble closes it
	useEffect(() => {
		if (!openKey) return;
		const onDown = (e: PointerEvent) => {
			const target = e.target as Element | null;
			if (target?.closest("[data-clarify-card], [data-clarify-bubble], [data-testid='ask-selection-button']")) return;
			close();
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [openKey, close]);

	const open = openKey === DRAFT_KEY ? null : (threads.find((t) => t.id === openKey) ?? null);
	const keys = [...threads.map((t) => t.id), ...(draft ? [DRAFT_KEY] : [])];

	return (
		<>
			<div ref={layerRef} data-session-find-exclude="" data-testid="clarify-layer" className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 select-none">
				{keys.map((key) => {
					const top = tops[key];
					if (top === undefined) return null;
					const thread = threads.find((t) => t.id === key);
					const count = thread?.entries.length ?? 0;
					return (
						<button
							key={key}
							type="button"
							ref={(el) => {
								if (el) bubbleEls.current.set(key, el);
								else bubbleEls.current.delete(key);
							}}
							data-clarify-bubble=""
							data-testid="clarify-bubble"
							aria-label={thread ? `Questions about “${thread.anchor.text}”` : "New question about the marked text"}
							aria-expanded={openKey === key}
							onClick={() => (openKey === key ? close() : setOpenKey(key))}
							style={{ top: top - 10 }}
							className="pointer-events-auto absolute right-0.5 flex size-11 items-center justify-center"
						>
							<span
								className={cn(
									"flex size-6 items-center justify-center rounded-full border text-[11px] font-medium shadow-sm transition-colors",
									openKey === key ? "border-primary bg-primary text-primary-foreground" : "border-border bg-popover text-popover-foreground hover:bg-accent",
									!thread && "border-dashed",
								)}
							>
								{count > 1 ? count : <MessageSquareIcon className="size-3.5" aria-hidden />}
							</span>
						</button>
					);
				})}
			</div>
			{openKey && place && typeof document !== "undefined"
				? createPortal(
						<ClarifyCard
							key={openKey}
							cardRef={cardRef}
							place={place}
							quote={open?.quote ?? draft?.quote ?? ""}
							entries={open?.entries ?? []}
							isDraft={openKey === DRAFT_KEY}
							busy={busyKey === openKey}
							error={error && error.key === openKey ? error.message : null}
							onClose={close}
							onSend={async (question) => {
								const target: ClarifyTarget = openKey === DRAFT_KEY && draft ? { anchor: draft.anchor, quote: draft.quote } : { threadId: openKey };
								const thread = await ask(target, question);
								if (!thread) return false;
								if (openKey === DRAFT_KEY) {
									onDraftDone();
									setOpenKey(thread.id);
								}
								return true;
							}}
						/>,
						document.body,
					)
				: null}
		</>
	);
}

function ClarifyCard({
	cardRef,
	place,
	quote,
	entries,
	isDraft,
	busy,
	error,
	onClose,
	onSend,
}: {
	cardRef: React.RefObject<HTMLDivElement | null>;
	place: CardPlace;
	quote: string;
	entries: ClarifyThread["entries"];
	isDraft: boolean;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onSend: (question: string) => Promise<boolean>;
}) {
	const [question, setQuestion] = useState("");
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	// a new thread puts the cursor in the field; reading an old one must not raise the keyboard
	useEffect(() => {
		if (isDraft) fieldRef.current?.focus();
	}, [isDraft]);
	// the newest answer is the one in view
	useEffect(() => {
		listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
	}, [entries.length, busy]);

	const send = async () => {
		const text = question.trim();
		if (!text || busy) return;
		if (await onSend(text)) setQuestion("");
	};

	return (
		<div
			ref={cardRef}
			role="group"
			aria-label="Questions about the marked text"
			data-clarify-card=""
			data-session-find-exclude=""
			data-testid="clarify-card"
			style={{ position: "fixed", left: place.left, top: place.top, width: place.width, maxHeight: place.maxHeight }}
			className="z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-sm text-popover-foreground shadow-xl"
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					onClose();
				}
			}}
		>
			<div className="flex items-start gap-2 border-b border-border/60 px-3 py-2">
				<blockquote className="line-clamp-2 min-w-0 flex-1 border-l-2 border-primary/60 pl-2 text-xs italic text-muted-foreground" data-testid="clarify-quote">
					{quote}
				</blockquote>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close"
					data-testid="clarify-close"
					className="lh-touch shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" aria-hidden />
				</button>
			</div>

			{(entries.length > 0 || busy || error) && (
				<div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2" data-testid="clarify-thread">
					{entries.map((c) => (
						<div key={c.id} className="flex flex-col gap-1">
							<p className="font-medium">{c.question}</p>
							<div className="text-muted-foreground">
								<ToolContentResponse>{c.reply}</ToolContentResponse>
							</div>
						</div>
					))}
					{busy && (
						<p className="text-xs text-muted-foreground" role="status" data-testid="clarify-busy">
							The tutor is answering…
						</p>
					)}
					{error && (
						<p className="text-xs text-destructive" role="alert" data-testid="clarify-error">
							{error}
						</p>
					)}
				</div>
			)}

			<div className="border-t border-border/60 p-2">
				<div className="flex items-end gap-1.5 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
					<textarea
						ref={fieldRef}
						value={question}
						maxLength={CLARIFY_QUESTION_MAX}
						onChange={(e) => setQuestion(e.target.value)}
						onKeyDown={(e) => {
							// the chat's own keyboard shortcuts must not see typing in this field
							e.stopPropagation();
							if (e.key === "Escape") {
								e.preventDefault();
								onClose();
								return;
							}
							if (enterSends(e)) {
								e.preventDefault();
								void send();
							}
						}}
						placeholder={entries.length > 0 ? "Ask a follow-up…" : "Ask about the marked text…"}
						rows={1}
						data-testid="clarify-field"
						className="field-sizing-content lh-input max-h-32 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
					/>
					<button
						type="button"
						onClick={() => void send()}
						disabled={busy || !question.trim()}
						aria-label="Send the question"
						data-testid="clarify-send"
						className="lh-touch m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
					>
						<SendIcon className="size-4" aria-hidden />
					</button>
				</div>
			</div>
		</div>
	);
}
