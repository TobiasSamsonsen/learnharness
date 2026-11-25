import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	MATERIAL_MAX_BYTES,
	imageMimeType,
	isHardLimitError,
	isMaterialUrl,
	materialKindFor,
	materialsPromptSection,
	readMaterialIds,
	type LessonMaterial,
} from "../core/materials.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { profileMaterial, type MaterialProfile, type MaterialProfileInput } from "../agent/subagents/material-profiler.ts";
import { fetchLink } from "../agent/tools/web.ts";
import { materialTools } from "../agent/tools/materials.ts";
import type { MaterialStore } from "../core/ports.ts";
import { lectureNotesForTurn } from "./lecture-notes.ts";
import { stores } from "./stores.ts";

/**
 * Lesson source material — the service seam (fork addition, 2026-10-24;
 * model: core/materials.ts). Adds uploads and links, profiles each
 * material ONCE in the background (one run per material, through the
 * shared background-LLM permits), and hands each turn its prompt section
 * and lookup tools. A turn waits briefly for profiles still being read.
 *
 * Crash safety: a material left "reading" by a dead process has no live
 * run — any read of the lesson's materials restarts it.
 *
 * OWNERS (courses, fork addition — docs/courses.md §1.2): material
 * belongs to a lesson (a chat id) or to a course (a course id). A course
 * session sees its course's material beside its own (sessionMaterials).
 */

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

interface Run {
	key: string;
	chatId: string;
	materialId: string;
	state: "queued" | "active";
	promise: Promise<void>;
	controller: AbortController;
}

interface QueueEntry {
	key: string;
	chatId: string;
	materialId: string;
	settled: boolean;
	start: () => void;
	failQueued: (reason: string) => void;
}

interface QueueState {
	active: number;
	queue: QueueEntry[];
}

const KEY = Symbol.for("lh.materialRuns");
const QUEUE_KEY = Symbol.for("lh.materialQueue");
const MATERIAL_QUEUE_CONCURRENCY = 2;

/** Test seam for material profiling (parallels safeFetchOverride). */
export const materialProfilerOverride: {
	current?: (input: MaterialProfileInput, opts: { abortSignal: AbortSignal; chatId: string }) => Promise<MaterialProfile>;
} = {};

function runs(): Map<string, Run> {
	const g = globalThis as Record<symbol, Map<string, Run> | undefined>;
	g[KEY] ??= new Map();
	return g[KEY];
}
function queueState(): QueueState {
	const g = globalThis as Record<symbol, QueueState | undefined>;
	g[QUEUE_KEY] ??= { active: 0, queue: [] };
	return g[QUEUE_KEY];
}
const runKey = (chatId: string, id: string) => `${chatId}/${id}`;

function materialQueueLimit(): number {
	const configured = stores.settingsStore.readSettings()?.agent?.workerRequestConcurrency;
	if (typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0) {
		return Math.min(MATERIAL_QUEUE_CONCURRENCY, configured);
	}
	return MATERIAL_QUEUE_CONCURRENCY;
}

function failQueuedForOwner(chatId: string, reason: string): void {
	const state = queueState();
	const rest: QueueEntry[] = [];
	const failed: QueueEntry[] = [];
	for (const entry of state.queue) {
		if (!entry.settled && entry.chatId === chatId) failed.push(entry);
		else rest.push(entry);
	}
	state.queue = rest;
	for (const entry of failed) entry.failQueued(reason);
}

function drainQueue(): void {
	const state = queueState();
	const limit = materialQueueLimit();
	while (state.active < limit && state.queue.length > 0) {
		const entry = state.queue.shift()!;
		const run = runs().get(entry.key);
		if (entry.settled || !run || run.controller.signal.aborted) continue;
		entry.settled = true;
		run.state = "active";
		state.active++;
		entry.start();
	}
}

/** How many materials are being read or queued right now (the idle check reads this). */
export function materialRunCount(): number {
	return runs().size;
}

/** How long a turn waits for profiles still being read. */
const TURN_WAIT_MS = 180_000;

