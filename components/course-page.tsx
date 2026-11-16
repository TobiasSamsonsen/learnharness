"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, Loader2Icon, LockIcon } from "lucide-react";
import {
	COURSE_MODE_LABEL,
	courseProgressPercent,
	examReadiness,
	knownShare,
	DUE_BUCKET_LABEL,
	isDue,
	KNOWN_UNDERSTANDING,
	lastsLabel,
	matchesSelection,
	MAX_UNDERSTANDING,
	NO_SELECTION,
	placementQuestionTarget,
	retrievability,
	SKILL_BAND_LABEL,
	sortByUnderstanding,
	type CourseMode,
	type CourseSkillView,
	type CourseView,
	type DraftSkill,
	type LessonMaterial,
	type Pace,
	type PlanNodeStatus,
	type SkillSelection,
	type SkillWeightValue,
} from "@/src/core";
import { DistributionStrip, DueChip, DueTimeline, UnderstandingBar, useNow } from "@/components/skill-visuals";
import { CourseSettings } from "@/components/course-settings";
import { LearnPaceDialog } from "@/components/learn-pace-dialog";
import { ExamPlanSection, WeightEditContext, WeightEditor, WeightNote } from "@/components/exam-plan";
import { SkillMap } from "@/components/skill-map";
import { SidebarToggle } from "@/components/sidebar";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { PAGE_HEAD, SECTION_HEAD } from "@/components/section-heads";
import { FitTitleInput } from "@/components/fit-title-input";
import { RichLine, RichText } from "@/components/rich-text";

/**
 * The course page (fork addition, 2026-10-24 — docs/courses.md §6): the
 * curriculum, the planner's draft for review (ask for changes / approve),
 * and once approved the skill map, how much of it is known, and the route
 * — Review / Next up / Learning / Locked / Known — with a button for every
 * session a course can start (2026-10-25: the placement test offered first,
 * finished lessons unlock what builds on them). Everything shown is derived server-side (GET
 * /api/courses/:id); the page refetches on courses-changed and on every
 * turn settle (a concluded practice problem moves understanding).
 */

export type CoursePayload = CourseView & { drafting: boolean; weighing?: boolean };

/** A skill's state word. Pure — exported for render tests. */
export function skillStateLabel(skill: Pick<CourseSkillView, "understanding" | "learned" | "known" | "missing">): string {
	if (skill.known) return `Known · understanding ${skill.understanding}/${MAX_UNDERSTANDING} · lasts ${lastsLabel(skill.understanding)}`;
	if (skill.learned) return `Learned · understanding ${skill.understanding}/${MAX_UNDERSTANDING} · lasts ${lastsLabel(skill.understanding)}`;
	if (skill.missing.length > 0) return "Locked";
	return "Not started";
}

/** The skill map's node look: known, learned and next up white; locked gray. */
function diagramStatus(skill: CourseSkillView): PlanNodeStatus {
	if (skill.known) return "visited";
	return skill.learned || skill.missing.length === 0 ? "current" : "upcoming";
}

/** Has the learner skipped the placement offer for this course? Per-viewer
 *  convenience (localStorage) — the offer also leaves once any session exists. */
function placementSkipKey(courseId: string): string {
	return `lh:placement-skipped:${courseId}`;
}
function readPlacementSkipped(courseId: string): boolean {
	try {
		return window.localStorage.getItem(placementSkipKey(courseId)) === "1";
	} catch {
		return false;
	}
}
function writePlacementSkipped(courseId: string): void {
	try {
		window.localStorage.setItem(placementSkipKey(courseId), "1");
	} catch {
		/* the offer just comes back next visit */
	}
}

/** The first step after approval (owner, 2026-10-25): find the starting
 *  point with the quick placement test, or start from the beginning. */
function PlacementOffer({ total, busy, onTake, onSkip }: { total: number; busy: boolean; onTake: () => void; onSkip: () => void }) {
	const target = placementQuestionTarget(total);
	return (
		<section data-testid="placement-offer" className="rounded-lg border border-border bg-card/60 px-4 py-3">
			<div className="font-prose text-(length:--lh-prose-size) font-medium">Find your starting point</div>
			<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
				A quick multiple-choice test — about {target === 1 ? "one short question" : `${target} short questions`} for {total === 1 ? "1 skill" : `${total} skills`}, hardest
				first. What you already know is credited, so you start at your weak spots instead of the most basic skill.
			</p>
			<div className="mt-2.5 flex flex-wrap items-center gap-2">
				<button type="button" className={cn(BTN, "border-foreground/40 text-foreground")} disabled={busy} data-testid="placement-take" onClick={onTake}>
					Take the placement test
				</button>
				<button type="button" className={BTN} disabled={busy} data-testid="placement-skip" onClick={onSkip}>
					Start from the beginning
				</button>
			</div>
		</section>
	);
}

function dueLine(skill: CourseSkillView, now = Date.now()): string | null {
	if (!skill.learned || !skill.reviewAt) return null;
	const ms = Date.parse(skill.reviewAt) - now;
	if (ms <= 0) return "due now";
	const days = Math.ceil(ms / 86_400_000);
	return days === 1 ? "due tomorrow" : `due in ${days} days`;
}

