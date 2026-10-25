# Courses — curriculum → skill map → known

Status: **as built** (2026-10-24, approved by the owner the same day). Fork addition. Where the build differs from the plan text below, the "As built" section at the end says how.

A course turns a curriculum (PDFs, notes, links) into a map of **skills** that
live in the knowledge graph, tracks how many of them you **know**, and computes
the route from where you are to the whole curriculum from what you know now.

## Owner decisions (2026-10-24)

| Question | Decision |
|---|---|
| Where skills live | A new **skill** node kind in the graph, in its own ledger (`graph/skills.jsonl`). Skills have `requires` edges to skills and `restsOn` links to propositions. A skill two courses need is ONE node shared by both. |
| Curriculum → skills | A **course-planner agent drafts**, the owner reviews ("ask for changes" re-drafts with feedback), and **Approve** writes it to the graph. |
| What "known" means (stand-in) | **Leitner boxes 0–5** per skill, driven by practice outcomes. Clean solve +1, solved with hints = stay, moved on / gave up → box 1. Due after 1/3/7/16/35 days by box. **Known = box ≥ 3.** Overdue still counts as known until a review is missed. |
| Box timing | A clean solve **promotes only when the skill is due** (box 0 is always due). Misses always reset to box 1. |
| The route | **Computed frontier**, no agent: next up = not-known course skills whose prerequisites are all known. |
| What you already know | **Placement check**: a clean placement solve → box 3 *and* every transitive prerequisite → box 3. A placement miss → box 1. |
| Proposition links | **Planner + derived**: the planner stores links to existing propositions; propositions extracted from a Learn session on a skill rest on it, derived at read time (not stored). |
| Which practice moves boxes | **Course sessions only** (Practice, Review, Placement started from a course). |
| UI | A **Courses section in the sidebar** (above sessions) plus a **course page** `/course/[id]`. Sessions started from a course are labelled with it. |
| Canvas | **Course page only for v1.** The home canvas is unchanged. |

## Owner decisions (2026-10-25 — after the first real lesson)

The first ITGK lesson showed four gaps: no way to finish a lesson (so nothing
unlocked), a placement check nobody found, wrong answer keys, and no teaching
between questions. Decided:

| Question | Decision |
|---|---|
| Who finishes a Learn session | **Both**: the teacher's `finish_lesson` tool (goal demonstrated, or the learner asks) and a **Finish lesson** button on the session's top bar. Either logs it; the first one counts. The session stays open afterwards. |
| What finishing does | The skill becomes **learned** (box ≥ 1). |
| The unlock rule | **Learned unlocks**: a skill is next up once every prerequisite is learned (box ≥ 1). Known (box ≥ 3) stays the progress number, earned by spaced practice and review. |
| Learned, not known | A new **Learning** group (box 1–2) on the course page, with Practice and Learn again. **Practice all** practices this group. |
| The curriculum test | A **quick multiple-choice placement test** (a soft target of about a third of the skill count; the hardest technical skills first, judgment skills last, credited skills never re-asked), offered first after approval ("Find your starting point", with "Start from the beginning"). It replaces the problem-based placement check. |
| Placement grading | **Confidence-weighted**: correct with confidence ≥ 70 → known (box 3) plus every transitive prerequisite; correct but less sure → learned (box 1); wrong or "I don't know" → nothing (never lowers, never counts as learned). **A direct miss beats inferred credit:** a skill missed directly is never credited as someone else's prerequisite, whichever answer came first (owner, 2026-10-25). |
| A miss in practice | Back to box 1 — but a skill at box 0 stays there: a miss never counts as learned (follows from "learned unlocks"). |
| Wrong answer keys | **Solve first**: the quiz schema emits the worked `explanation` before the `options`; the options are built around the answer it reaches. **Then checked before posing** (all three multiple-choice tools): the question's one python block is run (its printed output, when it is an option, must be the key); an optional `verify` program must print the correct label; anything Python did not settle is solved blind by the `checker` role, which never sees the key (`core/answer-check.ts`, `server/question-check.ts`). A checker disagreement refuses once; the same call sent again unchanged goes through. |
| Skills had from another course | **A context check, never a course**: a course skill learned or known on evidence from other courses only is listed under **From another course** with **Quick check** — a short practice session (`mode: "check"`: one problem, two at most, framed in this course's terms; only what differs here is explained). Optional: the skill stays learned/known and unlocks what builds on it. The placement test skips these skills. |
| Finishing any course session | **Every mode finishes**, not only Learn: the agent's `finish_session` (practice, review, context check, placement — when the course section says the work is done, or the learner asks) or the learner's **Finish session** button (top bar; refused over an open question or a live problem). It only marks the session done; a Learn finish still makes the skill learned. Finished sessions show **Finished** with a check in the sidebar, and fold into a collapsed **Finished** group under the course page's Sessions. |
| The skill map's size | The map lives in a **pan/zoom viewport** that opens readable (zoom 0.9, centered on what is due or next up) instead of the whole map shrunk into the column (a 32-skill map's text had shrunk to ~5px). Drag pans, Ctrl/⌘ + wheel zooms (a plain wheel scrolls the page), buttons zoom, fit and **expand** the map to the window. A map that is readable whole shows whole. |
| The skills you know | A card on the home's main view (top-left): every skill the learner has, known first, then learning, with its box and courses (`GET /api/skills`). |
| No teaching between questions | **Gate + prompt**: the teacher's quiz/explain call is refused when no text has reached the learner since their last graded answer (`core/prose-gate.ts`), plus a teaching-prompt rule. |

