# Courses — curriculum → skill map → known

Status: **as built** (2026-10-24, approved by the owner the same day). Fork addition. Where the build differs from the plan text below, the "As built" section at the end says how.

A course turns a curriculum (PDFs, notes, links) into a map of **skills** that
live in the knowledge graph, tracks how many of them you **know**, and computes
the route from where you are to the whole curriculum from what you know now.

> **2026-11-07:** the Leitner boxes named in the decisions below were replaced by an
> FSRS understanding model (spec: section 2). Read "box" in the older text as
> "understanding"; section 2 is current.

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
| The skills you know | **In the knowledge graph**, as its second node kind: every held skill (learned or known) drawn as a rounded square in the skill color — solid when known, faint while learning, ringed when due — with arrows from its prerequisite skills and from the propositions it rests on, and one region per course. Clicking one opens its card (state, courses, what it rests on). The snapshot carries them as `skills` (`graphSkillLayer`); the canvas folds them in at fetch (`withSkillLayer`). |
| Short lessons in the graph | **Extract on finish**: a finished Learn session extracts whatever text is left, however little (`extractionDue`); a lesson under the batch budget used to never reach the graph. |
| No teaching between questions | **Gate + prompt**: the teacher's quiz/explain call, and its `ask_user_question` (since 2026-11-05, answered through `send_to_user` or plain text), is refused when no text has reached the learner since their last graded answer (`core/prose-gate.ts`), plus a teaching-prompt rule. |

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
edges). A line with `reworded: true` also replaces name/statement, the last one
winning — the planner re-words a reused skill in the course language when it is in another. Readers merge by id. References to dead propositions (graph deletion)
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
  language?: "en" | "nb";     // the course's language (stamped from the default at creation; absent = the current default)
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

## 2. Understanding — `src/core/mastery.ts` (pure, browser-safe, derived on read)

Every skill has an **FSRS-6 memory state** (difficulty, stability) folded from the
course sessions' evidence in time order, using the pure model of the `ts-fsrs`
package with its default parameters, no learning steps and no fuzz. Stability *S*
is the number of days for recall to fall from 100% to 90%; retrievability *R(t, S)*
is the chance of recall `t` days after the last review. Background:
<https://github.com/open-spaced-repetition/awesome-fsrs/wiki/ABC-of-FSRS>.

