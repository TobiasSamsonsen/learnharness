/**
 * COURSE FOLDERS (owner, 2026-11-14 — core/course-folders.ts): a folder is a name on a course; the order is fixed by the
 * names alone; renaming merges, removing never deletes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	FOLDER_NAME_MAX,
	canonicalFolderName,
	courseMatches,
	filterGroups,
	folderKey,
	folderNames,
	groupCourses,
	normalizeFolderName,
	removeFolderChanges,
	renameFolderChanges,
} from "../src/core/course-folders.ts";

const c = (id: string, title: string, folder?: string) => ({ id, title, ...(folder !== undefined ? { folder } : {}) });

describe("folder names", () => {
	it("are trimmed, single-spaced, 1 to 60 characters, and nothing else is a name", () => {
		assert.equal(normalizeFolderName("  2026-2   Høst "), "2026-2 Høst");
		assert.equal(normalizeFolderName("a"), "a");
		assert.equal(normalizeFolderName("x".repeat(FOLDER_NAME_MAX)), "x".repeat(FOLDER_NAME_MAX));
		for (const bad of ["", "   ", "x".repeat(FOLDER_NAME_MAX + 1), null, undefined, 5, {}]) assert.equal(normalizeFolderName(bad), null, String(bad));
	});

	it("match case-insensitively and by Unicode form, and take the spelling an existing folder has", () => {
		assert.equal(folderKey("2026-2 Høst"), folderKey("2026-2 HØST"));
		assert.equal(folderKey("Høst"), folderKey("Høst"));
		assert.equal(folderKey("Å"), folderKey("Å"), "a + combining ring is Å");
		assert.equal(canonicalFolderName("2026-2 høst", ["2026-2 Høst", "2025 Vår"]), "2026-2 Høst");
		assert.equal(canonicalFolderName("Ny", ["2026-2 Høst"]), "Ny");
		assert.equal(canonicalFolderName("x", ["X", "x"]), "X", "two spellings: the plain-order first, so every device agrees");
	});
});

describe("the sidebar's order", () => {
	const courses = [
		c("1", "Matte 1", "2025-2 Høst"),
		c("2", "Kyb Intro", "2026-1 Vår"),
		c("3", "ITGK"),
		c("4", "ADE", "2026-1 Vår"),
		c("5", "Fysikk", "2026-2 Høst"),
		c("6", "Algoritmer"),
	];

	it("lists unfiled courses by name, then folders highest name first, courses by name inside", () => {
		const g = groupCourses(courses);
		assert.deepEqual(g.unfiled.map((x) => x.title), ["Algoritmer", "ITGK"]);
		assert.deepEqual(g.folders.map((f) => f.name), ["2026-2 Høst", "2026-1 Vår", "2025-2 Høst"]);
		assert.deepEqual(g.folders[1]!.courses.map((x) => x.title), ["ADE", "Kyb Intro"]);
	});

	it("never depends on the order the courses came in, or on when they changed", () => {
		const a = groupCourses(courses);
		const b = groupCourses([...courses].reverse());
		assert.deepEqual(b, a);
	});

	it("compares numbers as numbers (2026-10 above 2026-9) and ignores case", () => {
		const g = groupCourses([c("1", "a", "2026-9"), c("2", "b", "2026-10"), c("3", "c", "2026-2")]);
		assert.deepEqual(g.folders.map((f) => f.name), ["2026-10", "2026-9", "2026-2"]);
		assert.deepEqual(groupCourses([c("1", "b"), c("2", "A")]).unfiled.map((x) => x.title), ["A", "b"]);
	});

	it("one folder per key: two spellings are one folder shown with one of them", () => {
		const g = groupCourses([c("1", "a", "2026 høst"), c("2", "b", "2026 Høst")]);
		assert.equal(g.folders.length, 1);
		assert.equal(g.folders[0]!.name, "2026 Høst");
		assert.equal(g.folders[0]!.courses.length, 2);
	});

	it("a blank or malformed folder field is no folder; titles that tie are ordered by id", () => {
		const g = groupCourses([c("2", "Same", "   "), c("1", "Same")]);
		assert.deepEqual(g.unfiled.map((x) => x.id), ["1", "2"]);
		assert.deepEqual(g.folders, []);
		assert.deepEqual(groupCourses([]), { unfiled: [], folders: [] });
	});

	it("lists the folder names in use, one spelling each", () => {
		assert.deepEqual(folderNames(courses), ["2026-2 Høst", "2026-1 Vår", "2025-2 Høst"]);
	});
});

describe("renaming and removing a folder", () => {
	const courses = [c("1", "A", "2026 Høst"), c("2", "B", "2026 Høst"), c("3", "C", "2025 Vår"), c("4", "D")];

	it("renaming moves every course of the folder, and leaves the others alone", () => {
		assert.deepEqual(renameFolderChanges(courses, "2026 høst", "2026-2 Høst"), [{ id: "1", folder: "2026-2 Høst" }, { id: "2", folder: "2026-2 Høst" }]);
	});

	it("renaming into an existing folder merges, taking that folder's spelling", () => {
		assert.deepEqual(renameFolderChanges(courses, "2026 Høst", "2025 vår"), [{ id: "1", folder: "2025 Vår" }, { id: "2", folder: "2025 Vår" }]);
	});

	it("a case-only rename changes the spelling; a rename to the same name changes nothing; an invalid name is refused", () => {
		assert.deepEqual(renameFolderChanges(courses, "2026 Høst", "2026 HØST"), [{ id: "1", folder: "2026 HØST" }, { id: "2", folder: "2026 HØST" }]);
		assert.deepEqual(renameFolderChanges(courses, "2026 Høst", "2026 Høst"), []);
		assert.equal(renameFolderChanges(courses, "2026 Høst", "  "), null);
		assert.equal(renameFolderChanges(courses, "2026 Høst", "x".repeat(61)), null);
		assert.deepEqual(renameFolderChanges(courses, "No such", "Whatever"), []);
	});

	it("removing takes its courses out of any folder and deletes nothing", () => {
		assert.deepEqual(removeFolderChanges(courses, "2026 høst"), [{ id: "1", folder: undefined }, { id: "2", folder: undefined }]);
		assert.deepEqual(removeFolderChanges(courses, "No such"), []);
	});
});

describe("searching courses", () => {
	const courses = [c("1", "Matte 1", "2026-2 Høst"), c("2", "Kyb Intro", "2026-1 Vår"), c("3", "ITGK")];

	it("matches the title or the folder's name, ignoring case; an empty query matches everything", () => {
		assert.equal(courseMatches(courses[0]!, "matte"), true);
		assert.equal(courseMatches(courses[0]!, "HØST"), true, "the folder's name counts");
		assert.equal(courseMatches(courses[2]!, "høst"), false);
		assert.equal(courseMatches(courses[2]!, "   "), true);
	});

	it("narrows the groups to matches and drops folders left empty; an empty query leaves them as they are", () => {
		const groups = groupCourses(courses);
		assert.equal(filterGroups(groups, ""), groups);
		const narrowed = filterGroups(groups, "kyb");
		assert.deepEqual(narrowed.unfiled, []);
		assert.deepEqual(narrowed.folders.map((f) => [f.name, f.courses.map((x) => x.title)]), [["2026-1 Vår", ["Kyb Intro"]]]);
		assert.deepEqual(filterGroups(groups, "zzz"), { unfiled: [], folders: [] });
		assert.equal(filterGroups(groups, "2026").folders.length, 2, "searching a folder's name shows its courses");
	});
});
