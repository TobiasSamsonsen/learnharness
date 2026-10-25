"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, GraduationCapIcon } from "lucide-react";
import { MAX_BOX, type HeldSkill, type SkillsOverview } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";

/**
 * The home's skills card (owner, 2026-10-25 — "the skills you know in the
 * main view"): floats top-left over the graph (or the minimal home), under
 * the sidebar toggle. Every skill the learner has across all courses —
 * known first, then the ones still being learned. Renders nothing until
 * there is a skill to show (a card with nothing in it is a dead control).
 * Collapsed state is per viewer (localStorage). Freshness rides the same
 * events as the sidebar's course rows.
 */

const COLLAPSED_KEY = "lh-skills-card-collapsed";

function readCollapsed(): boolean {
	try {
		return window.localStorage.getItem(COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}

function writeCollapsed(collapsed: boolean): void {
	try {
		window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
	} catch {
		// private window / blocked storage: the card just forgets
	}
}

function SkillLine({ skill, muted }: { skill: HeldSkill; muted?: boolean }) {
	return (
		<li className="px-1.5 py-1" title={skill.statement} data-testid={`held-skill-${skill.id}`}>
			<div className={muted ? "truncate text-xs text-muted-foreground" : "truncate text-xs text-foreground"}>{skill.name}</div>
			<div className="truncate text-[11px] text-muted-foreground/80">
				box {skill.box}/{MAX_BOX}
				{skill.due ? " · due" : ""}
				{skill.courses.length > 0 ? ` · ${skill.courses.join(", ")}` : ""}
			</div>
		</li>
	);
}

/** The card's body — a pure function of the payload (render tests). */
export function SkillsCardBody({
	data,
	collapsed,
	onToggle,
}: {
	data: SkillsOverview;
	collapsed: boolean;
	onToggle: () => void;
}) {
	if (data.known.length === 0 && data.learning.length === 0) return null;
	return (
		<div data-testid="skills-card" className="w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-card/85 p-1.5 shadow-lg backdrop-blur">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={!collapsed}
				data-testid="skills-card-toggle"
				className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent"
			>
				{collapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
				<GraduationCapIcon className="size-3.5" />
				<span className="flex-1 text-foreground">Skills you know · {data.known.length}</span>
				{data.learning.length > 0 && <span>{data.learning.length} learning</span>}
			</button>
			{!collapsed && (
				<div className="max-h-[50vh] overflow-y-auto">
					{data.known.length > 0 && <ul>{data.known.map((s) => <SkillLine key={s.id} skill={s} />)}</ul>}
					{data.learning.length > 0 && (
						<>
							<div className="px-1.5 pb-0.5 pt-2 text-[10px] uppercase tracking-widest text-muted-foreground/70">Learning</div>
							<ul>{data.learning.map((s) => <SkillLine key={s.id} skill={s} muted />)}</ul>
						</>
					)}
				</div>
			)}
		</div>
	);
}

export function SkillsCard() {
	const [data, setData] = useState<SkillsOverview | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	useEffect(() => setCollapsed(readCollapsed()), []);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/skills", { cache: "no-store" });
			if (res.ok) setData((await res.json()) as SkillsOverview);
		} catch {
			// offline / server restarting: keep what we have
		}
	}, []);
	useEffect(() => void refresh(), [refresh]);

	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refresh();
		}, 250);
	};
	useServerEvent("courses-changed", schedule);
	useServerEvent("turn-settled", schedule);
	useServerEvent("chats-changed", schedule);
	useServerResync(() => void refresh());
	useEffect(() => () => debounceRef.current && clearTimeout(debounceRef.current), []);

	if (!data) return null;
	return (
		<SkillsCardBody
			data={data}
			collapsed={collapsed}
			onToggle={() =>
				setCollapsed((c) => {
					writeCollapsed(!c);
					return !c;
				})
			}
		/>
	);
}
