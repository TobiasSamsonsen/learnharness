/**
 * Problem difficulty (fork addition, 2026-11-07). PURE, browser-safe.
 *
 * How much one practice problem asks of the learner: how many skills it
 * combines, and the minutes of work it should take. Every practice session
 * (practice, review, context check: the `problem` tool's sessions) carries a
 * difficulty (ChatSettings.difficulty), stamped at birth from the default
 * (GeneralSettings.difficulty) and changeable while it runs, like the pace.
 *
 * Size is the work, not only the skill count: inverting a 3×3 matrix is more
 * work than a product-rule derivative though each tests one skill. So the
 * section tells the tutor to size by minutes of work too. The skill count is
 * the one part the app can enforce (the `problem` tool rejects more tagged
 * skills than the level allows); the minutes are prompt-only.
 */

export type Difficulty = "short" | "medium" | "long" | "exam";

export interface DifficultyInfo {
	id: Difficulty;
	/** The picker label. */
	label: string;
	/** The word on the pill. */
	short: string;
	/** The fewest and most skills one problem tests at this level. */
	minSkills: number;
	maxSkills: number;
	/** The minutes of work a problem should take. */
	minutes: number;
	/** The one-line description under it. */
	blurb: string;
}

export const DIFFICULTIES: readonly DifficultyInfo[] = [
	{ id: "short", label: "Short", short: "Short", minSkills: 1, maxSkills: 1, minutes: 3, blurb: "One skill, about 3 minutes" },
	{ id: "medium", label: "Medium", short: "Medium", minSkills: 2, maxSkills: 2, minutes: 6, blurb: "Two skills together, about 6 minutes" },
	{ id: "long", label: "Long", short: "Long", minSkills: 3, maxSkills: 4, minutes: 12, blurb: "Three or four skills, about 12 minutes" },
	{ id: "exam", label: "Exam", short: "Exam", minSkills: 4, maxSkills: 6, minutes: 20, blurb: "Exam-level, four to six skills, about 20 minutes" },
] as const;

export const DEFAULT_DIFFICULTY: Difficulty = "short";

export function isDifficulty(value: unknown): value is Difficulty {
	return DIFFICULTIES.some((d) => d.id === value);
}

export function difficultyInfo(id: Difficulty): DifficultyInfo {
	return DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[0]!;
}

/** A session's difficulty: its own stamp, else Short. A session born before
 *  difficulties existed is read as Short: the setting exists to make
 *  problems shorter, and it is changeable at any time. */
export function resolveDifficulty(settings: { difficulty?: Difficulty } | undefined): Difficulty {
	return settings?.difficulty ?? DEFAULT_DIFFICULTY;
}

/** The most skills one problem may be tagged with at this level. */
export function maxSkillsFor(difficulty: Difficulty): number {
	return difficultyInfo(difficulty).maxSkills;
}

/** The system-prompt section that sets a practice agent's problem size. */
export function difficultySection(difficulty: Difficulty): string {
	const info = difficultyInfo(difficulty);
	const skills =
		info.maxSkills === 1
			? "ONE skill"
			: info.minSkills === info.maxSkills
				? `${info.maxSkills} skills together in one question`
				: `${info.minSkills} to ${info.maxSkills} skills together in one question`;
	const lines = [
		`The learner's difficulty setting for this session is ${info.label.toUpperCase()}: each problem tests ${skills} and takes about ${info.minutes} minutes of work.`,
		"Size a problem by the work it takes, not only by how many skills it tags: inverting a 3×3 matrix is more work than a product-rule derivative although each is one skill. " +
			"If a problem would run past the minutes, shrink the numbers or ask for one step; if it falls well short, add to it.",
		"Pose ONE question. Use parts (a, b, c) only when each part tests a different one of the problem's skills, never to pad. " +
			"Steps of one task are not parts: \"find g'(x), then evaluate g'(1)\" is one question, written as one, with no a) and b). " +
			"Do not ask for a hand-written proof unless writing proofs is the skill under test.",
		info.maxSkills === 1
			? "Tag exactly one skill."
			: `Tag the skills the problem genuinely requires, at most ${info.maxSkills} (the problem tool rejects more).`,
	];
	if (difficulty === "exam") {
		lines.push(
			"Make it exam-level: as hard as a real exam question, or slightly harder. When the course's sources include past exams, " +
				"calibrate the length, the style and the difficulty to them. It may combine steps the way an exam does.",
		);
	}
	return `<difficulty>\n${lines.join("\n")}\n</difficulty>`;
}