## 1. Data

### 1.1 Skills ledger — `data/graph/skills.jsonl` (new, append-only)

```ts
interface SkillLine {
  id: string;          // "sk_" + nanoid-like, store-assigned
  name: string;        // short handle, like a node's name ("Chain rule")
  statement: string;   // the checkable ability: "Differentiate a composition f(g(x)) with the chain rule"
  requires: string[];  // skill ids that must be known first
  restsOn: string[];   // proposition ids (n_…) — the planner's stored links
  createdAt: string;
}
```

Same discipline as `nodes.jsonl`. The **first line for an id defines**
name/statement/createdAt. Later lines for the same id are **link-appends**:
their `requires` and `restsOn` union in (a second course reusing a skill can add
edges). Readers merge by id. References to dead propositions (graph deletion)
or unknown skills are dropped at read time, never rewritten.

- `GraphStore` port gains `readSkills(): Skill[]` and `appendSkills(lines)`.
  `src/store/graph.ts` implements both. `LEDGER_FILES.skills` is added to
  `config.ts`. No graph format bump: an existing file doesn't change shape, and
  older builds ignore the new file.
- **Writer:** the course-approval seam (`approveCourse`) is the skills ledger's
  ONLY writer. The extraction pipeline stays the sole writer of
  nodes/chains/coverage. `architecture.md` records this as the ledger's owner.

### 1.2 Course store — `data/courses/<courseId>.json` (new; `CourseStore` port, sole writer `src/store/courses.ts`)

```ts
interface CourseRecord {
  id: string;                 // "course_" + random
  title: string;
  createdAt: string; updatedAt: string;
  version?: number;           // schema stamp, same lazy-v1 rule as chats
  status: "new" | "drafting" | "draft" | "active" | "error";
  skills: string[];           // the APPROVED skill set (sk_ ids); [] until first approval
  draft?: CourseDraft;        // the pending planner output (cleared on approve)
  error?: string;             // last drafting failure
  drafts?: CourseDraftUsage[];// planner usage log (money channel, like extractions)
}
interface CourseDraft {
  createdAt: string;
  summary: string;            // the planner's short prose: approach, what it reused
  feedback?: string;          // the owner's change request this draft answered
  skills: DraftSkill[];
}
interface DraftSkill {
  key: string;                // draft-local "s1", "s2", …
  reuse?: string;             // an EXISTING sk_ id this IS (identity judgment, like the auditor's link)
  name: string; statement: string;
  requires: string[];         // other draft keys
  restsOn: string[];          // existing proposition ids
  cite?: string;              // where in the curriculum ("Ch. 3, p. 41")
}
```