**Events** (`skillEventsOf`, per course chat):
- practice / review → every concluded problem with `skills` → `{ skillId, at: conclude timestamp, outcome, grade? }`; `grade` is the grader's per-skill grade from the `conclude` RESULT's `details.grades` (`concludeGradesOf`; records from before the grader keep the tutor's own `grades` argument);
- Learn → its finish (`sessionFinishOf`: a clean `finish_lesson` call, or a `lesson-finished` marker from before 2026-11-13, the first one) → `finished`, with the grader's grade of the final problem when the finish result carries one (see "The final problem" below);
- placement test → every answered placement `probe` (its `skill` arg + the answer's `correct`/`confidence`/`dontKnow`) → `placementKnown` / `placementUnsure` / `placementMiss`;
- legacy placement checks (problems, before 2026-10-25) keep `placement: true`.

**Grades** are the Anki scale, least to most learned: `again`, `hard`, `good`, `easy`.
A separate **grader** model grades each tagged skill of a problem (owner, 2026-11-09: the tutor
graded a hint-assisted, 30%-confident review `good`). When a `conclude` succeeds in a course
session, the practice agent's `afterToolCall` hook (`src/agent/practice-grade.ts`) slices the
problem out of the live turn (pose to conclusion: statement, committed solution, the learner's
work with stated confidence, tutor replies, sketch read-backs, the tutor's own conclusion;
`src/core/practice-grading.ts`), runs the `grader` role (strong slot, Settings override;
`src/agent/subagents/grader.ts`, whose owner-approved rubric is code, not an editable fragment)
and writes the grades into the result's `details`. The tutor no longer grades: `conclude` has no
`grades` field and drops one sent anyway. A skill the grader skipped gets the cautious default
(a solve counts as `hard`, other outcomes keep their own default).
A record without grader grades (older chats) takes the tutor's own, then the outcome's default.

**When the grader fails (owner, 2026-11-13).** A grader slot out of credit once left nine
problems ungraded with nothing on screen. Now (`src/server/practice-grade.ts`):

- **Fallback.** If the grader's model is missing, errors or passes its 120 s limit, the
  session's own model grades once with a 60 s limit (`gradeWithFallback`). No second attempt
  when the session already runs on the grader's model, and none when the learner stopped the turn.
- **What is stored**, beside `grades` in the conclude result's `details`: `gradedBy: "session"`
  only when the fallback graded, and `gradeError`, a short readable reason for the grader's
  failure ("out of credit (Google)", `core/grade-failure.ts`), kept when the fallback graded and
  when nothing did. With nothing graded `grades` is `[]` and the cautious default applies.
- **The concluded card** shows nothing new when the grader worked; "Graded by the session's
  model. The grader failed: …" after a fallback; and "Not graded. The grader failed: …. A
  cautious default grade applies." with a **Grade again** button when nothing graded (an older
  ungraded problem shows the same line without a reason).
- **Grade again** (`POST /api/chats/[id]/regrade { toolCallId }`, `regradeConcludedProblem`)
  grades the stored problem with the same fallback and writes the grades into that conclude
  result. It is refused (409) while a turn or a compaction runs in the chat, since their saves
  replace the whole message list; a grading that fails again leaves the record unchanged and
  the reason shows under the button. On success it emits `record-changed` and
  `courses-changed`. This is the only place an earlier message is edited; docs/sync.md has the
  merge rule that goes with it.

Each event is one FSRS review:

| Event | Grade |
|---|---|
| tutor's `grade` | as given |
| `finished` | the final problem's grade; hard when a grading ran and left none; good for a finish from before the final problem |
| `solved` (no grade) | good |
| `solvedWithHints` (no grade) | hard |
| `movedOn` / `surrendered` / `taught` (no grade) | again — on a skill never learned: ignored, a miss never counts as learned |
| `dismissed` | ignored |
| `placementKnown` (correct, confidence ≥ 70) | the skill easy, then seeded to ≥ 40 days of stability (`PLACEMENT_SEED_DAYS`, understanding ≈ 6.3: known at once); every transitive `requires` good, seeded to ≥ 20 days (`PREREQUISITE_SEED_DAYS`, ≈ 5.2: learning), except a skill with a `placementMiss` of its own |
| `placementUnsure` (correct, < 70) | hard |
| `placementMiss` (wrong / I don't know) | nothing; blocks its inferred credit (any order) |
| legacy placement: solved / with hints / miss | as `placementKnown` / hard / nothing |

A review at the same moment as the last adds no stability (no credit for drilling);
a review once recall has faded grows it more. `taught` is the outcome for a problem
where the tutor showed the correction and taught the point itself.

**The final problem (owner, 2026-11-13).** Finishing a lesson used to count as `good` whatever
happened in it, and the first practice afterwards mostly needed hints. A course Learn session now
ends with ONE unaided problem (`core/final-problem.ts`):

- **Form.** The teacher poses it with `explain` and `type: "final"`: always free-form (writing or
  a sketch, no options), whatever the Quizzing setting. A multiple-choice lesson keeps `quiz` for
  its checks and gets `explain` for the final problem alone (`ExplainScope` in `agent/tools.ts`).
  The dock labels it "Final problem", shows "No hints. Sets your first rating." and has an
  "I don't know" button. It arrives open, never behind the reveal.
- **The finish gate.** `finish_lesson` is refused until a final problem has been answered since
  the last finish attempt, and when the answer was "I don't know" (`finishGateProblem`, chained
  with the teacher's other gates and under the same refusal cap).
- **The grade.** When `finish_lesson` goes through, the teacher's `afterToolCall` hook
  (`agent/lesson-grade.ts`) has the practice grader, with its fallback, rate the final problem
  for the lesson's skill from the final problem to the finish call. The grade rides the finish
  result's `details.grades`, like a conclude's, and is the skill's first rating. `again` turns
  the finish into an error result ("NOT FINISHED"): the transcript holds no clean finish, the
  skill stays not learned, and the teacher repairs the gap and poses a new final problem. A
  grading that fails altogether lets the finish stand; the fold counts it as `hard`.
- **The Finish lesson button** no longer finishes a Learn session. It appends a `lesson-finished`
  marker with `details.request: true` ("Finish requested · final problem next") whose text tells
  the teacher to pose the final problem at once. `sessionFinishOf` skips request markers; a Learn
  marker from before this change has no `request` and still counts as the finish it was. Every
  other course session's Finish button is unchanged.

**Understanding (0–10, what the learner sees)** = `ln(1 + S) / ln(1 + 365) × 10`: how long
the skill lasts, a year being 10 (S = 1 day: 1.2, 8: 3.7, 30: 5.8, 100: 7.8). It does not
fall as days pass. **Needs review** = retrievability now below 90% (`DESIRED_RETENTION`),
i.e. one stability after the last review. **Learned** = has a memory state (a review
happened); it unlocks what builds on it. **Known** = understanding ≥ 6
(`KNOWN_UNDERSTANDING`, about a month of memory). The skill count "x/y known" counts
the known skills. **Course progress %** (owner, 2026-11-08) is the average of each skill's
`knownShare` = understanding / 6, capped at 1 (`courseProgressPercent`), so a known skill is
100%, an inferred prerequisite (5.2) is 87%, and the 0–10 depth above the line adds nothing to
coverage. The skill rows keep the 0–10 score with a "lasts about …" note (`lastsLabel`: the
stability behind the number).

**Views (pure functions of skills + states + now):** `review` = learned and needs
review, in topological order (the review queue's ordering, cap and mix are a later
step). `nextUp` = not learned with every `requires` learned, in topological order.
`learning` = learned, not known. `locked` = not learned with some prerequisite not
learned, listing which. `known`. `contextCheck` = learned, but this course has no
evidence on it (`inCourseEvidence`: a fold of the course's own events — inferred
placement credit included — plus any skill its sessions touched); it also stays in
`known`/`learning`.

Nothing is stored. The course API computes the fold from chat records on read,
in line with the graph's "derive, don't store" rule.

**Review sessions (2026-11-07).** A Review session is not every due skill: `pickReviewSkills`
(core/mastery.ts) takes at most `REVIEW_SESSION_SIZE` = 6 of the skills that need review: the
four with the lowest understanding, the one not practiced for the longest of the rest, and one
morale skill (the highest understanding of what is left). With six or fewer, all of them. They
are posed morale first, then weakest to strongest, and the unpicked ones stay due for the next
session (`CourseView.reviewBatch` is how many the next one takes). The prompt
(`coursePromptSection`) says the listed skills ARE the session, and that every skill is tested
in the listed order; a problem may group several skills at a higher difficulty.

**Difficulty (2026-11-07, core/difficulty.ts).** Every practice-kind session carries
`ChatSettings.difficulty` (default Short; the general default `GeneralSettings.difficulty`
(Settings → General → Practice) stamps new sessions; the pill in the composer edge changes it): Short 1 skill ~3 min, Medium 2
skills ~6, Long 3-4 ~12, Exam 4-6 ~20 and exam-level (calibrated to past exams in the course
sources when there are any). The level's skill cap is enforced by the `problem` tool; minutes
and "size by the work, not only the skill count" are prompt-only (`<difficulty>` section,
practice agent only). Practice prompt fragment added: `30-short-sessions.md` (short feedback, the tutor decides when to show the
correction and teach it, ending as `taught`, at most one retest after a taught problem).
A concluded problem that ended taught / moved on / surrendered shows a "Learn <skill>" button
per again-graded skill: it opens a Learn session on that skill, and Next problem continues
the review on return.

**Rating change after a problem (owner, 2026-11-13).** A concluded course practice, review or check
problem shows under its card how it moved its skills: "Product rule: understanding 3.1 → 4.2 · review in 5
days". `GET /api/chats/[id]/rating-changes` (`ratingChanges` in `src/server/courses.ts`) folds every
course's evidence before each problem of the session and with it (the same `foldSkills` the course page
reads), one request per chat for all its cards; `components/rating-change.tsx` asks again when a turn
settles, since the problem is only in the record by then. Nothing is stored.

**The lesson's result (owner, 2026-11-13).** What the teacher says it showed when it finishes a lesson (the
`summary` argument of the clean `finish_lesson` call, `finishSummaryOf` in `core/course-session.ts`) used to
be read by nothing. It is now the skill's **lesson note**, derived from the transcript on read (nothing is
stored): the skill's detail on the course page shows it with a link to the lesson
(`CourseSkillView.lessonNote`, the newest finished lesson wins), and the context marker of a later Practice,
Review or Check session lists it under the skill ("note from its last lesson: …") as the tutor's opening
reminder. Under the finish divider a **result card** (`GET /api/chats/[id]/lesson-result`,
`components/lesson-result-card.tsx`) shows the skill, its new understanding and when it comes up for review,
the summary, and three buttons: Practice this skill (starts a practice session on it), Next: <skill> (the next
in the exam-ordered Next up; opens the course page on its pace dialog) and Back to the course.