/** The due figure of the opened skill: "now", "tomorrow", "3 d", or a dash before it is learned. Pure. */
export function dueShort(skill: Pick<CourseSkillView, "learned" | "reviewAt">, now = Date.now()): string {
	if (!skill.learned || !skill.reviewAt) return "—";
	const ms = Date.parse(skill.reviewAt) - now;
	if (ms <= 0) return "now";
	const days = Math.ceil(ms / 86_400_000);
	return days === 1 ? "tomorrow" : `${days} d`;
}

/** One figure of the opened skill: a number, a one-word label and, for recall, a small meter with the 90% review line. */
function Figure({ value, label, testid, accent, meter }: { value: string; label: string; testid?: string; accent?: boolean; meter?: number | null }) {
	return (
		<div data-testid={testid} className="min-w-0">
			<div className="font-mono text-lg leading-none" style={accent ? { color: "var(--lh-due)" } : undefined}>
				{value}
			</div>
			<div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
			{meter !== undefined && meter !== null && (
				<span role="meter" aria-label="Recall" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter} className="relative mt-1.5 block h-1 rounded-full bg-border/50">
					<span className="block h-full rounded-full" style={{ width: `${meter}%`, backgroundColor: meter < 90 ? "var(--lh-due)" : "var(--lh-understanding-8)" }} />
					<span aria-hidden className="absolute -top-0.5 block h-2 w-px bg-foreground/60" style={{ left: "90%" }} />
				</span>
			)}
		</div>
	);
}

/** A prerequisite as a chip: a check when it is learned, a lock when it is not. The icon says it, not only the colour. */
function PrereqChip({ name, learned }: { name: string; learned: boolean }) {
	return (
		<span data-testid="prereq-chip" data-learned={learned ? "true" : "false"} className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[11px]">
			{learned ? <CheckIcon role="img" aria-label="learned" className="size-3" /> : <LockIcon role="img" aria-label="not learned yet" className="size-3 text-muted-foreground" />}
			{name}
		</span>
	);
}

const BTN =
	"rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
/** A closed group's summary: a chevron instead of the browser's marker, the whole line a target. */
const DETAILS_HEAD = "lh-touch flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden";
/** The page's small type for a rendered name or statement: text-xs, relaxed leading (see rich-text.tsx). */
const ITEM_TYPE = "[--lh-prose-size:var(--text-xs)] [--lh-prose-leading:1.625]";

/**
 * The "Choose skills" practice mode (owner, 2026-11-14): while `choosing`, a tap on a skill row ticks it instead of
 * opening it, and the rows that can be practiced (learned or next-up, not locked) can be ticked.
 */
const SkillListContext = createContext<{
	/** The learned skills' ids: a prerequisite chip shows a check for them and a lock for the rest. */
	learned: ReadonlySet<string>;
	choosing: boolean;
	chosen: ReadonlySet<string>;
	canChoose: (skillId: string) => boolean;
	toggle: (skillId: string) => void;
} | null>(null);

/**
 * One skill, one quiet line (owner, 2026-11-14): its name, a thin understanding bar and a dot when it is due. A tap opens
 * the detail: the state line, the Learn / Practice / Quick check buttons, the exam weight and everything below.
 */
