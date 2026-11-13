/**
 * The sidebar's Today list (src/server/courses.ts todayCourses, owner 2026-11-13).
 *
 *   GET → { courses: TodayCourse[] }: the active courses with something to do, soonest exam first, each with its due
 *         reviews and the lessons to take today.
 */
import { todayCourses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ courses: todayCourses() });
}
