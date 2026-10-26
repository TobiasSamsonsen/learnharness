"use client"

import * as React from "react"
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import {
	LONG_PRESS_IDLE,
	LONG_PRESS_MS,
	LONG_PRESS_SHOW_MS,
	longPress,
	ownsContextMenu,
	swallowsClick,
	type LongPress,
	type LongPressEvent,
} from "@/components/ui/long-press"
import { bindingForAction, formatBinding, type KeyAction } from "@/src/core"

/**
 * The tooltip composition for icon and pill controls (tooltip wave, owner
 * 2026-09-25; subtlety round same day). The styled Radix tooltip carries
 * the label, with the control's shortcut appended in parentheses when
 * it has one ("Dictate (⌘D)") — the owner call: the em-dash suffix read
 * as too much air.
 *
 * The binding is override-aware: pass `action` for registry shortcuts (a
 * user rebind in Settings → Keyboard changes the suffix live), or
 * `binding` for surface-owned keys with no registry entry ("escape" for a
 * dialog close, "enter" for a form submit).
 *
 * children must be a single element able to take a ref (TooltipTrigger
 * asChild merges onto it — no wrapper DOM, no layout shift).
 *
 * TOUCH (M5, owner): Radix never opens a tooltip on touch, so a touch
 * LONG-PRESS (components/ui/long-press.ts) shows the same chip for a couple
 * of seconds; the release does not activate the control, and a plain tap
 * still just activates. Mouse and keyboard paths are Radix's, untouched.
 */

interface HintProps {
	label: string
	/** Registry action whose LIVE binding is shown (override-aware). */
	action?: KeyAction
	/** Surface-owned binding ("escape", "enter") — keys the registry
	 *  deliberately doesn't dispatch (Esc closes the dialog itself; Enter
	 *  submits the form the button belongs to). */
	binding?: string
	side?: "top" | "bottom" | "left" | "right"
	children: React.ReactElement
}

/** The composition itself, pure — "Dictate" + ⌘D → "Dictate (⌘D)". Exported
 *  for the mechanism pins (tests/tooltip-mechanism.test.tsx). */
export function hintText(label: string, action?: KeyAction, binding?: string): string {
	const live = action
		? formatBinding(bindingForAction(action))
		: binding
			? formatBinding(binding)
			: ""
	return live ? `${label} (${live})` : label
}

export function Hint({ label, action, binding, side = "top", children }: HintProps) {
	// Always controlled, so Radix never flips between modes: hover and focus
	// arrive through onOpenChange, a touch long-press through `press` below.
	const [open, setOpen] = React.useState(false)
	const press = React.useRef<LongPress>(LONG_PRESS_IDLE)
	const holdTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const showTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	React.useEffect(
		() => () => {
			clearTimeout(holdTimer.current)
			clearTimeout(showTimer.current)
		},
		[],
	)

	const send = (ev: LongPressEvent) => {
		press.current = longPress(press.current, ev)
	}
	const onPointerDown = (e: React.PointerEvent) => {
		clearTimeout(holdTimer.current)
		clearTimeout(showTimer.current)
		send({ type: "down", x: e.clientX, y: e.clientY, pointerType: e.pointerType })
		if (press.current.phase !== "armed") return
		holdTimer.current = setTimeout(() => {
			send({ type: "fire" })
			if (press.current.phase !== "shown") return
			setOpen(true)
			showTimer.current = setTimeout(() => {
				send({ type: "hide" })
				setOpen(false)
			}, LONG_PRESS_SHOW_MS)
		}, LONG_PRESS_MS)
	}
	const endHold = (type: "up" | "cancel") => () => {
		send({ type })
		if (press.current.phase === "idle") clearTimeout(holdTimer.current)
	}

	return (
		<TooltipProvider>
			<Tooltip
				open={open}
				onOpenChange={(next) => {
					// Radix closes on pointerleave, which a touch fires right after
					// the release — the long-press label has its own timer.
					if (!next && press.current.phase === "shown") return
					setOpen(next)
				}}
			>
				<TooltipTrigger
					asChild
					onPointerDown={onPointerDown}
					onPointerMove={(e: React.PointerEvent) => {
						send({ type: "move", x: e.clientX, y: e.clientY })
						if (press.current.phase === "idle") clearTimeout(holdTimer.current)
					}}
					onPointerUp={endHold("up")}
					onPointerCancel={endHold("cancel")}
					onClickCapture={(e: React.MouseEvent) => {
						if (!swallowsClick(press.current)) return
						e.preventDefault()
						e.stopPropagation()
						send({ type: "click" })
					}}
					onContextMenu={(e: React.MouseEvent) => {
						// Android fires contextmenu on a long-press at about our hold
						// time (a link preview on <a>); the hold is ours, not the menu's.
						if (ownsContextMenu(press.current)) e.preventDefault()
					}}
				>
					{children}
				</TooltipTrigger>
				<TooltipContent side={side}>{hintText(label, action, binding)}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	)
}
