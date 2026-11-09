"use client";

import { useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import {
	bandCounts,
	bucketCounts,
	DUE_BUCKET_LABEL,
	DUE_BUCKETS,
	isDue,
	KNOWN_UNDERSTANDING,
	MAX_UNDERSTANDING,
	SKILL_BAND_LABEL,
	SKILL_BANDS,
	SKILL_CHIP_LABEL,
	SKILL_CHIPS,
	understandingColor,
	type CourseSkillView,
	type DueBucket,
	type SkillBand,
	type SkillChip,
	type SkillSelection,
} from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The course page's visual skill layer (owner, 2026-11-09): a color bar per
 * skill, a header strip of how the skills spread over understanding, a
 * timeline of when reviews fall due, and the Sections / By understanding
 * switch. Color is the quick read, never the only one: every bar sits next to
 * the number and the word, every segment carries its label and count. All the
 * cut-points are in core/skill-visual.ts; the ramp is --lh-understanding-N.
 */

const DUE_COLOR = "var(--lh-due)";

/** The clock, re-read each `everyMs` so "due now" and the timeline stay true on a page left open. */
export function useNow(everyMs = 60_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), everyMs);
		return () => clearInterval(id);
	}, [everyMs]);
	return now;
}

/** One skill's understanding as a bar: filled to understanding/10 in the ramp color, a tick at the known line (6),
 *  dimmed with a dashed sky outline when recall has fallen below the review line, a hatched empty track when locked. */
export function UnderstandingBar({ skill, now }: { skill: Pick<CourseSkillView, "understanding" | "learned" | "needsReview" | "reviewAt" | "missing">; now: number }) {
	const color = understandingColor(skill.understanding);
	const due = isDue(skill, now);
	const locked = !skill.learned && skill.missing.length > 0;
	return (
		<span
			role="meter"
			aria-label="Understanding"
			aria-valuemin={0}
			aria-valuemax={MAX_UNDERSTANDING}
			aria-valuenow={skill.understanding}
			data-testid="skill-bar"
			data-due={due ? "true" : undefined}
			className="relative mt-1.5 block h-1.5 w-full rounded-full bg-border/50"
			style={{
				...(due ? { outline: `1px dashed ${DUE_COLOR}`, outlineOffset: 2 } : {}),
				...(locked
					? { backgroundImage: "repeating-linear-gradient(135deg, var(--border) 0 2px, transparent 2px 5px)", backgroundColor: "transparent" }
					: {}),
			}}
		>
			{color && (
				<span
					className="absolute inset-y-0 left-0 block rounded-full"
					style={{ width: `${(skill.understanding / MAX_UNDERSTANDING) * 100}%`, backgroundColor: color, opacity: due ? 0.55 : 1 }}
				/>
			)}
			<span aria-hidden className="absolute -top-0.5 block h-2.5 w-px bg-foreground/60" style={{ left: `${(KNOWN_UNDERSTANDING / MAX_UNDERSTANDING) * 100}%` }} />
		</span>
	);
}

/** The word chip beside a due skill's name: the sky marker never stands without its word. */
export function DueChip() {
	return (
		<span
			data-testid="skill-due-chip"
			className="shrink-0 rounded-sm border px-1.5 text-[11px] uppercase tracking-wider"
			style={{ color: DUE_COLOR, borderColor: DUE_COLOR }}
		>
			due
		</span>
	);
}

/** Representative ramp step of a band, for the strip. */
const BAND_COLOR: Record<SkillBand, string> = {
	new: "var(--border)",
	low: "var(--lh-understanding-2)",
	mid: "var(--lh-understanding-5)",
	known: "var(--lh-understanding-8)",
};

/** How the course's skills spread over the understanding bands: a segmented bar, and under it each band's label and
 *  count as a toggle that filters the flat list. */
export function DistributionStrip({
	skills,
	due,
	active,
	onPick,
}: {
	skills: readonly Pick<CourseSkillView, "learned" | "understanding">[];
	/** Skills due for review now. */
	due: number;
	active: SkillBand | null;
	onPick: (band: SkillBand | null) => void;
}) {
	const counts = bandCounts(skills);
	const total = skills.length;
	return (
		<div data-testid="skill-strip">
			<div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
				{SKILL_BANDS.filter((b) => counts[b] > 0).map((b) => (
					<button
						key={b}
						type="button"
						tabIndex={-1}
						onClick={() => onPick(active === b ? null : b)}
						className={cn("h-full transition-opacity", active && active !== b && "opacity-40")}
						style={{ flexGrow: counts[b], flexBasis: 0, backgroundColor: BAND_COLOR[b] }}
					/>
				))}
			</div>
			<div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
				{SKILL_BANDS.map((b) => (
					<button
						key={b}
						type="button"
						aria-pressed={active === b}
						data-testid={`strip-${b}`}
						disabled={counts[b] === 0}
						onClick={() => onPick(active === b ? null : b)}
						className={cn(
							"lh-touch flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40",
							active === b ? "border-foreground/50 text-foreground" : "border-transparent text-muted-foreground",
						)}
					>
						<span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: BAND_COLOR[b] }} />
						{SKILL_BAND_LABEL[b]} · {counts[b]}
					</button>
				))}
				{due > 0 && (
					<span className="ml-auto flex items-center gap-1.5 px-2 text-xs" style={{ color: DUE_COLOR }} data-testid="strip-due">
						<span aria-hidden className="size-2 rounded-full border border-dashed" style={{ borderColor: DUE_COLOR }} />
						{due} due of {total}
					</span>
				)}
			</div>
		</div>
	);
}

