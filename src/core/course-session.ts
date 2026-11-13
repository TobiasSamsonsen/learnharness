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
import type { LessonLanguage } from "./language.ts";
import { newGraphContextMessage, newMessageId, type GraphContextPick, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";

// ─── finishing a course session (owner, 2026-10-25) ──────────────────────────
//
// Every course session ends in one of two ways, both logged in the
// transcript: the agent's finish tool (it judged the work done, or the
// learner asked), or the learner's Finish button (the marker below — its
// type keeps the name it got when only lessons could finish). A finished
// LEARN session makes its skill LEARNED (box ≥ 1 — core/mastery.ts), which
// is what unlocks the skills that build on it; the other modes' evidence
// stays their graded answers and concluded problems — finishing them only
// marks the session done.

/** The teacher's finish tool (course Learn sessions only). */
export const FINISH_LESSON_TOOL = "finish_lesson";

/** The practice agent's and the placement tester's finish tool (every
 *  other course session). */
export const FINISH_SESSION_TOOL = "finish_session";

/** The model-facing text of the learner's Finish lesson marker. */
export const LESSON_FINISHED_TEXT =
	"[LESSON FINISHED] — the learner pressed Finish lesson: the lesson is logged as finished and its skill now counts as learned. Wrap up in a few sentences — what they can now do, and what to practice — and pose no new question.";

/** The model-facing text of the learner's Finish lesson press since the final problem (owner, 2026-11-13): a REQUEST. The
 *  lesson finishes only through a final problem and `finish_lesson`. */
export const FINISH_REQUESTED_TEXT =
	"[FINISH REQUESTED] — the learner pressed Finish lesson: they want to end the lesson now. Skip what is left of the plan and pose the final problem " +
	"at once (`explain` with type \"final\"), with no hint in its lead. The lesson is finished only when `finish_lesson` goes through after their answer.";

/** …and of the learner's Finish session marker (every other mode). */
export const SESSION_FINISHED_TEXT =
	"[SESSION FINISHED] — the learner pressed Finish session: the session is logged as finished. Wrap up in a few sentences — what this session showed — and pose nothing more.";

/** The learner's Finish marker. In a Learn session it is a REQUEST for the final problem (`details.request`, owner
 *  2026-11-13) and finishes nothing; in every other course session it finishes the session. A Learn marker from
 *  before the final problem carries no `request` and still counts as the finish it was. */
export function newLessonFinishedMarker(mode: CourseMode = "learn"): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "lesson-finished",
		content: mode === "learn" ? FINISH_REQUESTED_TEXT : SESSION_FINISHED_TEXT,
		display: true,
		details: mode === "learn" ? { by: "learner", request: true } : { by: "learner" },
		timestamp: Date.now(),
	};
}

/** True for a Learn session's finish REQUEST marker (it asks for the final problem and finishes nothing). */
export function isFinishRequest(message: unknown): boolean {
	const m = message as { role?: string; customType?: string; details?: { request?: unknown } | null };
	return m.role === "custom" && m.customType === "lesson-finished" && m.details?.request === true;
}

const FINISH_TOOLS: ReadonlySet<string> = new Set([FINISH_LESSON_TOOL, FINISH_SESSION_TOOL]);

/** When (and by whom) a course session was finished — the FIRST finish in
 *  the transcript; null while it is open. A finish call counts only
 *  through its clean result ("either it goes through or it doesn't" — the
 *  practice tools' activation rule). */
export function sessionFinishOf(messages: readonly LhMessage[]): { at: number; by: "agent" | "learner"; callId?: string } | null {
	const clean = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && !(m as ToolResultMessage).isError) clean.add((m as ToolResultMessage).toolCallId);
	}
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "custom" && (m as LhMarkerMessage).customType === "lesson-finished") {
			if (isFinishRequest(m)) continue;
			return { at: m.timestamp, by: "learner" };
		}
		if (role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		const call = assistant.content.find((b) => b.type === "toolCall" && FINISH_TOOLS.has(b.name) && clean.has(b.id));
		if (call && call.type === "toolCall") return { at: assistant.timestamp, by: "agent", callId: call.id };
	}
	return null;
}

/** What the teacher said it showed when it finished the lesson (the `summary` of the clean finish_lesson call; owner,
 *  2026-11-13): the lesson's note. Null for an open lesson, a finish by the learner's marker (older sessions) or a blank
 *  summary. */
