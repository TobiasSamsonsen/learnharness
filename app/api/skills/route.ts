/**
 * The skills the learner has (owner, 2026-10-25 — the home's skills card).
 *
 *   GET → SkillsOverview — known (box ≥ 3) and learning (box 1–2), across
 *         every course
 */
import { skillsOverview } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(skillsOverview());
}
