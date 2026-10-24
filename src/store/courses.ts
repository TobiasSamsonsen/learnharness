/**
 * CourseStore — the fs JSON adapter (one file per course in data/courses/;
 * fork addition, 2026-10-24 — docs/courses.md §1.2).
 *
 * Same idioms as src/store/chats.ts: sync fs, id-guarded filenames, tab-
 * indented JSON, a lazy schema stamp on every write and an honest refusal
 * of newer-stamped records. Every mutation announces courses-changed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { CURRENT_COURSE_VERSION, type CourseRecord } from "../core/contracts.ts";
import type { CourseStore } from "../core/ports.ts";

function courseFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid course id: ${id}`);
	return path.join(PATHS.courses, `${id}.json`);
}

function writeCourse(record: CourseRecord): void {
	fs.mkdirSync(PATHS.courses, { recursive: true });
	fs.writeFileSync(courseFile(record.id), JSON.stringify({ ...record, version: CURRENT_COURSE_VERSION }, null, "\t"), "utf-8");
}

function getCourse(id: string): CourseRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(courseFile(id), "utf-8"));
	} catch {
		return null;
	}
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_COURSE_VERSION) {
		console.error(`[course ${id}] record stamped with schema version ${v} > ${CURRENT_COURSE_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return parsed as CourseRecord;
}

export const courseStore: CourseStore = {
	createCourse(title: string): CourseRecord {
		const now = new Date().toISOString();
		const record: CourseRecord = {
			id: `course_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
			title: title.trim() || "Untitled course",
			createdAt: now,
			updatedAt: now,
			status: "new",
			skills: [],
		};
		writeCourse(record);
		emit("courses-changed", {});
		return { ...record, version: CURRENT_COURSE_VERSION };
	},

	getCourse,

	listCourses(): CourseRecord[] {
		try {
			fs.mkdirSync(PATHS.courses, { recursive: true });
			return fs
				.readdirSync(PATHS.courses)
				.filter((f) => f.endsWith(".json"))
				.map((f) => getCourse(f.slice(0, -5)))
				.filter((r): r is CourseRecord => r !== null)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		} catch {
			return [];
		}
	},

	updateCourse(id, patch): CourseRecord | null {
		const record = getCourse(id);
		if (!record) return null;
		const next: CourseRecord = { ...record, ...patch, id: record.id, createdAt: record.createdAt, updatedAt: new Date().toISOString() };
		// an explicit undefined clears the field on disk
		for (const key of Object.keys(next) as (keyof CourseRecord)[]) if (next[key] === undefined) delete next[key];
		writeCourse(next);
		emit("courses-changed", {});
		return next;
	},

	deleteCourse(id: string): boolean {
		try {
			fs.unlinkSync(courseFile(id));
			emit("courses-changed", {});
			return true;
		} catch {
			return false;
		}
	},
};