**Sources before the plan (owner, 2026-11-13, `core/sources-gate.ts`).** In 22 tablet chats the tutor
searched the course's sources once, and only after the learner asked for the full syllabus. In a course
Learn session whose tutor has `material_search`, `plan_init` is now refused until a lookup
(`material_search` or `material_read`) has succeeded, and the FIRST plan must carry a `sources` field
saying what the lookup showed and what the plan uses (a later rewrite of the map does not need it again).
Same refusal cap as the other teacher gates (3 per run), and the planning prompt says the same.

**The recall opener and a mixed Practice all (owner, 2026-11-13).** A Learn session whose skill has learned
prerequisites opens its teaching (after the plan, before the first step) with one or two short free-form
questions on them: `explain` with `type: "recall"` and `skill` (a learned prerequisite of the lesson's skill,
validated; none learned = no opener, and the tool refuses the type). No hints, they arrive open, and the dock
labels them "Recall". The grader rates each when the lesson finishes (`recallOpenersOf` in
`core/final-problem.ts`, graded in `agent/lesson-grade.ts` only on a finish that goes through) and the grades ride
the finish result as `details.openers`; the fold reads each as a `solved` review of its skill at the finish time
(`skillEventsOf`), so a good answer strengthens that skill's memory and a miss brings its review forward. A
grading that fails adds nothing. "Practice all" poses the learning skills in a shuffled order (`shuffled`), so
the session interleaves them; the context marker says "in a mixed order".

