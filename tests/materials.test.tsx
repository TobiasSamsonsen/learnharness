/**
 * Lesson source material (fork addition, 2026-10-24): the pure core, the
 * on-disk store, the lookup tools (text + the committed PDF fixture), the
 * profiler against a scripted model, the service's refusals, the agent
 * seam, and the Sources pill's render. No network; LH_DATA_DIR isolates.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers";
// the shared layers need their provider (AppShell mounts it; renders here have no shell)
const renderToStaticMarkup = (node: React.ReactElement) => renderBare(<InteractionLayersProvider>{node}</InteractionLayersProvider>);
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { LessonMaterial } from "../src/core/materials.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-materials-"));
process.env.LH_DATA_DIR = TMP_DATA;

const core = await import("../src/core/materials.ts");
const { materialStore } = await import("../src/store/materials.ts");
const { materialTools, lineRange } = await import("../src/agent/tools/materials.ts");
const { profileMaterial, splitImageReply } = await import("../src/agent/subagents/material-profiler.ts");
const { configureWorkerRequestAdmission } = await import("../src/agent/worker-request-admission.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { chatStore } = await import("../src/store/chats.ts");
const service = await import("../src/server/materials.ts");
const { MaterialsControl, materialStatusLine, sourcesLabel } = await import("../components/materials-control.tsx");
const { draftMaterials, retryMaterials, uploadFiles } = await import("../components/materials-client.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const FIXTURE_PDF = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const NOTES = "# Kapittel 1: Derivasjon\n\nDefinisjon: den deriverte f'(a) er grensen av differensekvotienten.\n\nOppgave 1.1: Deriver x^2.";

/** Run one tool's execute and return its text. */
async function call(tool: { execute: (...a: never[]) => Promise<unknown> }, args: unknown): Promise<string> {
	const result = (await (tool.execute as (id: string, a: unknown) => Promise<{ content: { text: string }[] }>)("c1", args)) as {
		content: { text: string }[];
	};
	return result.content.map((c) => c.text).join("");
}