export function finishSummaryOf(messages: readonly LhMessage[]): { summary: string; at: number } | null {
	const finish = sessionFinishOf(messages);
	if (!finish?.callId) return null;
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const b of (m as AssistantMessage).content) {
			if (b.type !== "toolCall" || b.id !== finish.callId) continue;
			const summary = (b.arguments as { summary?: unknown } | undefined)?.summary;
			return typeof summary === "string" && summary.trim() !== "" ? { summary: summary.trim(), at: finish.at } : null;
		}
	}
	return null;
}

/** The placement test's grading line (owner, 2026-10-25): a correct answer
 *  at or above this confidence credits the skill as KNOWN. */
export const PLACEMENT_KNOWN_CONFIDENCE = 70;

/** The placement test's soft question target (owner, 2026-10-25): about
 *  a third of the course's skills — stated in the prompt, never enforced. */
export function placementQuestionTarget(skillCount: number): number {
	return Math.max(1, Math.round(skillCount / 3));
}

/** One skill as a session sees it. */
export interface SessionSkill {
	id: string;
	name: string;
	statement: string;
	/** 0–10 (core/mastery.ts); 0 = not learned. */
	understanding: number;
	learned: boolean;
	known: boolean;
	needsReview: boolean;
	/** The note its last lesson left (finishSummaryOf): what the learner showed and what to practice. */
	note?: string;
}

export const COURSE_MODE_LABEL: Record<CourseMode, string> = {
	learn: "Learn",
	practice: "Practice",
	review: "Review",
	placement: "Placement test",
	check: "Context check",
};

/** The course block of the graph-context marker's details (the card). */
export interface CourseContextDetails {
	title: string;
	mode: CourseMode;
	skills: Array<{ id: string; name: string; statement: string }>;
}

const stateLabel = (s: SessionSkill) => {
	if (!s.learned) return "not learned yet";
	const level = `understanding ${s.understanding} of 10`;
	return `${s.known ? "known" : "learned, not yet known"} (${level}${s.needsReview ? ", due for review" : ""})`;
};

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
		opts.mode === "learn" ? "The skill this lesson teaches (id — name: statement · state):" : opts.mode === "practice" && opts.skills.length > 1 ? "The session's skills, in a mixed order (id — name: statement · state):" : "The session's skills, prerequisites first (id — name: statement · state):",
		...opts.skills.map((s) => `- [${s.id}] ${s.name}: ${s.statement} · ${stateLabel(s)}${s.note && opts.mode !== "learn" ? `\n  note from its last lesson: ${s.note}` : ""}`),
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
export function courseFirstMessage(
	mode: CourseMode,
	courseTitle: string,
	skills: readonly { name: string; statement: string }[],
	language: LessonLanguage = "en",
): string {
	if (language === "nb") {
		switch (mode) {
			case "learn":
				return `Jeg vil lære å: ${skills[0]?.statement ?? courseTitle}`;
			case "practice":
				return `Øv på: ${skills.map((s) => s.name).join(", ")}`;
			case "review":
				return "Repeter ferdighetene mine som skal repeteres nå";
			case "placement":
				return `Nivåtest for ${courseTitle}`;
			case "check":
				return `Jeg kan dette fra et annet kurs. Sjekk at jeg kan bruke det i ${courseTitle}: ${skills[0]?.statement ?? courseTitle}`;
		}
	}
	switch (mode) {
		case "learn":
			return `I want to learn to: ${skills[0]?.statement ?? courseTitle}`;
		case "practice":
			return `Practice: ${skills.map((s) => s.name).join(", ")}`;
		case "review":
			return "Review my due skills";
		case "placement":
			return `Placement test for ${courseTitle}`;
		case "check":
			return `I already know this from another course — check that I can use it in ${courseTitle}: ${skills[0]?.statement ?? courseTitle}`;
	}
}

