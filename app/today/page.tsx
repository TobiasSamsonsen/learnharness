import { TodayPage } from "@/components/today-page";
import { todayCourses } from "@/src/server";

export const dynamic = "force-dynamic";

/** The Today page (owner, 2026-11-16): every course's plan for today. Server-read for the first frame; the client
 *  refetches on events. */
export default function TodayRoute() {
	return <TodayPage initial={todayCourses()} />;
}
