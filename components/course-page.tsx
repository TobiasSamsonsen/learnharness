"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDownIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import {
	COURSE_MODE_LABEL,
	KNOWN_BOX,
	MAX_BOX,
	type CourseMode,
	type CourseSkillView,
	type CourseView,
	type DraftSkill,
	type LessonMaterial,
	type PlanNodeStatus,
} from "@/src/core";
import { MaterialsControl } from "@/components/materials-control";
import { PlanDiagram, GRAPH_PAD } from "@/components/plan-block";
import { SidebarToggle } from "@/components/sidebar";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";

/**
 * The course page (fork addition, 2026-10-24 — docs/courses.md §6): the
 * curriculum, the planner's draft for review (ask for changes / approve),
 * and once approved the skill map, how much of it is known, and the route
 * — Review / Next up / Locked / Known — with a button for every session a
 * course can start. Everything shown is derived server-side (GET
 * /api/courses/:id); the page refetches on courses-changed and on every
 * turn settle (a concluded practice problem moves a box).
 */

export type CoursePayload = CourseView & { drafting: boolean };

/** A skill's state word. Pure — exported for render tests. */
export function skillStateLabel(skill: Pick<CourseSkillView, "box" | "known" | "missing">): string {
	if (skill.known) return `Known · box ${skill.box}/${MAX_BOX}`;
	if (skill.missing.length > 0) return "Locked";
	if (skill.box === 0) return "Not started";
	return `Learning · box ${skill.box}/${MAX_BOX}`;
}

/** The skill map's node look: known white, next up white, locked gray. */
function diagramStatus(skill: CourseSkillView): PlanNodeStatus {
	if (skill.known) return "visited";
	return skill.missing.length > 0 ? "upcoming" : "current";
}

function dueLine(skill: CourseSkillView, now = Date.now()): string | null {
	if (skill.box === 0 || !skill.dueAt) return null;
	const ms = Date.parse(skill.dueAt) - now;
	if (ms <= 0) return "due now";
	const days = Math.ceil(ms / 86_400_000);
	return days === 1 ? "due tomorrow" : `due in ${days} days`;
}

const BTN =
	"rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
const SECTION_HEAD = "mb-2 text-xs uppercase tracking-widest text-muted-foreground/70";