/** A material owner exists: a lesson, or a course. */
function ownerExists(ownerId: string): boolean {
	return stores.chatStore.getChat(ownerId) !== null || stores.courseStore.getCourse(ownerId) !== null;
}

function lessonStarted(chatId: string): boolean {
	return (stores.chatStore.getChat(chatId)?.messages ?? []).some((m) => (m as { role?: string }).role === "assistant");
}

/** Profile one material in the background through the bounded FIFO queue (idempotent per material). */
function startProfile(chatId: string, material: LessonMaterial): Promise<void> {
	const key = runKey(chatId, material.id);
	const live = runs().get(key);
	if (live) return live.promise;
	const controller = new AbortController();
	const { materialStore } = stores;
	let resolveDone!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const run: Run = { key, chatId, materialId: material.id, state: "queued", promise, controller };
	runs().set(key, run);

	const entry: QueueEntry = {
		key,
		chatId,
		materialId: material.id,
		settled: false,
		failQueued: (reason: string) => {
			if (entry.settled) return;
			entry.settled = true;
			if (!controller.signal.aborted) {
				materialStore.update(chatId, material.id, { status: "error", error: reason });
			}
			runs().delete(key);
			resolveDone();
		},
		start: () => {
			void (async () => {
				try {
					const input: MaterialProfileInput = {
						kind: material.kind,
						name: material.name,
						path: materialStore.filePath(chatId, material),
						mimeType: material.mimeType,
					};
					let result: MaterialProfile;
					if (materialProfilerOverride.current) {
						result = await materialProfilerOverride.current(input, { abortSignal: controller.signal, chatId });
					} else {
						const spec = resolveRoleSpec("pdfReader", stores.settingsStore.readSettings());
						if (!spec) {
							const msg = "no vision model is configured (Settings → Agent: the vision slot reads source material)";
							materialStore.update(chatId, material.id, { status: "error", error: msg });
							failQueuedForOwner(chatId, msg);
							return;
						}
						// The profiler's model requests pass the process-wide worker-request admission (the one background-LLM pool).
						result = await profileMaterial(input, { engine: piEngineForSpec(spec), abortSignal: controller.signal, chatId });
					}
					if (controller.signal.aborted) return;
					if (result.transcript !== undefined) {
						fs.writeFileSync(materialStore.auxPath(chatId, material.id, "content.md"), result.transcript, "utf8");
					}
					materialStore.update(chatId, material.id, {
						status: "ready",
						profile: result.profile,
						...(result.pages !== undefined ? { pages: result.pages } : {}),
						error: undefined,
					});
				} catch (err) {
					if (controller.signal.aborted) return; // removed while reading
					const msg = err instanceof Error ? err.message : String(err);
					materialStore.update(chatId, material.id, { status: "error", error: msg });
					if (isHardLimitError(msg)) failQueuedForOwner(chatId, msg);
				}
			})().finally(() => {
				queueState().active--;
				runs().delete(key);
				resolveDone();
				drainQueue();
			});
		},
	};

	controller.signal.addEventListener(
		"abort",
		() => {
			if (entry.settled) return;
			entry.settled = true;
			const q = queueState().queue;
			const idx = q.indexOf(entry);
			if (idx >= 0) q.splice(idx, 1);
			runs().delete(key);
			resolveDone();
		},
		{ once: true },
	);

	queueState().queue.push(entry);
	drainQueue();
	return promise;
}

/** The lesson's materials — restarting any read a dead process left behind. */
export function listMaterials(chatId: string): LessonMaterial[] {
	const materials = stores.materialStore.list(chatId);
	for (const m of materials) if (m.status === "reading" && !runs().has(runKey(chatId, m.id))) void startProfile(chatId, m);
	// Source files do not sync (owner decision, 2026-11-02): a material that arrived from another device has no original here.
	return materials.map((m) => {
		if (m.status === "reading") {
			return runs().get(runKey(chatId, m.id))?.state === "queued" ? { ...m, queued: true } : m;
		}
		return !fs.existsSync(stores.materialStore.filePath(chatId, m)) ? { ...m, originalElsewhere: true } : m;
	});
}