const TAGGING_LAW = `Every problem you pose tests one or more of the session's skills (the session context lists them with their ids), and the problem call's \`skills\` field MUST name them. That tag is how the course tracks what the learner knows: when the problem concludes, a separate grader reads the whole problem and grades each tagged skill on the again/hard/good/easy scale, and that grade moves the skill's understanding (you never grade; your conclusion's outcome, hint rung and verdict are one account it weighs). Tag only the skills solving the problem genuinely requires.`;

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
			`OPENER: when the context lists prerequisite skills the learner has already learned, open the teaching (after the plan is approved, before the first step) with one or two SHORT questions on them, each posed with \`explain\` and type "recall" and \`skill\` set to that skill's id: a fresh case, written by the learner, no hint. They are retrieval practice on earlier skills, and a separate grader rates them when the lesson finishes, so a good answer strengthens that skill's memory and a miss brings its review forward. React to the answer briefly (what was right, the one thing missed) and go on; never turn an opener into a lesson. When the context lists no learned prerequisite, there is no opener.`,
			`FINISHING: a lesson ends with ONE final problem, posed with \`explain\` and type "final". Pose it when the plan is taught, or at once when the learner asks to finish. It is a fresh case that takes the whole skill as its statement says, at the level the course's past exams ask when the sources hold any. It is unaided: give no hint, no method reminder and no partial answer in its lead, and none while it is open. Pace never removes it.`,
			`After the answer, say what was right and wrong, then call \`${FINISH_LESSON_TOOL}\`. A separate grader rates the final problem. If it was not solved (or the learner did not know), the lesson is not finished: teach the gap, then pose a NEW final problem on a different case (never the one you just explained). Never pose a question after a finish that went through.`,
			"A finish that goes through logs the lesson and makes the skill learned at the grader's rating, which unlocks the skills that build on it; spaced practice and review make it known later.",
		);
	} else if (mode === "placement") {
		body.push(
			`This is the PLACEMENT TEST for the course "${courseTitle}": find which of the course's skills the learner already has, so their studying starts at their real edge instead of the most basic skill. The session context lists every skill, prerequisites first, with its id.`,
			"",
			"- Ask with `probe`: one multiple-choice question per call, testing exactly ONE skill — set `skill` to its id. Never a question per proposition.",
			`- **Aim for about ${placementQuestionTarget(skills.length)} questions** — the test narrows down, it does not cover every skill.`,
			"- **Hardest technical skills first.** Open with the technical skills that have the most prerequisites beneath them, with a genuinely hard question. A confident correct answer credits that skill and everything it requires — never ask about a credited skill again. After a miss, an \"I don't know\", or a correct answer below the confidence line, move down to that skill's prerequisites.",
			"- **Judgment skills last.** Skills a sensible adult can answer by common sense (using AI, reflecting, judging code, choosing an application) come only after every technical skill is tested or credited.",
			`- How the course reads each answer: correct with confidence ≥ ${PLACEMENT_KNOWN_CONFIDENCE} → known (and its prerequisites with it, except any the learner missed directly — a direct miss always wins); less sure → learned; wrong or "I don't know" → not credited. Nothing you write changes this — ask questions whose answer really shows the skill.`,
			"- Short and hard: the difficulty is the trap, not the length (the question rule below).",
			`- When every skill is tested or credited, end with a short summary — what is solid and where to start. State only counts you actually counted. Then call \`${FINISH_SESSION_TOOL}\` and pose no further question.`,
			`- **At about ${placementQuestionTarget(skills.length)} questions with skills still neither tested nor credited, ask ONCE with \`ask_user_question\`**: continue testing the remaining skills, or finish now — say how many remain. Continue → keep testing until every skill is tested or credited. Finish now → the summary names the untested skills plainly as not tested (never as known, never as unknown), then call \`${FINISH_SESSION_TOOL}\`.`,
		);
	} else {
		body.push(`This practice session belongs to the course "${courseTitle}".`, "", TAGGING_LAW, "");
		if (mode === "practice") {
			body.push(`Work through the session's skills in the order listed (it is mixed on purpose, so that skills are practiced between one another): give each skill at least one problem before returning to any. When the arc is complete — or the learner says they are done — close in a few sentences and call \`${FINISH_SESSION_TOOL}\`.`);
		} else if (mode === "check") {
			body.push(
				"CONTEXT CHECK — the learner already has this skill from another course. This is a SHORT session, not a lesson: confirm the skill works for them in THIS course's context.",
				"- Pose one problem (two at most) framed the way this course uses the skill: its material, notation, conventions and typical tasks.",
				"- In the pause after it, explain briefly only what is different here — notation, conventions, pitfalls particular to this course. Never re-teach the skill.",
				`- Once they have shown it, wrap up in two or three sentences, call \`${FINISH_SESSION_TOOL}\`, and pose nothing more. If a problem reveals a real gap, say so plainly and recommend a Learn session on the skill instead of stretching this one.`,
			);
		} else {
			body.push(
				"This is a REVIEW session: the skills below were chosen because they need work (the weakest, one not practiced for a long time) and the first is one the learner is strong on, to start warm. Together they ARE the session; do not add skills or extra problems.",
				"Test every listed skill in the order listed with a fresh problem, a new surface and never a repeat. At difficulty Short that is one problem per skill; at a higher difficulty group the skills, in order, into problems of the size the difficulty section sets.",
				`When every skill has been tested (and at most one retest after a taught problem), wrap up in a few sentences and call \`${FINISH_SESSION_TOOL}\`.`,
			);
		}
	}
	return `<course>\n${body.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim()}\n</course>`;
}