function SkillRow({
	skill,
	names,
	actions,
}: {
	skill: CourseSkillView;
	names: ReadonlyMap<string, string>;
	actions?: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const due = dueLine(skill);
	return (
		<div className="rounded-lg border border-border/60 bg-card/50" data-testid={`skill-${skill.id}`}>
			<div className="flex items-center gap-2 px-3 py-2">
				<button
					type="button"
					onClick={() => setOpen((o) => !o)}
					aria-expanded={open}
					aria-label={open ? `Collapse ${skill.name}` : `Expand ${skill.name}`}
					className="text-muted-foreground hover:text-foreground"
				>
					{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
				</button>
				<span className="min-w-0 flex-1">
					<span className="block truncate font-prose text-(length:--lh-prose-size)">{skill.name}</span>
					<span className="block text-xs text-muted-foreground">
						{skillStateLabel(skill)}
						{due ? ` · ${due}` : ""}
						{skill.missing.length > 0 ? ` · needs ${skill.missing.map((id) => names.get(id) ?? id).join(", ")}` : ""}
					</span>
				</span>
				{actions && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
			</div>
			{open && (
				<div className="space-y-2 border-t border-border/60 px-3 py-2 text-xs" data-testid={`skill-detail-${skill.id}`}>
					<p className="font-prose text-(length:--lh-prose-size) leading-relaxed">{skill.statement}</p>
					{skill.requires.length > 0 && (
						<p className="text-muted-foreground">Requires: {skill.requires.map((id) => names.get(id) ?? id).join(", ")}</p>
					)}
					{skill.propositions.length === 0 ? (
						<p className="text-muted-foreground">No propositions from your graph yet — a Learn session on this skill adds them.</p>
					) : (
						<div className="space-y-1.5">
							<p className="text-muted-foreground">Rests on what you have learned:</p>
							{skill.propositions.map((p) => (
								<div key={p.id} className="leading-relaxed">
									<span className="font-medium text-foreground">{p.name}</span>
									<span className="text-muted-foreground"> — {p.statement}</span>
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
	);
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
	const label = (s: DraftSkill) => (s.reuse ? (data.reused[s.reuse]?.name ?? s.name) : s.name);
	return (
		<section data-testid="course-draft" className="rounded-xl border border-border bg-card/60 p-4">
			<div className={SECTION_HEAD}>
				Draft skill map · {draft.skills.length} skills{reusedCount > 0 ? ` · ${reusedCount} reused` : ""}
			</div>
			{draft.feedback && <p className="mb-2 text-xs text-muted-foreground">Answering: “{draft.feedback}”</p>}
			<p className="mb-3 font-prose text-(length:--lh-prose-size) leading-relaxed">{draft.summary}</p>
			<ol className="mb-4 space-y-2">
				{draft.skills.map((s) => (
					<li key={s.key} className="rounded-lg border border-border/60 px-3 py-2" data-testid={`draft-skill-${s.key}`}>
						<div className="flex items-baseline gap-2">
							<span className="font-prose text-(length:--lh-prose-size)">{label(s)}</span>
							{s.reuse && <span className="rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">reused</span>}
						</div>
						<p className="text-xs leading-relaxed text-muted-foreground">{s.reuse ? (data.reused[s.reuse]?.statement ?? s.statement) : s.statement}</p>
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

/** The page body — a pure function of the payload plus callbacks (render
 *  tests drive it directly). */
export function CourseBody({
	data,
	busy,
	error,
	onDraft,
	onApprove,
	onStart,
	onMaterials,
	materialCount,
}: {
	data: CoursePayload;
	busy: boolean;
	error: string | null;
	onDraft: (feedback?: string) => void;
	onApprove: () => void;
	onStart: (mode: CourseMode, skillId?: string) => void;
	onMaterials?: (materials: LessonMaterial[]) => void;
	materialCount: number;
}) {
	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const { course, skills } = data;
	const byId = useMemo(() => new Map(skills.map((s) => [s.id, s])), [skills]);
	const names = useMemo(() => new Map(skills.map((s) => [s.id, s.name])), [skills]);
	const nodes = useMemo(() => skills.map((s) => ({ id: s.id, title: s.name })), [skills]);
	const edges = useMemo(() => skills.flatMap((s) => s.requires.map((r) => ({ from: r, to: s.id }))), [skills]);
	const drafting = data.drafting || course.status === "drafting";
	const list = (ids: readonly string[]) => ids.map((id) => byId.get(id)).filter((s): s is CourseSkillView => s !== undefined);
	return (
		<div className="space-y-8">
			<section data-testid="course-curriculum">
				<div className={SECTION_HEAD}>Curriculum</div>
				<div className="flex flex-wrap items-center gap-2">
					<MaterialsControl courseId={course.id} onChange={onMaterials} />
					<button
						type="button"
						className={BTN}
						disabled={busy || drafting || materialCount === 0}
						data-testid="course-draft-button"
						onClick={() => onDraft()}
					>
						{course.skills.length > 0 || course.draft ? "Re-draft skill map" : "Draft skill map"}
					</button>
					{drafting && (
						<span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="course-drafting">
							<Loader2Icon className="size-3.5 animate-spin" />
							The course planner is reading the curriculum…
						</span>
					)}
				</div>
				{materialCount === 0 && !drafting && (
					<p className="mt-2 text-xs text-muted-foreground">Add the curriculum (PDFs, notes or links), then draft the skill map.</p>
				)}
				{course.error && !drafting && (
					<p className="mt-2 text-xs text-red-500" data-testid="course-error">
						Drafting failed: {course.error}
					</p>
				)}
				{error && <p className="mt-2 text-xs text-red-500">{error}</p>}
			</section>

			{course.draft && !drafting && <DraftReview data={data} busy={busy} onFeedback={(f) => onDraft(f)} onApprove={onApprove} />}

			{skills.length > 0 && (
				<>
					<section data-testid="course-map">
						<div className={SECTION_HEAD}>Skill map</div>
						<PlanDiagram
							nodes={nodes}
							edges={edges}
							statusOf={(id) => {
								const s = byId.get(id);
								return s ? diagramStatus(s) : "upcoming";
							}}
							markerId={markerId}
							pad={GRAPH_PAD}
						/>
						<p className="mt-1 text-[11px] text-muted-foreground/80">White: known or next up · gray: locked behind a prerequisite.</p>
					</section>

					{data.review.length > 0 && (
						<section data-testid="course-review">
							<div className="mb-2 flex items-center justify-between">
								<span className={cn(SECTION_HEAD, "mb-0")}>Due for review · {data.review.length}</span>
								<button type="button" className={BTN} disabled={busy} onClick={() => onStart("review")}>
									Review
								</button>
							</div>
							<div className="space-y-1.5">{list(data.review).map((s) => <SkillRow key={s.id} skill={s} names={names} />)}</div>
						</section>
					)}

					<section data-testid="course-next">
						<div className="mb-2 flex items-center justify-between">
							<span className={cn(SECTION_HEAD, "mb-0")}>Next up · {data.nextUp.length}</span>
							{data.nextUp.length > 1 && (
								<button type="button" className={BTN} disabled={busy} data-testid="practice-all" onClick={() => onStart("practice")}>
									Practice all
								</button>
							)}
						</div>
						{data.nextUp.length === 0 ? (
							<p className="text-xs text-muted-foreground">{data.known.length === skills.length ? "Every skill is known." : "Nothing is next up."}</p>
						) : (
							<div className="space-y-1.5">
								{list(data.nextUp).map((s) => (
									<SkillRow
										key={s.id}
										skill={s}
										names={names}
										actions={
											<>
												<button type="button" className={BTN} disabled={busy} data-testid={`learn-${s.id}`} onClick={() => onStart("learn", s.id)}>
													Learn
												</button>
												<button type="button" className={BTN} disabled={busy} data-testid={`practice-${s.id}`} onClick={() => onStart("practice", s.id)}>
													Practice
												</button>
											</>
										}
									/>
								))}
							</div>
						)}
					</section>

					{data.locked.length > 0 && (
						<section data-testid="course-locked">
							<div className={SECTION_HEAD}>Locked · {data.locked.length}</div>
							<div className="space-y-1.5">{list(data.locked).map((s) => <SkillRow key={s.id} skill={s} names={names} />)}</div>
						</section>
					)}

					{data.known.length > 0 && (
						<section data-testid="course-known">
							<div className={SECTION_HEAD}>Known · {data.known.length}</div>
							<div className="space-y-1.5">{list(data.known).map((s) => <SkillRow key={s.id} skill={s} names={names} />)}</div>
						</section>
					)}
				</>
			)}

			{data.sessions.length > 0 && (
				<section data-testid="course-sessions">
					<div className={SECTION_HEAD}>Sessions</div>
					<ul className="space-y-0.5">
						{data.sessions.map((s) => (
							<li key={s.id}>
								<Link href={`/chat/${s.id}`} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
									<span className="min-w-0 flex-1 truncate font-prose">{s.title}</span>
									<span className="shrink-0 text-xs text-muted-foreground">{COURSE_MODE_LABEL[s.mode]}</span>
								</Link>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

/** "7/12 known · 58%". Pure. */
export function courseProgress(data: Pick<CourseView, "skills" | "known">): string | null {
	if (data.skills.length === 0) return null;
	return `${data.known.length}/${data.skills.length} known · ${Math.round((data.known.length / data.skills.length) * 100)}%`;
}

export function CoursePage({ courseId, initial }: { courseId: string; initial: CoursePayload }) {
	const router = useRouter();
	const [data, setData] = useState<CoursePayload>(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [title, setTitle] = useState(initial.course.title);
	const [materialCount, setMaterialCount] = useState(0);

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
	const onStart = async (mode: CourseMode, skillId?: string) => {
		const res = await call(`/api/courses/${courseId}/sessions`, { mode, ...(skillId ? { skillId } : {}) });
		if (!res) return;
		const { id, prompt } = (await res.json()) as { id: string; prompt: string };
		router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
	};
	const onMaterials = useCallback((materials: LessonMaterial[]) => setMaterialCount(materials.length), []);

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
			<header className="lh-drag sticky top-0 z-10 flex items-center gap-3 bg-background/85 px-3 py-2 backdrop-blur">
				<SidebarToggle />
				<input
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
					className="lh-no-drag min-w-0 flex-1 bg-transparent font-title text-lg outline-none"
				/>
				{progress && (
					<span className="shrink-0 text-xs text-muted-foreground" data-testid="course-progress">
						{progress}
					</span>
				)}
				{hasSkills && (
					<span className="lh-no-drag flex shrink-0 items-center gap-1.5">
						<button type="button" className={BTN} disabled={busy} data-testid="course-placement" onClick={() => void onStart("placement")}>
							Placement check
						</button>
						<button
							type="button"
							className={BTN}
							disabled={busy || data.review.length === 0}
							data-testid="course-review-button"
							onClick={() => void onStart("review")}
						>
							Review{data.review.length > 0 ? ` · ${data.review.length}` : ""}
						</button>
					</span>
				)}
			</header>
			<div className="mx-auto max-w-3xl px-6 pb-16 pt-4">
				<CourseBody
					data={data}
					busy={busy}
					error={error}
					onDraft={onDraft}
					onApprove={onApprove}
					onStart={(mode, skillId) => void onStart(mode, skillId)}
					onMaterials={onMaterials}
					materialCount={materialCount}
				/>
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
						Known means box {KNOWN_BOX} or higher: three clean solves on spaced days (or a clean placement solve).
					</p>
				</div>
			</div>
		</div>
	);
}
