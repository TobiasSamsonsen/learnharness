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

import type { CourseMode } from "./contracts/course.ts";
import { newGraphContextMessage, type GraphContextPick, type LhMarkerMessage } from "./native-messages.ts";

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
	placement: "Placement check",
};

/** The course block of the graph-context marker's details (the card). */
export interface CourseContextDetails {
	title: string;
	mode: CourseMode;
	skills: Array<{ id: string; name: string; statement: string }>;
}

const stateLabel = (s: SessionSkill) => (s.known ? `known (box ${s.box} of 5)` : s.box === 0 ? "not started" : `learning (box ${s.box} of 5)`);

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
			return `Placement check for ${courseTitle}`;
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
		);
	} else {
		body.push(`This practice session belongs to the course "${courseTitle}".`, "", TAGGING_LAW, "");
		if (mode === "practice") {
			body.push("Work through the session's skills in the order listed (prerequisites first): give each skill at least one problem before returning to any.");
		} else if (mode === "review") {
			body.push("These skills are due for review. Pose one fresh problem per skill — a new surface, never a repeat — in the order listed. When every skill has had its problem, wrap up.");
		} else {
			body.push(
				"This is a PLACEMENT CHECK: find out which of the course's skills the learner already has, with as few problems as possible — roughly one problem per skill.",
				"- Start from the most advanced skills (the END of the list). A clean solve of a skill credits every skill it requires, so skip those.",
				"- After a miss or a hinted solve, move down to that skill's prerequisites.",
				"- Tag each problem with exactly the ONE skill it tests.",
				"- When every skill has been tested or credited, wrap up: say what the check found.",
			);
		}
	}
	return `<course>\n${body.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim()}\n</course>`;
}