/** When the learned skills come due: Now / Today / This week / Later, each a toggle that filters the flat list. */
export function DueTimeline({
	skills,
	now,
	active,
	onPick,
}: {
	skills: readonly Pick<CourseSkillView, "learned" | "needsReview" | "reviewAt">[];
	now: number;
	active: DueBucket | null;
	onPick: (bucket: DueBucket | null) => void;
}) {
	const counts = bucketCounts(skills, now);
	const max = Math.max(1, ...DUE_BUCKETS.map((b) => counts[b]));
	return (
		<div className="grid grid-cols-4 gap-1.5" data-testid="due-timeline">
			{DUE_BUCKETS.map((b) => (
				<button
					key={b}
					type="button"
					aria-pressed={active === b}
					data-testid={`timeline-${b}`}
					disabled={counts[b] === 0}
					onClick={() => onPick(active === b ? null : b)}
					className={cn(
						"lh-touch rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40",
						active === b ? "border-foreground/50" : "border-border/60",
					)}
				>
					<span className="block text-xs text-muted-foreground">{DUE_BUCKET_LABEL[b]}</span>
					<span className="block text-lg leading-tight" style={b === "now" && counts.now > 0 ? { color: DUE_COLOR } : undefined}>
						{counts[b]}
					</span>
					<span aria-hidden className="mt-1 block h-0.5 rounded-full bg-border/40">
						<span
							className="block h-full rounded-full"
							style={{ width: `${(counts[b] / max) * 100}%`, backgroundColor: b === "now" ? DUE_COLOR : "var(--muted-foreground)" }}
						/>
					</span>
				</button>
			))}
		</div>
	);
}

export type SkillView = "sections" | "understanding";

/** The Sections / By understanding switch, and in the flat view the filter chips and the sort direction. */
export function SkillViewControls({
	view,
	onView,
	selection,
	onSelection,
	weakestFirst,
	onWeakestFirst,
}: {
	view: SkillView;
	onView: (view: SkillView) => void;
	selection: SkillSelection;
	onSelection: (selection: SkillSelection) => void;
	weakestFirst: boolean;
	onWeakestFirst: (weakestFirst: boolean) => void;
}) {
	const seg = (active: boolean) =>
		cn("lh-touch px-3 py-1 text-xs transition-colors", active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground");
	return (
		<div className="space-y-2" data-testid="skill-view-controls">
			<div className="flex flex-wrap items-center gap-2">
				<div role="group" aria-label="Skill view" className="flex overflow-hidden rounded-md border border-border">
					<button type="button" aria-pressed={view === "sections"} data-testid="view-sections" className={seg(view === "sections")} onClick={() => onView("sections")}>
						Sections
					</button>
					<button
						type="button"
						aria-pressed={view === "understanding"}
						data-testid="view-understanding"
						className={cn(seg(view === "understanding"), "border-l border-border")}
						onClick={() => onView("understanding")}
					>
						By understanding
					</button>
				</div>
				{view === "understanding" && (
					<button
						type="button"
						data-testid="sort-direction"
						className="lh-touch flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted"
						onClick={() => onWeakestFirst(!weakestFirst)}
					>
						{weakestFirst ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />}
						{weakestFirst ? "Weakest first" : "Strongest first"}
					</button>
				)}
			</div>
			{view === "understanding" && (
				<div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter skills">
					{SKILL_CHIPS.map((c: SkillChip) => (
						<button
							key={c}
							type="button"
							aria-pressed={selection.chip === c}
							data-testid={`chip-${c}`}
							onClick={() => onSelection({ ...selection, chip: c })}
							className={cn(
								"lh-touch rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-muted",
								selection.chip === c ? "border-foreground/50 text-foreground" : "border-border text-muted-foreground",
							)}
						>
							{SKILL_CHIP_LABEL[c]}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