**Course folders (owner, 2026-11-14, `core/course-folders.ts`).** The sidebar can separate courses by year or
semester. A folder is a NAME on each course (`CourseRecord.folder`, 1 to 60 characters, one level), not a
registry: it exists while a course is in it, you make one by moving a course into "New folder…", and an emptied
folder is gone. Because it is a course field it syncs per field like the title (`docs/sync.md`), so an older
build cannot wipe it. Names match case-insensitively and a new name takes the spelling an existing folder has.
The order depends on the names alone, never on activity: courses with no folder first, by name; then folders,
HIGHEST name first (name them "2026-2 Høst", "2026-1 Vår" so the newest is on top; numbers compare as numbers);
courses by name inside a folder. `PATCH /api/courses/[id]` takes `folder` (null or blank takes the course out);
`POST /api/courses/folders` renames a folder (every course in it moves, merging into a folder of the new name)
or removes it (its courses leave it; none is deleted).

**Retry on another model (owner, 2026-11-13, `core/turn-fallback.ts`).** When a turn fails with a recognised
provider failure, the banner offers "Retry on <Cheap slot model>" beside Retry: one press moves THIS session
to that model (its other settings kept) and retries. It is never automatic, and only between API-key models:
a subscription session (Claude Code, ChatGPT, Copilot, ...) gets no button and a subscription is never the
target, so the rule that subscriptions do not fall back stays. The target must have a key and differ from the
model that failed.