describe("the core", () => {
	it("tells kinds apart by extension, then MIME", () => {
		assert.equal(core.materialKindFor("Book.PDF"), "pdf");
		assert.equal(core.materialKindFor("notes.md"), "text");
		assert.equal(core.materialKindFor("page.jpeg"), "image");
		assert.equal(core.materialKindFor("blob", "image/webp"), "image");
		assert.equal(core.materialKindFor("slides.pptx"), null);
		assert.ok(core.isMaterialUrl("https://example.org/a"));
		assert.equal(core.isMaterialUrl("file:///etc/passwd"), false);
	});

	it("the prompt section carries the rules, each profile, and honest statuses", () => {
		assert.equal(core.materialsPromptSection([], () => ""), undefined);
		const base = { kind: "pdf" as const, file: "source.pdf", bytes: 1, addedAt: "t" };
		const section = core.materialsPromptSection(
			[
				{ ...base, id: "mat_a", name: "Kalkulus.pdf", pages: 300, status: "ready", profile: "## Scope and targets\n- derivere (p. 12)" },
				{ ...base, id: "mat_b", name: "Notes.pdf", status: "reading", addedMidLesson: true, addedAt: "2026-02-01T00:00:00Z" },
				{ ...base, id: "mat_c", name: "Broken.pdf", status: "error", error: "encrypted" },
			],
			(m) => `/data/${m.id}/source.pdf`,
			Date.parse("2026-01-01T00:00:00Z"),
		)!;
		assert.match(section, /^<source_material>\n/);
		assert.match(section, /TARGET AND SCOPE/);
		assert.match(section, /you may explain things your own way/);
		assert.match(section, /teach in a different order than the material, as long as all its targets are met/);
		assert.match(section, /Say explicitly when you go beyond the material/);
		assert.match(section, /<material id="mat_a" name="Kalkulus.pdf" kind="PDF, 300 pages" path="\/data\/mat_a\/source.pdf">\n## Scope and targets/);
		assert.match(section, /Still being read/);
		assert.match(section, /could not be built: encrypted/);
		assert.match(section, /Just added by the learner: "Notes.pdf"/);
		assert.match(section, /name="Notes.pdf"[^>]*added="during the lesson"/);
		// once the teacher has answered after the addition, the note is gone
		const later = core.materialsPromptSection(
			[{ ...base, id: "mat_b", name: "Notes.pdf", status: "ready", profile: "P", addedMidLesson: true, addedAt: "2026-02-01T00:00:00Z" }],
			() => "p",
			Date.parse("2026-03-01T00:00:00Z"),
		)!;
		assert.doesNotMatch(later, /Just added/);
	});

	describe("the catalog (owner, 2026-11-19)", () => {
		const PROFILE = (tag: string, pad = 0) =>
			`Intro line\n## Scope and targets\n- target ${tag} (p. 1)\n\n## Contents\n- topic ${tag} (p. 2-5)\n\n## Definitions and terminology\n- term ${tag}: x${"y".repeat(pad)}\n\n## Notation and conventions\n- symbol ${tag}\n\n## Approach and order\n- order ${tag}\n\n## Exercises\n- ex ${tag}`;
		const mat = (id: string, profile: string): LessonMaterial => ({
			id, kind: "pdf", name: `${id}.pdf`, file: "source.pdf", bytes: 1, addedAt: "t", status: "ready", profile,
		});
		const many = (n: number, pad: number) => Array.from({ length: n }, (_, i) => mat(`mat_${i}`, PROFILE(String(i), pad)));
		const section = (ms: LessonMaterial[], pinned?: Set<string>) => core.materialsPromptSection(ms, () => "p", undefined, pinned)!;

		it("a catalog entry is Scope and Contents only, and capped", () => {
			const entry = core.catalogEntry(PROFILE("a"));
			assert.match(entry, /## Scope and targets/);
			assert.match(entry, /## Contents/);
			assert.doesNotMatch(entry, /Definitions|Notation|Exercises|Intro line/);
			// no recognisable headings: the start of the profile instead
			assert.equal(core.catalogEntry("plain profile text"), "plain profile text");
			const long = core.catalogEntry(`## Contents\n${"- a line of contents\n".repeat(200)}`);
			assert.ok(long.length <= core.CATALOG_CONTENTS_CHARS + 2);
			assert.match(long, /…$/);
			// a long Scope never crowds out the page references
			const both = core.catalogEntry(`## Scope and targets\n${"- a long target line\n".repeat(100)}\n## Contents\n- p. 1: Title.\n- p. 2: Theorem.`);
			assert.match(both, /## Scope and targets/);
			assert.match(both, /- p\. 2: Theorem\.$/);
			assert.ok(both.length <= core.CATALOG_ENTRY_CHARS + 20);
			// no headings and a long profile: the start, capped
			assert.ok(core.catalogEntry("z\n".repeat(2000)).length <= core.CATALOG_ENTRY_CHARS + 2);
		});

		it("definitions and notation are cut out, or null", () => {
			const dn = core.definitionsAndNotation(PROFILE("a"))!;
			assert.match(dn, /## Definitions and terminology/);
			assert.match(dn, /## Notation and conventions/);
			assert.doesNotMatch(dn, /Scope|Exercises/);
			assert.equal(core.definitionsAndNotation("## Contents\n- x"), null);
		});

		it("under the threshold every profile rides in full, as before", () => {
			const s = section(many(3, 100));
			assert.match(s, /LOOK IT UP/);
			assert.doesNotMatch(s, /CATALOG:/);
			assert.match(s, /## Exercises\n- ex 2/);
		});

		it("over the threshold the sources become catalog entries under the catalog rules", () => {
			const s = section(many(30, 1000));
			assert.match(s, /CATALOG:/);
			assert.doesNotMatch(s, /LOOK IT UP/);
			assert.match(s, /TARGET AND SCOPE/);
			assert.match(s, /## Contents\n- topic 29/);
			assert.doesNotMatch(s, /term 29/);
			assert.doesNotMatch(s, /## Exercises/);
		});

		it("the threshold is on the combined profile size, both sides of the limit", () => {
			const one = (n: number) => [mat("mat_x", "y".repeat(n))];
			assert.doesNotMatch(section(one(core.CATALOG_THRESHOLD_CHARS)), /CATALOG:/);
			assert.match(section(one(core.CATALOG_THRESHOLD_CHARS + 1)), /CATALOG:/);
		});

		it("a pinned source keeps its full profile; pinned sources over the cap keep definitions and notation only", () => {
			const ms = many(30, 1000);
			const s = section(ms, new Set(["mat_3"]));
			assert.match(s, /term 3:/);
			assert.match(s, /## Exercises\n- ex 3/);
			assert.doesNotMatch(s, /term 4:/);
			// every source pinned: the full profiles alone pass the threshold
			const all = section(ms, new Set(ms.map((m) => m.id)));
			assert.match(all, /term 29:/);
			assert.match(all, /symbol 29/);
			assert.doesNotMatch(all, /## Exercises/);
			assert.doesNotMatch(all, /## Approach and order/);
		});

		it("unready sources keep their honest status in catalog mode", () => {
			const ms = [...many(30, 1000), { ...mat("mat_r", ""), status: "reading" as const, profile: undefined }];
			assert.match(section(ms), /Still being read/);
		});

		it("which sources a conversation has read comes from its stored tool calls", () => {
			const ms = [mat("mat_a", "p"), mat("mat_b", "p"), mat("mat_c", "p")];
			const call = (name: string, args: unknown) => ({ role: "assistant", content: [{ type: "toolCall", id: "1", name, arguments: args }] });
			const got = core.readMaterialIds(
				[
					call("material_read", { material: "mat_a", pages: "1" }),
					call("material_search", { query: "x" }), // across everything: pins nothing
					call("material_search", { query: "x", material: "mat_b.pdf" }), // by name
					call("material_read", { material: "nope" }), // unknown: ignored
					call("plan_init", { material: "mat_c" }), // not a lookup tool
					{ role: "user", content: "hi" },
				],
				ms,
			);
			assert.deepEqual([...got].sort(), ["mat_a", "mat_b"]);
		});
	});
});

describe("the store", () => {
	it("stores a copy, indexes it, updates, and removes", () => {
		const m = materialStore.add("chat_store", { kind: "text", name: "notes.md", ext: ".md", bytes: new TextEncoder().encode(NOTES) });
		assert.match(m.id, /^mat_[0-9a-f]{12}$/);
		assert.equal(m.status, "reading");
		assert.equal(fs.readFileSync(materialStore.filePath("chat_store", m), "utf8"), NOTES);
		materialStore.update("chat_store", m.id, { status: "ready", profile: "P" });
		assert.equal(materialStore.list("chat_store")[0]?.profile, "P");
		assert.equal(materialStore.remove("chat_store", m.id), true);
		assert.deepEqual(materialStore.list("chat_store"), []);
		assert.equal(fs.existsSync(path.dirname(materialStore.filePath("chat_store", m))), false);
	});

	it("refuses ids that could walk out of the folder", () => {
		assert.throws(() => materialStore.list("../escape"), /invalid chat id/);
		assert.throws(() => materialStore.auxPath("chat_x", "../../x", "a"), /invalid material id/);
	});
});

describe("the lookup tools", () => {
	const chatId = "chat_tools";
	const text = materialStore.add(chatId, { kind: "text", name: "notes.md", ext: ".md", bytes: new TextEncoder().encode(NOTES) });
	const pdf = materialStore.add(chatId, { kind: "pdf", name: "sample.pdf", ext: ".pdf", bytes: fs.readFileSync(FIXTURE_PDF) });
	const tools = materialTools({ chatId, store: materialStore });

	it("search finds text lines and PDF pages, with the material named", async () => {
		const out = await call(tools.material_search!, { query: "definisjon" });
		assert.match(out, /\[notes.md, line 3\]\n {4}# Kapittel 1[\s\S]*>>> Definisjon/, "context lines, then the hit");
		const pdfOut = await call(tools.material_search!, { query: "force", literal: true });
		assert.match(pdfOut, /\[sample.pdf, p\. 2\]/);
		assert.match(await call(tools.material_search!, { query: "zymurgy" }), /No matches/);
		assert.match(await call(tools.material_search!, { query: "x", material: "nope" }), /No material "nope"/);
	});

	it("read returns PDF pages and numbered text lines", async () => {
		assert.match(await call(tools.material_read!, { material: pdf.id, pages: "2" }), /force/i);
		const lines = await call(tools.material_read!, { material: "notes.md", lines: "5-5" });
		assert.match(lines, /^\[notes.md, lines 5-5 of 5\]\n5: Oppgave 1\.1/);
		assert.deepEqual(lineRange(undefined, 1000), [1, 200]);
		assert.deepEqual(lineRange("10-5", 50), [10, 10]);
		void text;
	});
});

describe("a material whose original is on another device (it arrived by sync)", () => {
	const chatId = "chat_elsewhere";
	const m = materialStore.add(chatId, { kind: "pdf", name: "away.pdf", ext: ".pdf", bytes: fs.readFileSync(FIXTURE_PDF) });
	fs.rmSync(materialStore.filePath(chatId, m)); // sync carries the index and profile, not the original
	const tools = materialTools({ chatId, store: materialStore });

	it("search and read say so plainly instead of failing with a file error", async () => {
		assert.match(await call(tools.material_search!, { query: "force", literal: true }), /\[away\.pdf\] its original file is on another device/);
		assert.match(await call(tools.material_read!, { material: m.id, pages: "1" }), /original file is on another device/);
	});

	it("is marked in the status line", () => {
		assert.equal(materialStatusLine({ ...m, status: "ready", pages: 3, originalElsewhere: true }), "3 pages · original on another device");
		assert.equal(materialStatusLine({ ...m, status: "ready", pages: 3 }), "3 pages");
	});
});

describe("the profiler", () => {
	const engine = (reply: string) => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage(reply)]);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	};

	it("profiles text with one model call", async () => {
		const file = path.join(TMP_DATA, "p.md");
		fs.writeFileSync(file, NOTES);
		const out = await profileMaterial({ kind: "text", name: "p.md", path: file }, { engine: engine("## Scope and targets\n- derivere") });
		assert.equal(out.profile, "## Scope and targets\n- derivere");
	});

	it("splits an image reply into transcription and profile", async () => {
		assert.deepEqual(splitImageReply("Tekst på tavla\n=== PROFILE ===\n## Scope"), { transcript: "Tekst på tavla", profile: "## Scope" });
		const img = path.join(TMP_DATA, "board.png");
		fs.writeFileSync(img, Buffer.from("89504e470d0a1a0a", "hex"));
		const out = await profileMaterial({ kind: "image", name: "board.png", path: img, mimeType: "image/png" }, { engine: engine("$x^2$\n=== PROFILE ===\n## Notation") });
		assert.equal(out.transcript, "$x^2$");
		assert.equal(out.profile, "## Notation");
	});

	it("the reader's remarks before the first section are trimmed off", async () => {
		const { profileBody } = await import("../src/agent/subagents/material-profiler.ts");
		assert.equal(profileBody("The earlier brief did rest on reading.\n\n## Scope and targets\n- T1"), "## Scope and targets\n- T1");
		assert.equal(profileBody("No headings at all."), "No headings at all.");
	});

	it("an empty text is refused, not profiled", async () => {
		const file = path.join(TMP_DATA, "empty.md");
		fs.writeFileSync(file, "  \n");
		await assert.rejects(profileMaterial({ kind: "text", name: "empty.md", path: file }, { engine: engine("x") }), /empty/);
	});
});

describe("the service", () => {
	it("refuses unknown lessons and unsupported files", () => {
		assert.equal(service.addUploadedMaterial("chat_missing", { name: "a.pdf", type: "", bytes: new Uint8Array(1) }).ok, false);
		const chat = chatStore.createChat("Materials");
		const bad = service.addUploadedMaterial(chat.id, { name: "deck.pptx", type: "", bytes: new Uint8Array(1) });
		assert.equal(bad.ok, false);
		assert.equal(bad.ok ? 0 : bad.status, 415);
	});

	it("without a vision model the read fails honestly — the file still serves the tools", async () => {
		const chat = chatStore.createChat("No vision");
		const added = service.addUploadedMaterial(chat.id, { name: "notes.md", type: "text/markdown", bytes: new TextEncoder().encode(NOTES) });
		assert.ok(added.ok);
		await service.waitForMaterials(chat.id, 5000);
		const [m] = service.listMaterials(chat.id);
		assert.equal(m?.status, "error");
		assert.match(m?.error ?? "", /no vision model is configured/);
		const turn = service.materialsForTurn(chat.id)!;
		assert.match(turn.section, /could not be built/);
		assert.deepEqual(turn.tools.map((t) => t.name).sort(), ["material_read", "material_search"]);
		assert.equal(added.ok && added.value.addedMidLesson, undefined, "a lesson with no turns yet: not mid-lesson");
	});
});

describe("a link to a PDF (2026-11-18)", () => {
	it("is stored as the PDF itself, named from the link, not as web_fetch's pointer sentence", async () => {
		const { safeFetchOverride } = await import("../src/agent/tools/safe-fetch.ts");
		const chat = chatStore.createChat("PDF link");
		const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n");
		safeFetchOverride.current = (async () => new Response(bytes, { headers: { "content-type": "application/pdf" } })) as typeof fetch;
		try {
			const added = await service.addLinkMaterial(chat.id, "https://wiki.example.org/_media/tma4400/43.1_presentasjon_6_.pdf");
			assert.ok(added.ok, "the link is accepted");
			if (!added.ok) return;
			assert.equal(added.value.kind, "pdf");
			assert.equal(added.value.name, "43.1_presentasjon_6_.pdf");
			assert.equal(added.value.file, "source.pdf");
			assert.equal(added.value.url, "https://wiki.example.org/_media/tma4400/43.1_presentasjon_6_.pdf");
			assert.equal(fs.readFileSync(materialStore.filePath(chat.id, added.value)).subarray(0, 5).toString(), "%PDF-");
			await service.waitForMaterials(chat.id, 5000);
		} finally {
			safeFetchOverride.current = undefined;
		}
	});

	it("a page link is still stored as the page's text", async () => {
		const { safeFetchOverride } = await import("../src/agent/tools/safe-fetch.ts");
		const chat = chatStore.createChat("Page link");
		safeFetchOverride.current = (async () => new Response(NOTES.repeat(4), { headers: { "content-type": "text/plain" } })) as typeof fetch;
		try {
			const added = await service.addLinkMaterial(chat.id, "https://example.org/notes");
			assert.ok(added.ok && added.value.kind === "web" && added.value.file === "source.md");
			await service.waitForMaterials(chat.id, 5000);
		} finally {
			safeFetchOverride.current = undefined;
		}
	});
});

describe("the agent seam", () => {
	it("the section joins the prompt and the tools join the registry", () => {
		const faux = createFauxCore({});
		const agent = createTeacherAgent(undefined, {
			engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			materials: { section: "<source_material>\nSECTION\n</source_material>", tools: Object.values(materialTools({ chatId: "chat_tools", store: materialStore })) },
		});
		assert.match(agent.state.systemPrompt, /<source_material>\nSECTION\n<\/source_material>\n\n<lesson_language>/);
		assert.ok(agent.state.tools.some((t) => t.name === "material_search"));
	});
});

describe("the Sources pill", () => {
	it("labels and status lines", () => {
		assert.equal(sourcesLabel(0, 0), "Sources");
		assert.equal(sourcesLabel(2, 0), "Sources · 2");
		assert.equal(sourcesLabel(2, 1), "Reading 1…");
		const m = { id: "mat_x", kind: "pdf" as const, name: "b.pdf", file: "source.pdf", bytes: 1, addedAt: "t" };
		assert.equal(materialStatusLine({ ...m, status: "ready", pages: 12 }), "12 pages");
		assert.equal(materialStatusLine({ ...m, status: "reading" }), "reading…");
		assert.equal(materialStatusLine({ ...m, status: "error", error: "encrypted" }), "not read — encrypted");
	});

	it("renders in draft mode with the draft's count", () => {
		draftMaterials.clear();
		assert.match(renderToStaticMarkup(<MaterialsControl />), /data-testid="stats-materials"[\s\S]*Sources</);
	});
});

describe("uploadFiles (one file per request, 2026-10-25)", () => {
	/** A fetch fake: records each request's file names; `fail` names get a 415. */
	function fakeFetch(fail: string[] = []) {
		const sent: string[][] = [];
		const fetchLike = (async (_url: string, init: { body: FormData }) => {
			const names = init.body.getAll("file").map((f) => (f as File).name);
			sent.push(names);
			return names.some((n) => fail.includes(n))
				? Response.json({ error: `${names[0]} is not a supported type` }, { status: 415 })
				: Response.json({ materials: [] }, { status: 201 });
		}) as unknown as typeof fetch;
		return { sent, fetchLike };
	}
	const file = (name: string) => new File(["x"], name);

	it("sends each file in its own request", async () => {
		const { sent, fetchLike } = fakeFetch();
		assert.equal(await uploadFiles("course_x", [file("a.pdf"), file("b.pdf")], fetchLike), null);
		assert.deepEqual(sent, [["a.pdf"], ["b.pdf"]]);
	});

	it("refuses a file over the ceiling without sending it, and still sends the rest", async () => {
		const big = file("huge.pdf");
		Object.defineProperty(big, "size", { value: core.MATERIAL_MAX_BYTES + 1 });
		const { sent, fetchLike } = fakeFetch();
		assert.equal(await uploadFiles("course_x", [big, file("ok.pdf")], fetchLike), "huge.pdf is larger than 100 MB");
		assert.deepEqual(sent, [["ok.pdf"]]);
	});

	it("reports every failure and keeps going past one", async () => {
		const { sent, fetchLike } = fakeFetch(["a.exe", "c.exe"]);
		const error = await uploadFiles("course_x", [file("a.exe"), file("b.pdf"), file("c.exe")], fetchLike);
		assert.equal(error, "a.exe is not a supported type; c.exe is not a supported type");
		assert.equal(sent.length, 3);
	});
});

describe("hard-limit classifier, profiler admission, queue, fail-fast, and retry", () => {
	it("isHardLimitError recognizes plan/quota/auth stops and ignores single-file or transient errors", () => {
		assert.equal(core.isHardLimitError("the reader crashed — You've hit your limit · resets 8pm"), true);
		assert.equal(core.isHardLimitError("Claude usage limit reached"), true);
		assert.equal(core.isHardLimitError("402 insufficient_quota: credit balance is too low"), true);
		assert.equal(core.isHardLimitError("401 invalid api key"), true);
		assert.equal(core.isHardLimitError("no vision model is configured"), true);

		assert.equal(core.isHardLimitError("Bad encoding in flate stream"), false);
		assert.equal(core.isHardLimitError("Illegal character: 41"), false);
		assert.equal(core.isHardLimitError("encrypted"), false);
		assert.equal(core.isHardLimitError("the material is empty"), false);
		assert.equal(core.isHardLimitError("503 overloaded_error"), false);
	});

	it("completeOnce routes through workerRequestStream and forwards maxRetries: 3", async () => {
		const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
		const faux = createFauxCore({});
		const baseModel = faux.getModel();
		let inFlight = 0;
		let maxInFlight = 0;
		const seenMaxRetries: unknown[] = [];
		let idx = 0;
		const streamFn: typeof faux.streamSimple = (_model, _ctx, opts) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			seenMaxRetries.push((opts as { maxRetries?: unknown } | undefined)?.maxRetries);
			const stream = new AssistantMessageEventStream();
			const n = ++idx;
			setTimeout(() => {
				inFlight--;
				const msg = fauxAssistantMessage(`## Scope\n- ok${n}`);
				stream.push({ type: "done", reason: "stop", message: msg });
				stream.end(msg);
			}, 25);
			return stream;
		};
		configureWorkerRequestAdmission(() => 1);
		try {
			const f1 = path.join(TMP_DATA, "c1.md");
			const f2 = path.join(TMP_DATA, "c2.md");
			fs.writeFileSync(f1, "text 1");
			fs.writeFileSync(f2, "text 2");
			const [r1, r2] = await Promise.all([
				profileMaterial({ kind: "text", name: "c1.md", path: f1 }, { engine: { model: baseModel, streamFn } }),
				profileMaterial({ kind: "text", name: "c2.md", path: f2 }, { engine: { model: baseModel, streamFn } }),
			]);
			assert.equal(r1.profile, "## Scope\n- ok1");
			assert.equal(r2.profile, "## Scope\n- ok2");
			assert.equal(maxInFlight, 1);
			assert.deepEqual(seenMaxRetries, [3, 3]);
		} finally {
			configureWorkerRequestAdmission(() => 8);
		}
	});

	it("queues material reads at most 2 at a time in FIFO order, derives queued, and cancels queued removals", async () => {
		const chat = chatStore.createChat("Queue cap");
		const started: string[] = [];
		let active = 0;
		let maxActive = 0;
		const gates = new Map<string, () => void>();
		service.materialProfilerOverride.current = (input) => {
			started.push(input.name);
			active++;
			maxActive = Math.max(maxActive, active);
			return new Promise((resolve) => {
				gates.set(input.name, () => {
					active--;
					resolve({ profile: `## Scope\n- ${input.name}` });
				});
			});
		};
		try {
			const added = ["1.md", "2.md", "3.md", "4.md"].map((name) =>
				service.addUploadedMaterial(chat.id, { name, type: "text/markdown", bytes: new TextEncoder().encode(`content ${name}`) }),
			);
			assert.ok(added.every((r) => r.ok));
			await new Promise((r) => setTimeout(r, 15));
			assert.equal(maxActive, 2);
			assert.deepEqual(started, ["1.md", "2.md"]);

			const listed = service.listMaterials(chat.id);
			assert.equal(listed.find((m) => m.name === "1.md")?.queued, undefined);
			assert.equal(listed.find((m) => m.name === "2.md")?.queued, undefined);
			assert.equal(listed.find((m) => m.name === "3.md")?.queued, true);
			assert.equal(listed.find((m) => m.name === "4.md")?.queued, true);

			// Cancel queued 3.md before it starts
			const m3 = listed.find((m) => m.name === "3.md")!;
			assert.equal(service.removeMaterial(chat.id, m3.id), true);

			gates.get("1.md")!();
			await new Promise((r) => setTimeout(r, 15));
			assert.deepEqual(started, ["1.md", "2.md", "4.md"]);

			gates.get("2.md")!();
			gates.get("4.md")!();
			await service.waitForMaterials(chat.id, 5000);
			assert.equal(service.materialRunCount(), 0);
			const done = service.listMaterials(chat.id);
			assert.equal(done.length, 3);
			assert.ok(done.every((m) => m.status === "ready"));
		} finally {
			service.materialProfilerOverride.current = undefined;
			await service.waitForMaterials(chat.id, 1000);
		}
	});

	it("fails fast on hard limit error for queued items, but keeps going past single-file errors", async () => {
		const chat = chatStore.createChat("Fail fast");
		const started: string[] = [];
		const limitMsg = "the reader crashed — You've hit your limit · resets 8pm";
		service.materialProfilerOverride.current = async (input) => {
			started.push(input.name);
			await new Promise((r) => setTimeout(r, 20));
			if (input.name === "a.md") throw new Error(limitMsg);
			return { profile: `## Scope\n- ${input.name}` };
		};
		try {
			for (const name of ["a.md", "b.md", "c.md", "d.md"]) {
				service.addUploadedMaterial(chat.id, { name, type: "text/markdown", bytes: new TextEncoder().encode(`body ${name}`) });
			}
			await service.waitForMaterials(chat.id, 5000);
			// a.md and b.md ran concurrently; c.md and d.md were queued and failed fast without running
			assert.deepEqual(started, ["a.md", "b.md"]);
			const afterLimit = service.listMaterials(chat.id);
			assert.equal(afterLimit.find((m) => m.name === "b.md")?.status, "ready");
			assert.equal(afterLimit.find((m) => m.name === "a.md")?.status, "error");
			assert.equal(afterLimit.find((m) => m.name === "c.md")?.error, limitMsg);
			assert.equal(afterLimit.find((m) => m.name === "d.md")?.error, limitMsg);

			// Now retry failed with a single-file error on a.md: c.md and d.md still succeed!
			started.length = 0;
			service.materialProfilerOverride.current = async (input) => {
				started.push(input.name);
				if (input.name === "a.md") throw new Error("Bad encoding in flate stream");
				return { profile: `## Scope\n- retried ${input.name}` };
			};
			const retried = service.retryFailedMaterials(chat.id);
			assert.ok(retried.ok);
			assert.equal(retried.value.length, 3);
			await service.waitForMaterials(chat.id, 5000);
			assert.deepEqual(started.sort(), ["a.md", "c.md", "d.md"]);
			const final = service.listMaterials(chat.id);
			assert.equal(final.find((m) => m.name === "a.md")?.status, "error");
			assert.equal(final.find((m) => m.name === "b.md")?.profile, "## Scope\n- b.md");
			assert.equal(final.find((m) => m.name === "c.md")?.status, "ready");
			assert.equal(final.find((m) => m.name === "d.md")?.status, "ready");
		} finally {
			service.materialProfilerOverride.current = undefined;
			await service.waitForMaterials(chat.id, 1000);
		}
	});

	it("retryMaterial retries one failed item, preserves ready items, and returns 409 when original is elsewhere", async () => {
		const chat = chatStore.createChat("Single retry");
		service.materialProfilerOverride.current = async (input) => {
			if (input.name === "bad.md") throw new Error("transient");
			return { profile: "## Scope\n- ok" };
		};
		try {
			const bad = service.addUploadedMaterial(chat.id, { name: "bad.md", type: "text/markdown", bytes: new TextEncoder().encode("x") });
			const elsewhere = service.addUploadedMaterial(chat.id, { name: "away.md", type: "text/markdown", bytes: new TextEncoder().encode("y") });
			assert.ok(bad.ok && elsewhere.ok);
			await service.waitForMaterials(chat.id, 5000);
			// Simulate away.md failing on another device without local file
			materialStore.update(chat.id, elsewhere.value.id, { status: "error", error: "failed there" });
			fs.rmSync(materialStore.filePath(chat.id, elsewhere.value));

			const refused = service.retryMaterial(chat.id, elsewhere.value.id);
			assert.equal(refused.ok, false);
			assert.equal(refused.ok ? 0 : refused.status, 409);

			service.materialProfilerOverride.current = async () => ({ profile: "## Scope\n- recovered" });
			const ok = service.retryMaterial(chat.id, bad.value.id);
			assert.ok(ok.ok);
			await service.waitForMaterials(chat.id, 5000);
			const items = service.listMaterials(chat.id);
			assert.equal(items.find((m) => m.id === bad.value.id)?.status, "ready");
			assert.equal(items.find((m) => m.id === bad.value.id)?.profile, "## Scope\n- recovered");
		} finally {
			service.materialProfilerOverride.current = undefined;
			await service.waitForMaterials(chat.id, 1000);
		}
	});

	it("UI helpers format queued status, pill failed count, and retryMaterials requests", async () => {
		const m = { id: "mat_x", kind: "pdf" as const, name: "b.pdf", file: "source.pdf", bytes: 1, addedAt: "t" };
		assert.equal(materialStatusLine({ ...m, status: "reading", queued: true }), "queued");
		assert.equal(materialStatusLine({ ...m, status: "reading" }), "reading…");
		assert.equal(sourcesLabel(97, 0, 12), "Sources · 97 · 12 failed");
		assert.equal(sourcesLabel(97, 2, 12), "Reading 2… · 12 failed");

		const calls: { url: string; body: string }[] = [];
		const fakeFetch = (async (url: string, init: { body: string }) => {
			calls.push({ url, body: init.body });
			return Response.json({ materials: [{ ...m, status: "reading" }], retried: 1 });
		}) as unknown as typeof fetch;

		const bulk = await retryMaterials("course_1", undefined, fakeFetch);
		assert.equal(bulk.error, undefined);
		assert.equal(bulk.materials?.length, 1);
		const single = await retryMaterials("course_1", "mat_x", fakeFetch);
		assert.equal(single.error, undefined);
		assert.deepEqual(calls, [
			{ url: "/api/courses/course_1/materials/retry", body: "{}" },
			{ url: "/api/courses/course_1/materials/retry", body: '{"materialId":"mat_x"}' },
		]);
	});
});