function SkillRow({
	skill,
	names,
	now,
	actions,
}: {
	skill: CourseSkillView;
	names: ReadonlyMap<string, string>;
	now: number;
	actions?: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [more, setMore] = useState(false);
	const choose = useContext(SkillListContext);
	const choosing = choose?.choosing === true;
	const can = choose?.canChoose(skill.id) === true;
	const checked = choose?.chosen.has(skill.id) === true;
	const due = dueLine(skill, now);
	const recall =
		skill.stability !== null && skill.lastReview !== null
			? Math.round(retrievability({ stability: skill.stability, lastReview: Date.parse(skill.lastReview) }, now) * 100)
			: null;
	return (
		<div className="break-inside-avoid border-b border-border/40" data-testid={`skill-${skill.id}`}>
			<button
				type="button"
				onClick={choosing ? () => (can ? choose?.toggle(skill.id) : undefined) : () => setOpen((o) => !o)}
				{...(choosing
					? { role: "checkbox", "aria-checked": checked, "aria-disabled": !can, "aria-label": `Choose ${skill.name}` }
					: { "aria-expanded": open, "aria-label": open ? `Collapse ${skill.name}` : `Expand ${skill.name}` })}
				className={cn("lh-touch flex w-full items-center gap-2 py-2 text-left", choosing && !can && "opacity-50")}
			>
				{choosing ? (
					<span aria-hidden data-testid={`choose-box-${skill.id}`} className={cn("flex size-4 shrink-0 items-center justify-center rounded border", checked ? "border-foreground bg-foreground text-background" : "border-border")}>
						{checked && <CheckIcon className="size-3" />}
					</span>
				) : open ? (
					<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<span className="min-w-0 flex-1 truncate">
					<RichLine prose>{skill.name}</RichLine>
				</span>
				{isDue(skill, now) && <DueChip />}
				<span className="w-24 shrink-0">
					<UnderstandingBar skill={skill} now={now} className="mt-0" />
				</span>
			</button>
			{open && !choosing && (
				<div className="space-y-3 pb-3 pl-5 text-xs" data-testid={`skill-detail-${skill.id}`}>
					{actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
					{skill.learned ? (
						<div
							className="grid grid-cols-3 gap-3"
							role="group"
							aria-label={`${skillStateLabel(skill)}${due ? ` · ${due}` : ""}`}
							data-testid={`skill-figures-${skill.id}`}
						>
							<Figure value={`${skill.understanding}/${MAX_UNDERSTANDING}`} label="understanding" />
							<Figure value={recall === null ? "—" : `${recall}%`} label="recall" meter={recall} testid={`skill-recall-${skill.id}`} />
							<Figure value={dueShort(skill, now)} label="due" accent={isDue(skill, now)} />
						</div>
					) : (
						<p className="text-muted-foreground" data-testid={`skill-state-${skill.id}`}>
							{skill.missing.length > 0 ? "Locked" : "Not started"}
						</p>
					)}
					{skill.requires.length > 0 && (
						<div className="flex flex-wrap items-center gap-1.5" data-testid={`skill-needs-${skill.id}`}>
							<span className="text-muted-foreground">needs</span>
							{skill.requires.map((id) => (
								<PrereqChip key={id} name={names.get(id) ?? id} learned={choose?.learned.has(id) === true} />
							))}
						</div>
					)}
					<WeightEditor skill={skill} />
					<div className="max-h-[2.6rem] overflow-hidden [&_p]:line-clamp-2" data-testid={`skill-statement-${skill.id}`}>
						<RichText className={cn(ITEM_TYPE, "text-muted-foreground")}>{skill.statement}</RichText>
					</div>
					<button type="button" className="text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground" aria-expanded={more} data-testid={`skill-more-${skill.id}`} onClick={() => setMore((m) => !m)}>
						{more ? "Less ‹" : "More ›"}
					</button>
					{more && (
						<div className="space-y-2 border-t border-border/50 pt-2" data-testid={`skill-more-body-${skill.id}`}>
							<RichText className={cn(ITEM_TYPE, "text-foreground")}>{skill.statement}</RichText>
							<WeightNote skill={skill} />
							{skill.lessonNote && (
								<div className="space-y-0.5" data-testid={`skill-note-${skill.id}`}>
									<p className="text-muted-foreground">
										Last lesson ({skill.lessonNote.at.slice(0, 10)}):{" "}
										<Link href={`/chat/${skill.lessonNote.chatId}`} className="underline decoration-border underline-offset-2 hover:text-foreground">
											open
										</Link>
									</p>
									<RichText className={cn(ITEM_TYPE, "text-muted-foreground")}>{skill.lessonNote.summary}</RichText>
								</div>
							)}
							{skill.propositions.length > 0 && (
								<div className="space-y-1.5">
									<p className="text-muted-foreground">Rests on what you have learned:</p>
									{skill.propositions.map((p) => (
										<div key={p.id} className="leading-relaxed">
											<RichText className={cn(ITEM_TYPE, "font-medium text-foreground")}>{p.name}</RichText>
											<RichText className={cn(ITEM_TYPE, "text-muted-foreground")}>{p.statement}</RichText>
											{p.sessions.length > 0 && (
												<span className="block text-[11px] text-muted-foreground/80">
													from{" "}
													{p.sessions.map((s, i) => (
														<span key={s.id}>
															{i > 0 ? ", " : ""}
															<Link href={`/chat/${s.id}`} className="underline decoration-border underline-offset-2 hover:text-foreground">
																{s.title}
															</Link>
														</span>
													))}
												</span>
											)}
										</div>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** A group of skill rows: two columns on a wide page, each row kept whole. */
function RowList({ children }: { children: React.ReactNode }) {
	return <div className="md:columns-2 md:gap-x-8">{children}</div>;
}

function DraftReview({
	data,
	busy,
	onFeedback,
	onApprove,
}: {
	data: CoursePayload;
	busy: boolean;
	onFeedback: (text: string) => void;
	onApprove: () => void;
}) {
	const draft = data.course.draft!;
	const [feedback, setFeedback] = useState("");
	const byKey = new Map(draft.skills.map((s) => [s.key, s]));
	const reusedCount = draft.skills.filter((s) => s.reuse).length;
	// A reused skill shows the draft's wording: approval writes it over the stored one (a re-wording into the course language).
	const label = (s: DraftSkill) => s.name;
	return (
		<section data-testid="course-draft" className="rounded-xl border border-border bg-card/60 p-4">
			<div className={PAGE_HEAD}>
				Draft skill map · {draft.skills.length} skills{reusedCount > 0 ? ` · ${reusedCount} reused` : ""}
			</div>
			{draft.feedback && <p className="mb-2 text-xs text-muted-foreground">Answering: “{draft.feedback}”</p>}
			<p className="mb-3 font-prose text-(length:--lh-prose-size) leading-relaxed">{draft.summary}</p>
			<ol className="mb-4 space-y-2">
				{draft.skills.map((s) => (
					<li key={s.key} className="rounded-lg border border-border/60 px-3 py-2" data-testid={`draft-skill-${s.key}`}>
						<div className="flex items-baseline gap-2">
							<RichLine prose>{label(s)}</RichLine>
							{s.reuse && <span className="rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">reused</span>}
						</div>
						<RichText className={cn(ITEM_TYPE, "text-muted-foreground")}>{s.statement}</RichText>
						<p className="mt-0.5 text-[11px] text-muted-foreground/80">
							{s.requires.length > 0 ? `Requires ${s.requires.map((k) => (byKey.get(k) ? label(byKey.get(k)!) : k)).join(", ")}` : "No prerequisites"}
							{s.restsOn.length > 0 ? ` · rests on ${s.restsOn.length} proposition${s.restsOn.length === 1 ? "" : "s"} you have learned` : ""}
							{s.cite ? ` · ${s.cite}` : ""}
						</p>
					</li>
				))}
			</ol>
			<textarea
				value={feedback}
				onChange={(e) => setFeedback(e.target.value)}
				placeholder="What should change? (split, merge, add or drop skills, prerequisites…)"
				aria-label="Changes to the draft"
				data-testid="draft-feedback"
				rows={3}
				className="lh-prose w-full rounded-lg border border-border bg-background px-3 py-2 text-(length:--lh-prose-size) outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
			/>
			<div className="mt-2 flex items-center justify-end gap-2">
				<button
					type="button"
					className={BTN}
					disabled={busy || feedback.trim() === ""}
					data-testid="draft-ask-changes"
					onClick={() => {
						onFeedback(feedback.trim());
						setFeedback("");
					}}
				>
					Ask for changes
				</button>
				<button type="button" className={cn(BTN, "border-foreground/40 text-foreground")} disabled={busy} data-testid="draft-approve" onClick={onApprove}>
					Approve
				</button>
			</div>
		</section>
	);
}

function SessionLink({ session }: { session: CourseView["sessions"][number] }) {
	return (
		<li>
			<Link href={`/chat/${session.id}`} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
				<span className="min-w-0 flex-1 line-clamp-2 break-words sm:line-clamp-none sm:block sm:truncate font-prose">{session.title}</span>
				<span className="shrink-0 text-xs text-muted-foreground">{COURSE_MODE_LABEL[session.mode]}</span>
				{session.finished && <CheckIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-label="Finished" />}
			</Link>
		</li>
	);
}

/** The course's sessions (owner, 2026-10-25): the open ones first, the
 *  finished ones folded under their own toggle so they stop crowding
 *  what is still in progress. */
function SessionsSection({ sessions }: { sessions: CourseView["sessions"] }) {
	const [showFinished, setShowFinished] = useState(false);
	const open = sessions.filter((s) => !s.finished);
	const finished = sessions.filter((s) => s.finished);
	return (
		<section data-testid="course-sessions">
			<div className={PAGE_HEAD}>Sessions</div>
			{open.length > 0 ? (
				<ul className="space-y-0.5" data-testid="course-sessions-open">
					{open.map((s) => (
						<SessionLink key={s.id} session={s} />
					))}
				</ul>
			) : (
				<p className="px-2 text-xs text-muted-foreground">No session in progress.</p>
			)}
			{finished.length > 0 && (
				<div className="mt-2">
					<button
						type="button"
						onClick={() => setShowFinished((v) => !v)}
						aria-expanded={showFinished}
						data-testid="course-sessions-finished-toggle"
						className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						{showFinished ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
						Finished · {finished.length}
					</button>
					{showFinished && (
						<ul className="space-y-0.5 opacity-80" data-testid="course-sessions-finished">
							{finished.map((s) => (
								<SessionLink key={s.id} session={s} />
							))}
						</ul>
					)}
				</div>
			)}
		</section>
	);
}

/** The page body — a pure function of the payload plus callbacks (render
 *  tests drive it directly). */
export function CourseBody({
	data,
	busy,
	error,
	onDraft,
	onApprove,
	onStart,
	onPracticeSet,
	onMaterials,
	materialCount,
	placementSkipped = false,
	onSkipPlacement,
	onChanged,
}: {
	data: CoursePayload;
	busy: boolean;
	error: string | null;
	onDraft: (feedback?: string) => void;
	onApprove: () => void;
	onStart: (mode: CourseMode, skillId?: string) => void;
	/** Start one practice session on the chosen skills ("Choose skills" mode). */
	onPracticeSet?: (skillIds: string[]) => void;
	onMaterials?: (materials: LessonMaterial[]) => void;
	materialCount: number;
	/** The learner chose "Start from the beginning" (per-viewer). */
	placementSkipped?: boolean;
	onSkipPlacement?: () => void;
	/** The exam date or a weight changed on the server: refetch. */
	onChanged?: () => void;
}) {
	// The map opens where the learner is: what is due, then what is next.
	const mapFocus = useMemo(
		() => (data.review.length + data.nextUp.length > 0 ? [...data.review, ...data.nextUp] : data.learning),
		[data.review, data.nextUp, data.learning],
	);
	const { course, skills } = data;
	const byId = useMemo(() => new Map(skills.map((s) => [s.id, s])), [skills]);
	const names = useMemo(() => new Map(skills.map((s) => [s.id, s.name])), [skills]);
	const nodes = useMemo(() => skills.map((s) => ({ id: s.id, title: s.name })), [skills]);
	const edges = useMemo(() => skills.flatMap((s) => s.requires.map((r) => ({ from: r, to: s.id }))), [skills]);
	const drafting = data.drafting || course.status === "drafting";
	const list = (ids: readonly string[]) => ids.map((id) => byId.get(id)).filter((s): s is CourseSkillView => s !== undefined);
	// a skill from another course shows once, in its own section (the
	// counts still read data.known / data.learning)
	const fromElsewhere = new Set(data.contextCheck);
	const learning = data.learning.filter((id) => !fromElsewhere.has(id));
	const known = data.known.filter((id) => !fromElsewhere.has(id));

	// The visual layer (owner, 2026-11-09; one grouped list and a Map button since 2026-11-14): the color bars read `now`; a
	// tap on a band or a review bucket narrows the list to the skills that match, sorted weakest first.
	const now = useNow();
	const [selection, setSelection] = useState<SkillSelection>(NO_SELECTION);
	const [showMap, setShowMap] = useState(false);
	// "Choose skills" (owner, 2026-11-14): tick skills, then one practice session on them. Locked skills cannot be ticked.
	const [choosing, setChoosing] = useState(false);
	const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
	const canChoose = (id: string) => {
		const s = byId.get(id);
		return s !== undefined && (s.learned || s.missing.length === 0);
	};
	const toggleChosen = (id: string) =>
		setChosen((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const stopChoosing = () => {
		setChoosing(false);
		setChosen(new Set());
	};
	const chosenIds = [...chosen].filter(canChoose);
	const chooseCount = chosenIds.length;
	const learnedIds = useMemo(() => new Set(skills.filter((s) => s.learned).map((s) => s.id)), [skills]);
	const choose = { learned: learnedIds, choosing, chosen, canChoose, toggle: toggleChosen };
	const narrow = (next: SkillSelection) => setSelection(next);
	const narrowed = !!(selection.band || selection.bucket);
	const flat = useMemo(
		() =>
			sortByUnderstanding(
				skills.filter((s) => matchesSelection(s, selection, now)),
				true,
				now,
			),
		[skills, selection, now],
	);
	const dueNow = skills.filter((s) => isDue(s, now)).length;
	const hasWeights = !!course.skillWeights && Object.keys(course.skillWeights).length > 0;
	// A weighing pass ran (a hand edit does not set weightsAt): only then is there a readiness score (core/exam-plan.ts).
	const weighed = !!course.weightsAt;
	const readiness = weighed ? examReadiness(skills.map((s) => ({ priority: s.priority, credit: knownShare(s.understanding) })), course.pastExams) : null;
	const nextUpIds = new Set(data.nextUp);
	const contextIds = new Set(data.contextCheck);
	const learnPractice = (s: CourseSkillView) => (
		<>
			<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`learn-${s.id}`} onClick={() => onStart("learn", s.id)}>
				Learn
			</button>
			<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`practice-${s.id}`} onClick={() => onStart("practice", s.id)}>
				Practice
			</button>
		</>
	);
	const practiceLearnAgain = (s: CourseSkillView) => (
		<>
			<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`practice-${s.id}`} onClick={() => onStart("practice", s.id)}>
				Practice
			</button>
			<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`learn-${s.id}`} onClick={() => onStart("learn", s.id)}>
				Learn again
			</button>
		</>
	);
	const quickCheck = (s: CourseSkillView) => (
		<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`check-${s.id}`} onClick={() => onStart("check", s.id)}>
			Quick check
		</button>
	);
	/** A known skill can be practiced too (owner, 2026-11-14): keeping it sharp before the exam. */
	const practiceOnly = (s: CourseSkillView) => (
		<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`practice-${s.id}`} onClick={() => onStart("practice", s.id)}>
			Practice
		</button>
	);
	/** A skill had from another course: the quick check, and practice since it is known. */
	const contextActions = (s: CourseSkillView) => (
		<>
			{quickCheck(s)}
			{practiceOnly(s)}
		</>
	);
	/** The flat list's per-row button: the same one the section the skill would sit in shows. */
	const actionsFor = (s: CourseSkillView) => {
		if (contextIds.has(s.id)) return contextActions(s);
		if (nextUpIds.has(s.id)) return learnPractice(s);
		if (s.learned && !s.known) return practiceLearnAgain(s);
		if (s.learned && s.known) return practiceOnly(s);
		return undefined;
	};
	return (
		<SkillListContext.Provider value={choose}>
		<div className="space-y-8">
			<CourseSettings
				courseId={course.id}
				pace={course.pace}
				hasSkills={skills.length > 0}
				hasDraft={!!course.draft}
				drafting={drafting}
				courseError={course.error}
				error={error}
				materialCount={materialCount}
				busy={busy}
				onMaterials={onMaterials}
				onDraft={() => onDraft()}
				onChanged={onChanged}
				onPlacement={() => onStart("placement")}
				exam={
					skills.length > 0
						? { examDate: course.examDate, hasWeights: weighed, weighing: data.weighing === true, canWeigh: !drafting && materialCount > 0, weightsSummary: course.weightsSummary, weightsAt: course.weightsAt }
						: undefined
				}
			/>

			{course.draft && !drafting && <DraftReview data={data} busy={busy} onFeedback={(f) => onDraft(f)} onApprove={onApprove} />}

		{skills.length > 0 && (
			<>
				<ExamPlanSection
					courseId={course.id}
					plan={data.plan}
					names={names}
					weightOf={(id) => byId.get(id)?.weight ?? 1}
					nextUp={data.nextUp}
					learningCount={data.learning.length}
					examDate={course.examDate}
					readiness={readiness}
					hasWeights={weighed}
					weightsError={course.weightsError}
					weighing={data.weighing === true}
					canWeigh={!drafting && materialCount > 0}
					busy={busy}
					onStart={onStart}
					onChanged={() => onChanged?.()}
				/>

					{data.sessions.length === 0 && !placementSkipped && skills.length > data.contextCheck.length && (
						<PlacementOffer total={skills.length - data.contextCheck.length} busy={busy} onTake={() => onStart("placement")} onSkip={() => onSkipPlacement?.()} />
					)}

					<section data-testid="course-overview" className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
						<div className={PAGE_HEAD}>Understanding · {courseProgressPercent(skills.map((s) => s.understanding))}%</div>
						<DistributionStrip skills={skills} due={dueNow} active={selection.band} onPick={(band) => narrow({ ...selection, band })} />
					</section>

					{skills.some((s) => s.learned) && (
						<section data-testid="course-due" className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
							<div className={PAGE_HEAD}>Reviews due</div>
							<DueTimeline skills={skills} now={now} active={selection.bucket} onPick={(bucket) => narrow({ ...selection, bucket })} />
						</section>
					)}

					<div className="flex flex-wrap items-center gap-2">
						<h2 className={cn(PAGE_HEAD, "pb-0")}>Skills · {skills.length}</h2>
						<span className="ml-auto flex items-center gap-2">
					{skills.some((s) => canChoose(s.id)) && (
						<button type="button" className={BTN} aria-pressed={choosing} data-testid="choose-toggle" onClick={() => (choosing ? stopChoosing() : setChoosing(true))}>
							{choosing ? "Done" : "Choose skills"}
						</button>
					)}
					<button type="button" className={BTN} aria-expanded={showMap} data-testid="map-toggle" onClick={() => setShowMap((v) => !v)}>
						{showMap ? "Hide map" : "Map"}
					</button>
				</span>
					</div>

					{showMap && (
						<section data-testid="course-map">
							<SkillMap
								nodes={nodes}
								edges={edges}
								statusOf={(id) => {
									const s = byId.get(id);
									return s ? diagramStatus(s) : "upcoming";
								}}
								focusIds={mapFocus}
								fitted
							/>
							<p className="mt-1 text-[11px] text-muted-foreground/80">White: known, learned or next up · gray: locked behind a prerequisite.</p>
						</section>
					)}

					{narrowed ? (
						<section data-testid="course-flat">
							<div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
								Showing
								{selection.band && (
									<button type="button" className={BTN} data-testid="clear-band" onClick={() => setSelection({ ...selection, band: null })}>
										{SKILL_BAND_LABEL[selection.band]} ×
									</button>
								)}
								{selection.bucket && (
									<button type="button" className={BTN} data-testid="clear-bucket" onClick={() => setSelection({ ...selection, bucket: null })}>
										Due: {DUE_BUCKET_LABEL[selection.bucket]} ×
									</button>
								)}
							</div>
							{flat.length === 0 ? (
								<p className="text-xs text-muted-foreground" data-testid="flat-empty">
									No skill matches.
								</p>
							) : (
								<RowList>
									{flat.map((s) => (
										<SkillRow key={s.id} skill={s} names={names} now={now} actions={actionsFor(s)} />
									))}
								</RowList>
							)}
						</section>
					) : (
						<>
							{data.review.length > 0 && (
								<section data-testid="course-review">
									<div className="mb-2 flex items-center justify-between">
										<span className={cn(SECTION_HEAD, "mb-0")}>Due for review · {data.review.length}{(data.plan.reviewFading ?? 0) > 0 ? ` · ${data.plan.reviewFading} fading before the exam` : ""}</span>
										<button type="button" className={BTN} disabled={busy} onClick={() => onStart("review")}>
											{data.reviewBatch < data.review.length ? reviewLabel(data) : "Review"}
										</button>
									</div>
									<RowList>{list(data.review).map((s) => <SkillRow key={s.id} skill={s} names={names} now={now} actions={actionsFor(s)} />)}</RowList>
								</section>
							)}

							<section data-testid="course-next">
								<div className="mb-2 flex items-center justify-between">
									<span className={cn(SECTION_HEAD, "mb-0")}>Next up · {data.nextUp.length}{hasWeights ? " · by exam weight" : ""}</span>
								</div>
								{data.nextUp.length === 0 ? (
									<p className="text-xs text-muted-foreground">
										{data.known.length === skills.length ? "Every skill is known." : data.locked.length === 0 ? "Every skill is learned — practice makes them known." : "Nothing is next up."}
									</p>
								) : (
									<RowList>
										{list(data.nextUp).map((s) => (
											<SkillRow key={s.id} skill={s} names={names} now={now} actions={learnPractice(s)} />
										))}
									</RowList>
								)}
							</section>

							{data.notExamined.length > 0 && (
								<details data-testid="course-not-examined" className="group">
									<summary className={cn(SECTION_HEAD, DETAILS_HEAD)}>
										<ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
										Not examined · {data.notExamined.length}
									</summary>
									<p className="mb-2 text-xs text-muted-foreground">The sources never use these in an exam, and nothing examined builds on them. You can still learn them.</p>
									<RowList>
										{list(data.notExamined).map((s) => (
											<SkillRow key={s.id} skill={s} names={names} now={now} actions={learnPractice(s)} />
										))}
									</RowList>
								</details>
							)}

							{data.contextCheck.length > 0 && (
								<section data-testid="course-context-check">
									<div className={SECTION_HEAD}>From another course · {data.contextCheck.length}</div>
									<p className="mb-2 text-xs text-muted-foreground">
										You already have these from another course. A short check confirms each one works the same way here — optional, nothing is locked behind it.
									</p>
									<RowList>
										{list(data.contextCheck).map((s) => (
											<SkillRow key={s.id} skill={s} names={names} now={now} actions={contextActions(s)} />
										))}
									</RowList>
								</section>
							)}

							{learning.length > 0 && (
								<section data-testid="course-learning">
									<div className="mb-2 flex items-center justify-between">
										<span className={cn(SECTION_HEAD, "mb-0")}>Learning · {learning.length}</span>
										{data.learning.length > 1 && (
											<button type="button" className={BTN} disabled={busy} data-testid="practice-all" onClick={() => onStart("practice")}>
												Practice all
											</button>
										)}
									</div>
									<RowList>
										{list(learning).map((s) => (
											<SkillRow key={s.id} skill={s} names={names} now={now} actions={practiceLearnAgain(s)} />
										))}
									</RowList>
								</section>
							)}

							{known.length > 0 && (
								<section data-testid="course-known">
									<div className={SECTION_HEAD}>Known · {known.length}</div>
									<RowList>{list(known).map((s) => <SkillRow key={s.id} skill={s} names={names} now={now} actions={practiceOnly(s)} />)}</RowList>
								</section>
							)}

							{data.locked.length > 0 && (
								<details data-testid="course-locked" className="group">
									<summary className={cn(SECTION_HEAD, DETAILS_HEAD)}>
										<ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
										Locked · {data.locked.length}
									</summary>
									<RowList>{list(data.locked).map((s) => <SkillRow key={s.id} skill={s} names={names} now={now} />)}</RowList>
								</details>
							)}
						</>
					)}
				</>
			)}

			{choosing && (
				<div data-testid="choose-bar" className="sticky bottom-3 z-20 flex items-center justify-between gap-3 rounded-xl border border-border bg-background/95 px-3 py-3 shadow-lg sm:px-4 backdrop-blur">
					<span className="text-sm" data-testid="choose-count">
						{chooseCount === 0 ? "Tap skills to practice" : `${chooseCount} skill${chooseCount === 1 ? "" : "s"} chosen`}
					</span>
					<span className="flex shrink-0 items-center gap-2">
						<button type="button" className={BTN} data-testid="choose-cancel" onClick={stopChoosing}>
							Cancel
						</button>
						<button
							type="button"
							className={cn(BTN, "whitespace-nowrap border-foreground/40 text-foreground")}
							disabled={busy || chooseCount === 0 || !onPracticeSet}
							data-testid="choose-start"
							onClick={() => onPracticeSet?.(chosenIds)}
						>
							Practice {chooseCount}
						</button>
					</span>
				</div>
			)}

			{data.sessions.length > 0 && <SessionsSection sessions={data.sessions} />}
		</div>
		</SkillListContext.Provider>
	);
}

/** "7/12 known · 58%". Pure. */
/** The Review buttons' label: how many skills need review, and how many of
 *  them the next review takes when that is capped (the session size). Pure. */
export function reviewLabel(data: Pick<CourseView, "review" | "reviewBatch">): string {
	if (data.review.length === 0) return "Review";
	return data.reviewBatch < data.review.length ? `Review · ${data.reviewBatch} of ${data.review.length}` : `Review · ${data.review.length}`;
}

export function courseProgress(data: Pick<CourseView, "skills" | "known">): string | null {
	if (data.skills.length === 0) return null;
	return `${data.known.length}/${data.skills.length} known`;
}

export function CoursePage({ courseId, initial }: { courseId: string; initial: CoursePayload }) {
	const router = useRouter();
	const [data, setData] = useState<CoursePayload>(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [title, setTitle] = useState(initial.course.title);
	const [materialCount, setMaterialCount] = useState(0);
	const [placementSkipped, setPlacementSkipped] = useState(false);
	useEffect(() => setPlacementSkipped(readPlacementSkipped(courseId)), [courseId]);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/courses/${courseId}`, { cache: "no-store" });
			if (res.status === 404) {
				router.push("/");
				return;
			}
			const next = (await res.json()) as CoursePayload;
			setData(next);
		} catch {
			/* keep the last snapshot */
		}
	}, [courseId, router]);

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
	useEffect(() => setTitle(data.course.title), [data.course.title]);

	const call = async (url: string, body: unknown): Promise<Response | null> => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `request failed (${res.status})`);
				return null;
			}
			return res;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return null;
		} finally {
			setBusy(false);
			void refresh();
		}
	};

	const onDraft = (feedback?: string) => void call(`/api/courses/${courseId}/draft`, feedback ? { feedback } : {});
	const onApprove = () => void call(`/api/courses/${courseId}/approve`, {});
	const onStart = async (mode: CourseMode, skillId?: string, pace?: Pace) => {
		const res = await call(`/api/courses/${courseId}/sessions`, { mode, ...(skillId ? { skillId } : {}), ...(pace ? { pace } : {}) });
		if (!res) return;
		const { id, prompt } = (await res.json()) as { id: string; prompt: string };
		router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
	};
	// "Choose skills": one practice session on the ticked skills (owner, 2026-11-14)
	const onPracticeSet = async (skillIds: string[]) => {
		const res = await call(`/api/courses/${courseId}/sessions`, { mode: "practice", skillIds });
		if (!res) return;
		const { id, prompt } = (await res.json()) as { id: string; prompt: string };
		router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
	};
	// A Learn start asks for its pace first (fork addition, 2026-11-09); every other mode starts straight away.
	const [learnSkill, setLearnSkill] = useState<string | null>(null);
	const onMaterials = useCallback((materials: LessonMaterial[]) => setMaterialCount(materials.length), []);
	// A hand edit of a skill's exam weight (owner, 2026-11-13): 0-3, or null to reset it.
	const editWeight = useCallback(
		async (skillId: string, weight: SkillWeightValue | null) => {
			try {
				const res = await fetch(`/api/courses/${courseId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weights: { [skillId]: weight } }) });
				if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `weight rejected (${res.status})`);
			} catch {
				setError("Could not reach the server — try again.");
			}
			void refresh();
		},
		[courseId, refresh],
	);
	// The sidebar's Today opens a lesson's pace dialog through ?learn=<skill id>.
	const wantedLearn = useSearchParams().get("learn");
	useEffect(() => {
		if (!wantedLearn) return;
		if (data.skills.some((s) => s.id === wantedLearn)) setLearnSkill(wantedLearn);
		router.replace(`/course/${courseId}`);
		// every arrival by a link with ?learn=, also from another lesson of the same course (the effect follows the URL)
	}, [wantedLearn]);

	const commitTitle = async () => {
		const t = title.trim();
		if (!t || t === data.course.title) {
			setTitle(data.course.title);
			return;
		}
		await fetch(`/api/courses/${courseId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: t }),
		}).catch(() => {});
		void refresh();
	};

	const remove = async () => {
		if (!window.confirm(`Delete the course "${data.course.title}"? Its skills stay in your knowledge graph, and its sessions stay in the sidebar.`)) return;
		await fetch(`/api/courses/${courseId}`, { method: "DELETE" }).catch(() => {});
		router.push("/");
	};

	const progress = courseProgress(data);
	const hasSkills = data.skills.length > 0;
	return (
		<div className="relative h-dvh overflow-y-auto">
			<header className="lh-drag z-10 flex flex-wrap items-center gap-x-3 gap-y-1 bg-background/85 sm:sticky sm:top-0 sm:flex-nowrap px-3 pb-2 pt-[calc(0.5rem+var(--lh-safe-top))] backdrop-blur">
				<SidebarToggle />
				<FitTitleInput
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={() => void commitTitle()}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							setTitle(data.course.title);
							e.currentTarget.blur();
						}
					}}
					aria-label="Course title"
					data-testid="course-title"
					className="lh-no-drag order-last min-w-0 basis-full resize-none overflow-y-auto bg-transparent font-title leading-tight outline-none sm:order-none sm:basis-auto sm:flex-1"
				/>
				{progress && (
					<span className="ml-auto shrink-0 text-xs text-muted-foreground sm:ml-0" data-testid="course-progress">
						{progress}
					</span>
				)}
				{hasSkills && (
					<span className="lh-no-drag flex shrink-0 items-center gap-1.5">
						<button
							type="button"
							className={BTN}
							disabled={busy || data.review.length === 0}
							data-testid="course-review-button"
							onClick={() => void onStart("review")}
						>
							{reviewLabel(data)}
						</button>
					</span>
				)}
			</header>
			<div className="mx-auto max-w-5xl px-4 pb-16 pt-4 sm:px-6">
				{learnSkill && (
					<LearnPaceDialog
						courseId={courseId}
						busy={busy}
						onClose={() => setLearnSkill(null)}
						onStart={(pace) => {
							const skillId = learnSkill;
							setLearnSkill(null);
							void onStart("learn", skillId, pace);
						}}
					/>
				)}
				<WeightEditContext.Provider value={(id, w) => void editWeight(id, w)}>
				<CourseBody
data={data}
					busy={busy}
					error={error}
					onDraft={onDraft}
					onApprove={onApprove}
					onStart={(mode, skillId) => {
						if (mode === "learn" && skillId) setLearnSkill(skillId);
						else void onStart(mode, skillId);
					}}
					onMaterials={onMaterials}
					onPracticeSet={(ids) => void onPracticeSet(ids)}
					materialCount={materialCount}
					placementSkipped={placementSkipped}
					onSkipPlacement={() => {
						writePlacementSkipped(courseId);
						setPlacementSkipped(true);
					}}
					onChanged={() => void refresh()}
				/>
				</WeightEditContext.Provider>
				<div className="mt-12 border-t border-border/60 pt-4">
					<button
						type="button"
						onClick={() => void remove()}
						data-testid="course-delete"
						className="text-xs text-muted-foreground/80 transition-colors hover:text-foreground"
					>
						Delete course…
					</button>
					<p className="mt-1 text-[11px] text-muted-foreground/60">
						Learned: a finished lesson or a placement credit — it unlocks the skills that build on it. Known: understanding {KNOWN_UNDERSTANDING} or higher — about a month of
						memory, built by solving it on spaced days or a confident correct answer in the placement test.
					</p>
				</div>
			</div>
		</div>
	);
}
