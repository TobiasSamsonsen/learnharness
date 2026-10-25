/**
 * Course sessions — what a session started from a course carries (fork
 * addition, 2026-10-24; spec: docs/courses.md §4). PURE, browser-safe.
 *
 *   - the CONTEXT MARKER (message[0]): the session's skills with their
 *     review state, the propositions they rest on, the chains among them.
 *     It rides the graph-context marker type — same flattening, same
 *     neutral input cause, same transcript card (which shows the skills).
 *   - the PROMPT SECTION, rebuilt every turn: how this mode works, and —
 *     in practice modes — the skill-tagging law the boxes depend on.
 *   - titles and the generated first learner message.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CourseMode } from "./contracts/course.ts";
import { newGraphContextMessage, newMessageId, type GraphContextPick, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";

// ─── finishing a Learn session (owner, 2026-10-25) ───────────────────────────
//
// A Learn session ends in one of two ways, both logged in the transcript:
// the teacher's finish_lesson tool (it judged the goal met, or the learner
// asked), or the learner's Finish lesson button (the lesson-finished
// marker). Either makes the skill LEARNED (box ≥ 1 — core/mastery.ts),
// which is what unlocks the skills that build on it.

/** The teacher's finish tool (course Learn sessions only). */
export const FINISH_LESSON_TOOL = "finish_lesson";

/** The model-facing text of the learner's Finish lesson marker. */
export const LESSON_FINISHED_TEXT =
	"[LESSON FINISHED] — the learner pressed Finish lesson: the lesson is logged as finished and its skill now counts as learned. Wrap up in a few sentences — what they can now do, and what to practice — and pose no new question.";

/** The learner's Finish lesson marker. */
export function newLessonFinishedMarker(): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "lesson-finished",
		content: LESSON_FINISHED_TEXT,
		display: true,
		details: { by: "learner" },
		timestamp: Date.now(),
	};
}

/** When (and by whom) a Learn session was finished — the FIRST finish in
 *  the transcript; null while it is open. A finish_lesson call counts
 *  only through its clean result ("either it goes through or it
 *  doesn't" — the practice tools' activation rule). */
export function lessonFinishOf(messages: readonly LhMessage[]): { at: number; by: "teacher" | "learner" } | null {
	const clean = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && !(m as ToolResultMessage).isError) clean.add((m as ToolResultMessage).toolCallId);
	}
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "custom" && (m as LhMarkerMessage).customType === "lesson-finished") return { at: m.timestamp, by: "learner" };
		if (role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		if (assistant.content.some((b) => b.type === "toolCall" && b.name === FINISH_LESSON_TOOL && clean.has(b.id))) {
			return { at: assistant.timestamp, by: "teacher" };
		}
	}
	return null;
}

/** The placement test's grading line (owner, 2026-10-25): a correct answer
 *  at or above this confidence credits the skill as KNOWN. */
export const PLACEMENT_KNOWN_CONFIDENCE = 70;

/** One skill as a session sees it. */
export interface SessionSkill {
	id: string;
	name: string;
	statement: string;
	box: number;
	known: boolean;
}

export const COURSE_MODE_LABEL: Record<CourseMode, string> = {
	learn: "Learn",
	practice: "Practice",
	review: "Review",
	placement: "Placement test",
};

/** The course block of the graph-context marker's details (the card). */
export interface CourseContextDetails {
	title: string;
	mode: CourseMode;
	skills: Array<{ id: string; name: string; statement: string }>;
}

const stateLabel = (s: SessionSkill) => (s.known ? `known (box ${s.box} of 5)` : s.box === 0 ? "not learned yet" : `learned, not yet known (box ${s.box} of 5)`);

/** The session's context marker (message[0]). `background` = a Learn
 *  session's prerequisites (listed as context, not as targets). */
export function newCourseContextMessage(opts: {
	courseTitle: string;
	mode: CourseMode;
	skills: readonly SessionSkill[];
	background?: readonly SessionSkill[];
	propositions: readonly GraphContextPick[];
	chains: readonly string[];
}): LhMarkerMessage {
	const marker = newGraphContextMessage(opts.propositions, opts.chains);
	const lines = [
		`[Session context] — this session belongs to the course "${opts.courseTitle}" (${COURSE_MODE_LABEL[opts.mode]}).`,
		"",
		opts.mode === "learn" ? "The skill this lesson teaches (id — name: statement · state):" : "The session's skills, prerequisites first (id — name: statement · state):",
		...opts.skills.map((s) => `- [${s.id}] ${s.name}: ${s.statement} · ${stateLabel(s)}`),
	];
	if (opts.background && opts.background.length > 0) {
		lines.push("", "Its prerequisite skills (id — name: statement · state):", ...opts.background.map((s) => `- [${s.id}] ${s.name}: ${s.statement} · ${stateLabel(s)}`));
	}
	if (opts.propositions.length > 0) {
		lines.push(
			"",
			"Propositions from the learner's knowledge graph that these skills rest on (id — name: statement; the problem tool's target field uses these ids):",
			...opts.propositions.map((p) => `- [${p.id}] ${p.name}: ${p.statement}`),
		);
	}
	if (opts.chains.length > 0) {
		lines.push("", "Reasoning chains among them (premises → conclusion):", ...opts.chains.map((c) => `- ${c}`));
	}
	const course: CourseContextDetails = {
		title: opts.courseTitle,
		mode: opts.mode,
		skills: opts.skills.map((s) => ({ id: s.id, name: s.name, statement: s.statement })),
	};
	return {
		...marker,
		content: lines.join("\n"),
		details: { ...(marker.details as object), course },
	};
}