/** Add an uploaded file. */
export function addUploadedMaterial(
	chatId: string,
	file: { name: string; type: string; bytes: Uint8Array },
): Result<LessonMaterial> {
	if (!ownerExists(chatId)) return { ok: false, status: 404, error: "Unknown chat or course" };
	const kind = materialKindFor(file.name, file.type);
	if (!kind) return { ok: false, status: 415, error: `Unsupported file type: ${file.name} (PDF, text, Markdown or an image)` };
	if (file.bytes.byteLength === 0) return { ok: false, status: 400, error: `${file.name} is empty` };
	if (file.bytes.byteLength > MATERIAL_MAX_BYTES) {
		return { ok: false, status: 413, error: `${file.name} is larger than ${MATERIAL_MAX_BYTES / 1024 / 1024} MB` };
	}
	const material = stores.materialStore.add(chatId, {
		kind,
		name: path.basename(file.name),
		ext: path.extname(file.name) || (kind === "pdf" ? ".pdf" : kind === "text" ? ".txt" : ".png"),
		bytes: file.bytes,
		mimeType: kind === "image" ? (file.type.startsWith("image/") ? file.type : imageMimeType(file.name)) : file.type || undefined,
		addedMidLesson: lessonStarted(chatId),
	});
	void startProfile(chatId, material);
	return { ok: true, value: material };
}

