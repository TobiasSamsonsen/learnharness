import { notFound } from "next/navigation";
import { CoursePage } from "@/components/course-page";
import { courseDrafting, courseView } from "@/src/server";

export const dynamic = "force-dynamic";

/** A course's page (fork addition — docs/courses.md §6). The view is
 *  server-read for the first frame; the client refetches on events. */
export default async function CourseRoute({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const view = courseView(id);
	if (!view) notFound();
	return <CoursePage key={id} courseId={id} initial={{ ...view, drafting: courseDrafting(id) }} />;
}