/** The session's title. */
export function courseSessionTitle(mode: CourseMode, courseTitle: string, skills: readonly { name: string }[]): string {
	if (mode === "review") return `Review: ${courseTitle}`;
	if (mode === "placement") return `Placement: ${courseTitle}`;
	const names = skills.map((s) => s.name).join(", ");
	return `${COURSE_MODE_LABEL[mode]}: ${names || courseTitle}`;
}

/** The generated first learner message. */
export function courseFirstMessage(mode: CourseMode, courseTitle: string, skills: readonly { name: string; statement: string }[]): string {
	switch (mode) {
		case "learn":
			return `I want to learn to: ${skills[0]?.statement ?? courseTitle}`;
		case "practice":
			return `Practice: ${skills.map((s) => s.name).join(", ")}`;
		case "review":
			return "Review my due skills";
		case "placement":
			return `Placement test for ${courseTitle}`;
	}
}

const TAGGING_LAW = `Every problem you pose tests one or more of the session's skills (the session context lists them with their ids), and the problem call's \`skills\` field MUST name them. That tag is how the course tracks what the learner knows: concluding moves the tagged skills' review boxes — \`solved\` (no hints) is a clean solve, \`solvedWithHints\` is not, \`movedOn\` and \`surrendered\` are misses. Tag only the skills solving the problem genuinely requires, and conclude honestly.`;

/** The per-turn system-prompt section of a course session. */
export function coursePromptSection(mode: CourseMode, courseTitle: string, skills: readonly SessionSkill[]): string {
	const body: string[] = [];
	if (mode === "learn") {
		const skill = skills[0];
		body.push(
			`This lesson belongs to the course "${courseTitle}". Its goal is ONE skill from the course's skill map — the learner is done when they can do what its statement says:`,
			skill ? `  ${skill.name}: ${skill.statement}` : "",
			"Any source material below is the course's curriculum: use its definitions, notation and terminology, and cite it — but this lesson's TARGET and SCOPE is this one skill, not the whole material.",
			"The session context lists the skill's prerequisites and their state, and the propositions from the learner's graph it rests on — probe from there.",
			"",
			`FINISHING: when the learner has shown they can do what the statement says — demonstrated on fresh cases, not assumed — call \`${FINISH_LESSON_TOOL}\`, then wrap up in a few sentences. Call it too when the learner asks to finish. Finishing logs the lesson and makes the skill learned, which unlocks the skills that build on it; spaced practice and review make it known later. Never pose a new question after finishing.`,
		);
	} else if (mode === "placement") {
		body.push(
			`This is the PLACEMENT TEST for the course "${courseTitle}": find which of the course's skills the learner already has, so their studying starts at their real edge instead of the most basic skill. The session context lists every skill, prerequisites first, with its id.`,
			"",
			"- Ask with `probe`: one multiple-choice question per call, testing exactly ONE skill — set `skill` to its id. Roughly one question per skill; never a question per proposition.",
			"- Go top-down: start with the most advanced skills (the END of the list). A confident correct answer credits that skill AND everything it requires — skip those. After a wrong answer, an \"I don't know\", or a correct answer below the confidence line, move down to that skill's prerequisites.",
			`- How the course reads each answer: correct with confidence ≥ ${PLACEMENT_KNOWN_CONFIDENCE} → known (and its prerequisites with it); correct but less sure → learned; wrong or "I don't know" → not credited. Nothing you write changes this — ask questions whose answer really shows the skill.`,
			"- Make each question an applied one: the skill used on a fresh case, hard enough that a guess rarely lands, answerable without having seen the course's own examples.",
			"- When every skill has been tested or credited, end with a short summary — what is solid, and where the learner should start — and pose no further question.",
		);
	} else {
		body.push(`This practice session belongs to the course "${courseTitle}".`, "", TAGGING_LAW, "");
		if (mode === "practice") {
			body.push("Work through the session's skills in the order listed (prerequisites first): give each skill at least one problem before returning to any.");
		} else {
			body.push("These skills are due for review. Pose one fresh problem per skill — a new surface, never a repeat — in the order listed. When every skill has had its problem, wrap up.");
		}
	}
	return `<course>\n${body.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim()}\n</course>`;
}
