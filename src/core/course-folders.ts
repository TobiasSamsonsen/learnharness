/**
 * course-folders — course folders in the sidebar (owner, 2026-11-14).
 *
 * A course carries an optional folder NAME (`CourseRecord.folder`), one level, so the sidebar can separate courses by
 * year or semester. There is no folder registry: a folder exists while a course is in it, you make one by moving a
 * course into "New folder…", and an emptied folder is gone. Because the name is just a course field it syncs like the
 * title does, and an old build cannot wipe anything.
 *
 * Names match case-insensitively ("2026-2 høst" is the folder "2026-2 Høst"). The order is fixed by the names
 * alone, never by activity, so a row does not jump when you work in it: courses with no folder first, by name; then
 * the folders, HIGHEST name first (name them "2026-2 Høst", "2026-1 Vår" and the newest is on top); inside a folder the
 * courses by name. Pure.
 */

export const FOLDER_NAME_MAX = 60;

/** A folder name as stored: trimmed, inner whitespace collapsed to single spaces, 1 to 60 characters. Null when it is
 *  empty, too long, or not a string. */
export function normalizeFolderName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
	return name.length >= 1 && name.length <= FOLDER_NAME_MAX ? name : null;
}

/** The key two names are the same folder by: case-insensitive, Unicode-normalized. */
export const folderKey = (name: string): string => name.normalize("NFC").toLocaleLowerCase("nb");

/** The spelling a name takes: the one an existing folder of the same key already has (the first by plain order, so every
 *  device picks the same), else the name itself. */
export function canonicalFolderName(name: string, existing: Iterable<string>): string {
	const key = folderKey(name);
	let found: string | null = null;
	for (const e of existing) {
		if (folderKey(e) !== key) continue;
		if (found === null || e < found) found = e;
	}
	return found ?? name;
}

const collator = new Intl.Collator("nb", { numeric: true, sensitivity: "base" });
const byName = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export interface FolderedCourse {
	id: string;
	title: string;
	folder?: string | undefined;
}

export interface CourseFolderGroup<T> {
	/** The folder's name as shown (one spelling per key). */
	name: string;
	courses: T[];
}

export interface CourseGroups<T> {
	/** Courses with no folder, by name. */
	unfiled: T[];
	/** Folders, highest name first, each with its courses by name. */
	folders: Array<CourseFolderGroup<T>>;
}

const byTitle = <T extends FolderedCourse>(a: T, b: T): number => byName(a.title, b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The sidebar's structure: unfiled courses, then folders (highest name first), courses by name inside each. */
export function groupCourses<T extends FolderedCourse>(courses: readonly T[]): CourseGroups<T> {
	const unfiled: T[] = [];
	const byKey = new Map<string, { names: string[]; courses: T[] }>();
	for (const course of courses) {
		const name = normalizeFolderName(course.folder);
		if (name === null) {
			unfiled.push(course);
			continue;
		}
		const key = folderKey(name);
		const entry = byKey.get(key) ?? { names: [], courses: [] };
		entry.names.push(name);
		entry.courses.push(course);
		byKey.set(key, entry);
	}
	const folders = [...byKey.values()].map((e) => ({ name: [...e.names].sort()[0]!, courses: e.courses.sort(byTitle) }));
	folders.sort((a, b) => byName(b.name, a.name));
	return { unfiled: unfiled.sort(byTitle), folders };
}

/** Every folder name in use, one spelling each, in the sidebar's order. */
export function folderNames(courses: readonly FolderedCourse[]): string[] {
	return groupCourses(courses).folders.map((f) => f.name);
}

/** A course's change of folder. `folder: undefined` takes it out of any folder. */
export interface FolderChange {
	id: string;
	folder: string | undefined;
}

/** Rename a folder: every course in it moves to the new name, merging into an existing folder of the same name. Null
 *  when the new name is not valid. */
export function renameFolderChanges(courses: readonly FolderedCourse[], from: string, to: string): FolderChange[] | null {
	const target = normalizeFolderName(to);
	if (target === null) return null;
	const key = folderKey(from);
	const others = courses.filter((c) => normalizeFolderName(c.folder) !== null && folderKey(normalizeFolderName(c.folder)!) !== key).map((c) => normalizeFolderName(c.folder)!);
	const name = canonicalFolderName(target, others);
	return courses.filter((c) => c.folder !== undefined && normalizeFolderName(c.folder) !== null && folderKey(normalizeFolderName(c.folder)!) === key && c.folder !== name).map((c) => ({ id: c.id, folder: name }));
}

/** Remove a folder: its courses move out to no folder. Nothing is deleted. */
export function removeFolderChanges(courses: readonly FolderedCourse[], name: string): FolderChange[] {
	const key = folderKey(name);
	return courses.filter((c) => normalizeFolderName(c.folder) !== null && folderKey(normalizeFolderName(c.folder)!) === key).map((c) => ({ id: c.id, folder: undefined }));
}

/** Does a course match what was typed in the sidebar's search (its title or its folder's name)? An empty query matches all. */
export function courseMatches(course: FolderedCourse, query: string): boolean {
	const q = query.normalize("NFC").trim().toLocaleLowerCase("nb");
	if (q === "") return true;
	return course.title.normalize("NFC").toLocaleLowerCase("nb").includes(q) || (normalizeFolderName(course.folder) ?? "").toLocaleLowerCase("nb").includes(q);
}

/** The groups narrowed to a search: only matching courses, and no empty folders. Empty query = unchanged. */
export function filterGroups<T extends FolderedCourse>(groups: CourseGroups<T>, query: string): CourseGroups<T> {
	if (query.trim() === "") return groups;
	return {
		unfiled: groups.unfiled.filter((c) => courseMatches(c, query)),
		folders: groups.folders.map((f) => ({ name: f.name, courses: f.courses.filter((c) => courseMatches(c, query)) })).filter((f) => f.courses.length > 0),
	};
}