**Exam date, weights and Today (owner, 2026-11-13, `core/exam-plan.ts`).** A course may carry an
exam date and a weight per skill, so the learner spends the time left on what the exams use:

- **Stored** on the course record: `examDate` ("YYYY-MM-DD"), `skillWeights` (skill id → `{w: 0-3,
  reason?, by: "model" | "learner"}`), and the weighing pass's `weightsSummary`, `weightsAt`,
  `weightsError`. A skill without a weight counts as 1, so a course with no weights behaves exactly as
  before. Weights belong to the course, not the skill (a skill two courses share is weighed in each).
- **Weigh by exams** (`agent/subagents/exam-weigher.ts`, role `coursePlanner`, started by
  `POST /api/courses/[id]/weigh`, runs in the background like drafting): one pass over the sources (past
  exams first, then exam-preparation sets, then the syllabus; it reads them with the lookup tools) and
  the approved skill list; every skill gets 0 (never examined), 1 (sometimes, or unknown), 2 (several
  exams) or 3 (nearly every exam) with a one-line reason, and the summary says when no past exams were
  found. The submit check refuses a missing, repeated or unknown skill. A re-weigh keeps every weight the
  learner set by hand (`mergeModelWeights`). The skill map itself is never touched.
- **Priority.** A skill's priority is the highest weight among itself and everything it unlocks, so
  the prerequisites of heavily examined skills come first. **Next up** is ordered by priority (ties keep
  the topological order). A next-up skill with priority 0 (not examined, and nothing examined builds on
  it) moves to a collapsed **Not examined** group; it can still be learned.
- **Countdown and forecast.** With an exam date the page shows the days left, the skills left (Next up
  and Locked, not examined ones left out), the lessons a day they need, and the recent pace: Learn
  finishes over the last 14 days (fewer, at least 3, while the course is young). "On track" when the pace
  covers the need, "behind" when not. The exam day itself is not a study day.
- **Today.** Reviews due, then enough lessons to hold the pace (1 to 3; 1 without an exam date), taken
  from the ordered Next up. It shows on the course page (Start / Learn buttons) and as a list above
  Courses in the sidebar (`GET /api/today`, courses with the soonest exam first, five lines at most): a
  review line starts the review, a lesson line opens the course page on that lesson's pace dialog
  (`?learn=<skill id>`).
- **By hand.** `PATCH /api/courses/[id]` takes `examDate` (null clears) and `weights` ({skill id: 0-3 |
  null}); a skill's detail panel has 0-3 buttons and Reset. The sync merges `examDate` per field and the
  weights, their summary, time and failure as one unit (`COURSE_WEIGHTS_UNIT`).

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
- **Finishing a Learn session** (2026-10-25, changed 2026-11-13): the teacher's
  `finish_lesson` (`agent/tools/course.ts`, teacher phase of course Learn
  sessions only) after an answered final problem; it renders the "Lesson
  finished · <skill> learned" divider and the top bar's button turns into
  "Finished". The learner's `{ type: "finish" }` input event (400 outside a
  course session, when already finished, or over an open question) is, in a
  Learn session, a request for the final problem (section 2).
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
- `GET /api/graph` also carries the skills layer (`skills`: held skills, their arrows, one region per course).
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
