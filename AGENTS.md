<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.** If anything is ambiguous — naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording — STOP and ask with the ask-user-question tool before proceeding. If you are "a little unsure," you are unsure: ask. A wrong guess is far more expensive than a question. Ask early, ask specific, one question per call.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement. Implementation should be mechanical execution of an approved plan — not interpretation.

# Use subagents for small tasks

Every subagent runs on Haiku (forced in `.claude/settings.local.json`: `CLAUDE_CODE_SUBAGENT_MODEL=haiku`, `..._FORCE=1`). It is cheaper and faster than the main model, and its tool output stays out of the main context. **Default to delegating** work of the kinds below instead of doing it inline. Doing it yourself is the exception, for a lookup of one or two tool calls whose target you already know.

The goal is tokens and speed, which means two things at once: **a subagent must not get it wrong and force a redo**, and **it must not come back to the main session for small things.** Both are solved in the brief, not afterwards.

**Delegate:**
- **Codebase search and reading.** Locating files and usages, summarizing what a module does, audits like the M5 survey. Ask for conclusions with `file:line` references, not file dumps. Use `Explore` for broad sweeps.
- **Running checks.** `npm run typecheck`, `npm run lint`, `npm test`. Ask for failures only, with the 10 known Windows failures filtered out, and the totals.
- **Mechanical edits.** Rote changes that are fully specified (a rename, a class or attribute added in N known places).
- **Drafting docs.** First drafts of STATUS.md sections and result tables from facts you supply.

**Run independent subagents in parallel** (one message, several Agent calls), for example the three audits behind one plan.

**Write the brief so it cannot go wrong.** It has no context, so give it all of this up front:
- the goal and why, the exact files or directories, and what is already ruled out;
- for edits: every file and the exact change, plus the command that proves it worked (typecheck, the one test file) so it runs that itself and fixes its own slips before reporting;
- the reply shape wanted (for example "failures only", "a table of `file:line` and the change") and "read-only" unless edits are wanted;
- the repo's pitfalls that apply (strict `noUncheckedIndexedAccess`; relative imports in `components/` use the `.ts` extension; leading tabs).
A vague brief is the main source of redone work. If it takes more than a few sentences to specify, it is probably not a Haiku task.

**Keep it from phoning home.** The brief states the small choices already made, and tells the subagent to decide the remaining trivial, mechanical, reversible ones itself (which of two equivalent greps, naming a local variable, formatting) and mention them in one line. It reports back early only for a real decision: a design, naming, data-shape, behavior, default or scope choice, which stays with the owner ("No guessing"). It never asks the owner anything directly; only the main session does.

**Trust in proportion to the stakes.** Take routine results (search hits, check output, a clean typecheck it ran itself) at face value, and do not re-run or re-read what a subagent already ran and reported. Spot-check only a claim the next step depends on and that is expensive to get wrong: a "nothing else uses this" before a deletion, a conclusion that shapes a plan. For edits, trust the proof command it ran; glance at the diff only when the change touches shared or risky code.

**Never delegate:** design or scope decisions, judgment-heavy review and security reasoning (use the advisor), and commits, merges and pushes.