- **Approve** turns the draft into ledger lines. A new skill gets a fresh
  `sk_` id. A `reuse` skill is link-appended with any new edges. The course's
  `skills` becomes the draft's resolved id set, and status becomes `active`.
  Approval **validates**: requires form a DAG and stay inside the course's
  skill set, restsOn ids exist, and reuse ids exist.
- **Re-planning after approval:** add more material or ask for changes →
  Draft again → Approve again. Approval replaces the course's `skills`. Skills
  dropped from a course stay in the graph (shared, and their history keeps).
- **Materials:** the existing `materialStore`, keyed by the course id
  (`data/materials/course_…/`). Profiling is unchanged (`src/server/materials.ts`
  seams take an owner id instead of assuming a chat).
- **Delete course:** removes the record and its materials. Skills stay in the
  graph. Sessions stay, and their course label falls back to plain sessions.

### 1.3 Chat record — `course?` link (contracts/chat.ts)

```ts
course?: { courseId: string; mode: "learn" | "practice" | "review" | "placement"; skillIds: string[] };
```

Stamped at creation by the course-session route and never changed afterwards.
`learn` = a teach session aimed at one skill. The other three are practice
sessions.

### 1.4 Practice `problem` tool — optional `skills`

Present **only when the session has a course**: `skills?: string[]`, the skill
id(s) the problem tests. They are checked against the session's skill set
(rejected otherwise) and normalised from names to ids, like `target`. They are
stored in the tool call's arguments, so the record carries the evidence and
nothing is stored anywhere else.

## 2. Known — `src/core/mastery.ts` (pure, browser-safe, derived on read)