/** Add a web page: fetched once, stored as its extracted Markdown. */
export async function addLinkMaterial(chatId: string, url: string): Promise<Result<LessonMaterial>> {
	if (!ownerExists(chatId)) return { ok: false, status: 404, error: "Unknown chat or course" };
	if (!isMaterialUrl(url)) return { ok: false, status: 400, error: "The link must be an http(s) address" };
	let link: Awaited<ReturnType<typeof fetchLink>>;
	try {
		link = await fetchLink(url.trim());
	} catch (err) {
		return { ok: false, status: 502, error: `Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}` };
	}
	if ("pdf" in link) {
		// A link to a PDF is the PDF itself (2026-11-18): kept as the file, read like an upload. It used to be stored as web_fetch's
		// "this URL is a PDF" sentence, which the PDF reader then rejected as an invalid PDF.
		if (link.pdf.byteLength === 0) return { ok: false, status: 422, error: `${url} is an empty PDF` };
		const pdfUrl = new URL(url.trim());
		const last = decodeURIComponent(pdfUrl.pathname.split("/").filter(Boolean).pop() ?? "");
		const fileName = (last || pdfUrl.host).replace(/[\\/:*?"<>|]+/g, "_");
		const pdf = stores.materialStore.add(chatId, {
			kind: "pdf",
			name: (/\.pdf$/i.test(fileName) ? fileName : `${fileName}.pdf`).slice(0, 120),
			ext: ".pdf",
			bytes: link.pdf,
			url: url.trim(),
			mimeType: "application/pdf",
			addedMidLesson: lessonStarted(chatId),
		});
		void startProfile(chatId, pdf);
		return { ok: true, value: pdf };
	}
	const markdown = link.text;
	if (!markdown.trim()) return { ok: false, status: 422, error: `${url} has no readable text` };
	const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
	const u = new URL(url.trim());
	const material = stores.materialStore.add(chatId, {
		kind: "web",
		name: (title ?? `${u.host}${u.pathname === "/" ? "" : u.pathname}`).slice(0, 120),
		ext: ".md",
		bytes: new TextEncoder().encode(markdown),
		url: url.trim(),
		mimeType: "text/markdown",
		addedMidLesson: lessonStarted(chatId),
	});
	void startProfile(chatId, material);
	return { ok: true, value: material };
}

/** Remove one material, stopping its read if one is running. */
export function removeMaterial(chatId: string, id: string): boolean {
	runs().get(runKey(chatId, id))?.controller.abort();
	return stores.materialStore.remove(chatId, id);
}

/** Retry reading one failed material whose original file is stored locally. */
export function retryMaterial(chatId: string, id: string): Result<LessonMaterial> {
	if (!ownerExists(chatId)) return { ok: false, status: 404, error: "Unknown chat or course" };
	const material = stores.materialStore.list(chatId).find((m) => m.id === id);
	if (!material) return { ok: false, status: 404, error: "Unknown material" };
	if (material.status === "reading") {
		void startProfile(chatId, material);
		return { ok: true, value: material };
	}
	if (material.status === "ready") return { ok: true, value: material };
	if (!fs.existsSync(stores.materialStore.filePath(chatId, material))) {
		return { ok: false, status: 409, error: "Original file is on another device and cannot be re-read here" };
	}
	const updated = stores.materialStore.update(chatId, id, { status: "reading", error: undefined })!;
	void startProfile(chatId, updated);
	return { ok: true, value: updated };
}

/** Retry all failed materials for an owner whose original files are stored locally. */
export function retryFailedMaterials(chatId: string): Result<LessonMaterial[]> {
	if (!ownerExists(chatId)) return { ok: false, status: 404, error: "Unknown chat or course" };
	const failed = stores.materialStore
		.list(chatId)
		.filter((m) => m.status === "error" && fs.existsSync(stores.materialStore.filePath(chatId, m)));
	const updated = failed
		.map((m) => stores.materialStore.update(chatId, m.id, { status: "reading", error: undefined }))
		.filter((m): m is LessonMaterial => m !== null);
	for (const m of updated) void startProfile(chatId, m);
	return { ok: true, value: updated };
}

/** Wait (bounded) until no material of the lesson is still being read. */
export async function waitForMaterials(chatId: string, timeoutMs = TURN_WAIT_MS): Promise<void> {
	const pending = listMaterials(chatId)
		.filter((m) => m.status === "reading")
		.map((m) => runs().get(runKey(chatId, m.id))?.promise)
		.filter((p): p is Promise<void> => !!p);
	if (pending.length === 0) return;
	await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

/** A session's material store: the lesson's own, plus — for a course
 *  session — its course's, routed by material id (ids are unique). Only
 *  the reads the lookup tools use are routed; writes go to the lesson. */
export function sessionMaterials(chatId: string): MaterialStore {
	const base = stores.materialStore;
	const courseId = stores.chatStore.getChat(chatId)?.course?.courseId;
	if (!courseId || !stores.courseStore.getCourse(courseId)) return base;
	const ownerOf = (id: string) => (base.list(courseId).some((m) => m.id === id) ? courseId : chatId);
	return {
		...base,
		list: () => [...listMaterials(courseId), ...listMaterials(chatId)],
		filePath: (_owner, m) => base.filePath(ownerOf(m.id), m),
		auxPath: (_owner, id, name) => base.auxPath(ownerOf(id), id, name),
	};
}

/** A turn's view of the lesson's material: the prompt section and the
 *  lookup tools; undefined when the lesson has none. A course session
 *  also sees its course's material. */
export function materialsForTurn(chatId: string): { section: string; tools: AgentTool<any>[] } | undefined {
	const sources = sourceMaterialsForTurn(chatId);
	const notes = lectureNotesForTurn(chatId);
	if (!notes) return sources;
	if (!sources) return notes;
	return { section: `${sources.section}\n\n${notes.section}`, tools: [...sources.tools, ...notes.tools] };
}

function sourceMaterialsForTurn(chatId: string): { section: string; tools: AgentTool<any>[] } | undefined {
	const store = sessionMaterials(chatId);
	const materials = store === stores.materialStore ? listMaterials(chatId) : store.list(chatId);
	// the teacher's last message: material newer than it is announced once
	const messages = stores.chatStore.getChat(chatId)?.messages ?? [];
	const lastAssistant = [...messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
		| { timestamp?: number }
		| undefined;
	// catalog mode pins what this conversation has read (core/materials.ts), from the stored tool calls
	const section = materialsPromptSection(materials, (m) => store.filePath(chatId, m), lastAssistant?.timestamp, readMaterialIds(messages, materials));
	if (!section) return undefined;
	return { section, tools: Object.values(materialTools({ chatId, store })) };
}