**Events** (`skillEventsOf`, per course chat):
- practice / review → every concluded problem with `skills` → `{ skillId, at: conclude timestamp, outcome }`;
- Learn → its finish (`lessonFinishOf`: the `lesson-finished` marker or a clean `finish_lesson` call, the first one) → `finished`;
- placement test → every answered placement `probe` (its `skill` arg + the answer's `correct`/`confidence`/`dontKnow`) → `placementKnown` / `placementUnsure` / `placementMiss`;
- legacy placement checks (problems, before 2026-10-25) keep `placement: true`.

Folded in time order per skill:

| Event | Effect |
|---|---|
| `finished` | box = max(box, 1) |
| `solved`, skill **due** | box + 1 (max 5), `lastMove = at` |
| `solved`, not due | nothing |
| `solvedWithHints` | nothing |
| `movedOn` / `surrendered` | box ≥ 1 → box = 1, `lastMove = at`; box 0 stays 0 |
| `dismissed` | ignored |
| `placementKnown` (correct, confidence ≥ 70) | box = max(box, 3), `lastMove = at`; every transitive `requires` the same, except a skill with a `placementMiss` of its own |
| `placementUnsure` (correct, < 70) | box = max(box, 1) |
| `placementMiss` (wrong / I don't know) | nothing to its own box; blocks its inferred credit (any order) |
| legacy placement: solved / with hints / miss | as `placementKnown` / box = max(box, 1) / nothing |

Due: box 0 is always due; otherwise `now ≥ lastMove + [—, 1, 3, 7, 16, 35][box]` days.
**Learned = box ≥ 1. Known = box ≥ 3.** Course progress = known / course skills.

**Views (pure functions of skills + boxes + now):** `review` = learned and due.
`nextUp` = box 0 with every `requires` learned, in topological order.
`learning` = box 1–2. `locked` = box 0 with some prerequisite not learned,
listing which. `known`. `contextCheck` = learned, but this course has no
evidence on it (`inCourseEvidence`: a fold of the course's own events —
inferred placement credit included — plus any skill its sessions touched);
it also stays in `known`/`learning`.

Nothing is stored. The course API computes the fold from chat records on read,
in line with the graph's "derive, don't store" rule.

**Derived proposition links:** a skill's propositions = stored `restsOn` ∪ every
proposition whose provenance includes a chat with `course.mode === "learn"` and
that skill in `skillIds`.

## 3. The course-planner agent — `src/agent/subagents/course-planner.ts`

- New model role **`coursePlanner`**. It gets a row in Settings → per-role
  models, and the default chain falls back to the strong slot like the others.
- Built on `runSubmitAgent`, with extra read tools: the material lookup tools
  (keyed to the course), and graph exploration over propositions and **skills**
  (the auditor's `find`/`list_propositions`, plus a new `list_skills`).
- Input: course title, every material profile, the existing skills
  (id/name/statement), and on a re-draft the previous draft plus the owner's
  feedback.
- Doctrine (new prompt fragment `prompts/course-planner/`): every skill is
  **specific and checkable**, i.e. a practice problem can test it. One skill is
  one ability, and every target the curriculum states is covered. `requires`
  only where truly needed. **Reuse** an existing skill when it is the same
  ability; prefer a duplicate over a wrong merge (the auditor's rule). Link
  `restsOn` only to existing propositions that are genuinely the facts the skill
  uses. Cite the curriculum.
- Submit validation (an error result lets the agent retry): unique keys, valid
  references, acyclic, and every curriculum material referenced at least once.
- Runs in the background like material profiling: waits for profiles, sets
  status `drafting` → `draft` / `error`, logs usage into `drafts`, and emits
  `courses-changed`.

## 4. Sessions from a course

`POST /api/courses/[id]/sessions { mode, skillId? }` creates the chat with the
`course` link and a **course-context marker** as message[0] (same mechanism as
the graph-context marker). The marker lists the session's skills (statement,
box, due) and their propositions with the chains among them. A generated first
learner message starts the turn, and the client navigates to `/chat/<id>`.

| Mode | Kind | Skills in context | First message |
|---|---|---|---|
| Learn (one skill) | teach | the skill; its prerequisites as known background | "I want to learn to: <statement>" |
| Practice (one skill, or all of Learning) | practice | the chosen skill(s) | "Practice: <names>" |
| Review | practice | the due skills | "Review my due skills" |
| Placement test | conversation — the placement tester (`createPlacementAgent`) | all course skills except those had from another course | "Placement test for <course>" |
| Context check (one skill had from another course) | practice | the skill | "I already know this from another course — check that I can use it in <course>: <statement>" |

- **Course materials serve every course session.** `materialsForTurn` adds the
  course's materials (profiles plus lookup tools) beside the lesson's own.
- **A per-turn course section** (like the materials section) is added to the
  practice agent's system prompt. It explains skill tagging, and for
  placement: one problem per skill, start from the most advanced skills, and
  skip a skill once a dependent has been cleanly solved (prerequisites are
  credited), with only that problem's skills tagged.
- Titles: "Learn: <skill>", "Practice: …", "Review: <course>", "Placement: <course>".
- **Finishing a Learn session** (2026-10-25): the teacher's `finish_lesson`
  (`agent/tools/course.ts`, teacher phase of course Learn sessions only) or
  the learner's `{ type: "finish" }` input event (400 outside a course
  lesson, when already finished, or over an open question) → the
  `lesson-finished` marker, which the model reads as "wrap up". Both render
  the "Lesson finished · <skill> learned" divider; the top bar's button
  turns into "Finished".
- **The placement tester** (2026-10-25): its own prompt directory
  (`prompts/placement/`, plus the shared voice, accuracy, question craft,
  confidence and formatting fragments — no teaching base) and a registry of
  `probe` (the multiple-choice quiz with a leading, validated `skill`) +
  `ask_user_question`. It keeps the `probe` name so the question dock
  renders it unchanged. No graph extraction runs on placement sessions.

## 5. API (thin route handlers → `src/server/courses.ts`)

- `GET/POST /api/courses`: list (with % known) / create (`{ title }`).
- `GET/PATCH/DELETE /api/courses/[id]`: record + progress view (boxes, due, next up / locked / known, per-skill propositions) / rename / delete.
- `POST /api/courses/[id]/draft { feedback? }`: start (re)drafting.
- `POST /api/courses/[id]/approve`: approve the current draft.
- `/api/courses/[id]/materials` (+ `/[materialId]`): same contract as the chat materials routes.
- `POST /api/courses/[id]/sessions`: see §4.
- `GET /api/skills`: every skill the learner has across all courses — `{ known, learning }`, each with box, due and course titles (the home's skills card).
- New server event **`courses-changed`** (course record changed, or a course chat's turn settled) → the sidebar and course page refetch.

## 6. UI

- **Sidebar → Courses** (above sessions): one row per course with title and %
  known, plus "+ New course". The new-course row creates "Untitled course" and
  opens its page. Session rows from a course show the course name as a small
  label.
- **`/course/[id]`**:
  - Header: editable title, *n/m known (p%)*, **Placement test** and **Review (n)** buttons.
  - Right after approval, while the course has no sessions: **Find your starting point** — Take the placement test / Start from the beginning (the skip is remembered per browser).
  - Curriculum: the existing Sources control (materials-control) bound to the course, plus **Draft skill map**.
  - Draft state: the draft's summary, its skills (reused ones marked, with citations and prerequisites), a feedback box with **Ask for changes**, and **Approve**.
  - Active state: the **skill map** as a mermaid dependency diagram (the existing mermaid renderer) coloured by state (known, learning, not started, locked), then **Next up** (Learn / Practice per skill), **Learning** (Practice / Learn again, plus Practice all), **Locked** (with the missing prerequisites), and **Known**. Each skill expands to show its statement, box, next due date and the propositions it rests on (name + statement, with links to the sessions they came from).
- The home canvas is unchanged.

## 7. Docs and tests

- Docs: this file (status → as-built), `architecture.md` (Courses store, skills
  ledger owner, new routes/event), README (a "Courses" section),
  `skills/learnharness/references/data-format.md` (skills.jsonl, courses/).
- Tests (deterministic, no LLM): the mastery fold (every row of the §2 table,
  due logic, placement prerequisite credit, views), skills ledger merge and
  dead-reference filtering, course store, draft validation and approval (reuse,
  link-append, DAG/scope rejections), the planner's submit validation, the
  `problem` tool's `skills` field (present/absent, rejection), session creation
  per mode (marker, link, title), materialsForTurn with course materials, and
  render tests for the sidebar section and the course page states.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`.

## As built — differences from the plan text

- **Skills ledger port:** a separate `SkillStore` port (`src/store/skills.ts`) instead of new `GraphStore` methods. The file is the same (`data/graph/skills.jsonl`, under the graph format stamp). Adding methods to `GraphStore` would have broken every in-memory fake that `satisfies GraphStore` in the tests.
- **Placement, solved with hints:** box ≥ 1, prerequisites not credited (owner decision during the build).
- **Reused skills' prerequisites:** when a draft reuses a skill that already requires other skills, approval adds those prerequisites (transitively) to the course's skill set, so no course skill is locked behind a skill the course doesn't show.
- **Planner prompt:** inline in `course-planner.ts`, like the other sub-agents (extraction, material profiler), not a `prompts/course-planner/` fragment directory. That directory would have entered the prompt-override settings, which only cover the conversation agents.
- **Skill map rendering:** the app's own plan DAG renderer (`PlanDiagram`, dagre — mermaid's layout engine), with known skills white, next up white and locked gray, instead of a raw mermaid chart. Box state is shown in the lists below the map.
- **Course context marker:** reuses the `graph-context` marker type (same flattening, neutral input cause and compaction handling) with a `course` block in its details. The transcript card shows the course, mode and skills.
- **`courses-changed`** carries no payload (like `chats-changed`): pages refetch on it, and on every `turn-settled`.
- **2026-10-25 — the learner marker** for Finish lesson is a new marker type (`lesson-finished`, learner cause) rather than a user message, so the transcript shows a divider and the record says exactly what happened.
- **2026-10-25 — the placement probe's skill** must be an exact course skill id (refused otherwise, with the id list); names are not resolved, so the record always carries canonical ids.

## Not in v1

Skills on the home canvas · editing individual skills by hand after approval ·
a real understanding model (the box rule is the stand-in) · teach-session
quizzes moving boxes · boxes from non-course practice.
