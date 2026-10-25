<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="https://learnharness.ai">Download</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/amosblomqvist/learnharness/issues">Issues</a>
</p>

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

The agent can also research questions in the background, create visual explanations, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## Download and get started

**[Download from learnharness.ai](https://learnharness.ai)** · [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases)

- **macOS (Apple Silicon):** signed and notarized DMG. Drag the app to Applications.
- **Windows (x64):** run the installer. It is currently unsigned; Windows may show an “unknown publisher” or SmartScreen warning.
- **Linux (x64):** make the AppImage executable and open it, or install the Debian/Ubuntu `.deb`.

Add your provider API key and choose your models, then start a session with what you want to understand. LearnHarness supports 30+ provider options, including OpenAI, Anthropic, Google, DeepSeek, and OpenRouter. Dictation runs locally on your machine by default (see below); web search and the optional cloud dictation engine use separate service keys.

All three platforms support in-app updates.

### Install this fork on Windows

The upstream download is upstream's build. To get this fork's features, build the installer yourself on the Windows machine (Node 24+ and Git):

```sh
git clone https://github.com/TobiasSamsonsen/learnharness.git
cd learnharness
npm ci
npm run desktop:dist:win
```

Then run `dist\LearnHarness-<version>-x64-setup.exe`. It installs per user (no administrator rights) into `%LOCALAPPDATA%\Programs\LearnHarness`, with Start menu and desktop shortcuts. The installer is unsigned, so Windows SmartScreen shows "Windows protected your PC": choose **More info → Run anyway**. Uninstall from Settings → Apps. Your lessons and settings live in `%APPDATA%\LearnHarness` and survive reinstalls.

In-app updates check this fork's GitHub Releases, so an installed copy never "updates" to upstream's build. Until the fork publishes a release, the update check finds nothing and the app keeps running as is.

### Staying current with upstream

The fork keeps upstream's version number (`package.json` `version`), so it always knows which upstream release it is based on. Every few hours the app checks [upstream's releases](https://github.com/amosblomqvist/learnharness/releases) (anonymously, through GitHub's public API). When a newer release is published, a notice appears in the bottom-right corner:

- **Update with Claude Code** opens a terminal running Claude Code in the fork's checkout, the folder the installed app was built from. Claude is asked to merge the release on a new branch, keep the fork's features, run the typecheck, lint, and tests, rebuild the installer, and ask you before pushing or merging. The button appears only when that folder and the `claude` CLI are both on this machine.
- **Copy prompt** copies the same instructions to paste into Claude Code yourself.
- **Release notes** opens upstream's release page.
- **✕** hides the notice until the *next* upstream release.

Once the merge is done and you've rebuilt and installed it, the version matches upstream again and the notice goes away. `LH_UPSTREAM_CHECK=0` turns the check off.

### Use your Claude subscription (Claude Code)

This fork can run every agent on your Claude Pro/Max subscription instead of an API key, by routing model turns through your locally installed [Claude Code](https://claude.com/claude-code) CLI.

1. Install Claude Code and run `claude` once to sign in with your Claude account.
2. Start LearnHarness. When the `claude` CLI is found, **Claude Code (subscription)** appears under Settings → Keys as a detected provider; no key is needed.
3. Choose **Use recommended** in the setup dialog, or later **Settings → Agent → Claude subscription preset → Apply**. You can also pick the `claude-code` models yourself.

How it works: each conversation keeps one live `claude -p` process with Claude Code's own prompt, built-in tools, settings and MCP servers switched off. The app's tools are declared through a small MCP bridge. When the model calls one, the bridge hands the call to LearnHarness, which runs the real tool and passes the result back, so Claude Code keeps the true conversation and its own prompt caching. New learner messages go in on the open stdin. If the app's history no longer continues what the process has seen (compaction, a changed system prompt, a restart), a fresh process starts from the replayed transcript. Claude Code owns the sign-in. LearnHarness never sees or stores a credential, and `ANTHROPIC_API_KEY` is stripped from the CLI's environment so turns bill the subscription, not a key. `LH_CLAUDE_CODE_DEBUG=1` logs whether each model call continued a live process or started fresh.

**Usage on a Claude plan.** The preset routes work by how much a stronger model helps:

| Work | Model | Effort |
| --- | --- | --- |
| Probing, teaching, practice | Sonnet 5.5 | medium |
| Planning each lesson (one turn) | Opus 5.5 | medium |
| Research, graph extraction and its audit | Haiku 5.5 | low |
| Interactive demos | Sonnet 5.5 | low |
| Figures, PDF reading, source-material profiles | Sonnet 5.5 | low |

It also extracts the graph in 12k-token batches and compacts the context at 100k tokens. Measured on a Team plan: a 20-step lesson with graph extraction used about 4% of the 5-hour window and under 1% of the week. Each model call read the conversation from cache and wrote only the new part, about 6× less input-side usage than replaying the transcript every call. The **Plan** pill under the composer shows the 5-hour window, with the week in its tooltip, as Claude Code last reported it. The cost meter shows $0 for these models because they aren't billed per token.

Options: `LH_CLAUDE_CODE_BIN=/path/to/claude` pins the executable (useful when a GUI-launched app's `PATH` misses it), and `LH_CLAUDE_CODE=0` turns the provider off.

### Lesson language: English or Norwegian

Every lesson has a language, **English** or **Norsk (bokmål)**. The prober, teacher, and practice agents teach in it: messages, questions, options, plan labels, demos, and figures. The knowledge graph's propositions from that lesson are written in it, and dictation transcribes it.

- **Default:** Settings → General → *Default lesson language*. New lessons start in it; the language pill on the new-lesson screen sets the same default.
- **Per lesson:** the **EN / NO** pill next to the model picker, under the composer. Switching takes effect from the next turn; the agent continues in the new language even if earlier messages were in the other one.

Lessons created before this feature are treated as English.

### Source material

A lesson can carry source material: **PDFs** (textbooks, slides, past exams), **text or Markdown** (notes, a syllabus, exam rules), **images** (photographed pages, a whiteboard), and **web links**. Add it with the **Sources** pill under the composer, either on the new-lesson screen or at any time during a lesson.

- Each item is copied into the lesson (the data folder's `materials/`) and read once in the background with the vision model. That produces a *profile*: the material's targets, contents with page numbers, definitions, notation and terms, its approach, and its exercises. A new lesson waits for its material before the first question.
- **The material sets the lesson's target and scope.** Teaching uses its definitions, notation and terminology. The teacher may explain things its own way, add perspectives, and change the order, as long as every target in the material is met. It cites the material ("Definition 4.1, p. 1") and says when it goes beyond or differs from it.
- To quote exactly, the teacher looks passages up in the material itself (`material_search`, `material_read`); math-heavy PDF pages can be read visually.
- Material added mid-lesson is announced to the teacher once, so it can adjust the plan. Removing an item takes effect from the next turn.

### Courses: a curriculum to learn in full

A **course** turns a curriculum into a map of skills and tracks how much of it you know. Create one with **Courses → New** in the sidebar.

1. **Add the curriculum** (PDFs, notes, a syllabus, links) with the Sources pill on the course page, then **Draft skill map**. The course planner reads it and drafts specific, checkable skills ("Differentiate a composition with the chain rule"), with the prerequisites between them. It reuses skills other courses already have, and links each skill to what your knowledge graph already holds.
2. **Review the draft.** Ask for changes in your own words, or **Approve**: the skills join your knowledge graph, shared with every course that needs them.
3. **Find your starting point.** Right after approval the course offers a quick **placement test**: short multiple-choice questions, about one for every three skills, hardest first. A confident correct answer marks the skill and everything it requires as known, so you start at your weak spots instead of the most basic skill.
4. **Follow the route.** The course page shows **Next up** (skills whose prerequisites you have learned), **Learning** (learned, not yet known), **Locked** skills and what they need, **Known** skills, and skills **due for review**. Start a **Learn** lesson on one skill, **Practice** what you are learning, or **Review** what's due. A lesson ends with **Finish lesson** (top bar), or when the teacher sees you can do it: the skill is then learned, and the skills that build on it unlock.
5. **Skills you already have from another course** are listed under **From another course** with a **Quick check**: one or two problems in this course's terms, explaining only what works differently here. It's optional, and nothing is locked behind it.

The skills you know, across all courses, are listed on the home screen (top-left).

**Answer keys are checked before you see a question.** A question with Python code is run, and its real output must match the answer key. Anything that can't be run (math, concepts) is solved independently by a second model that never sees the key; set which model under Settings → Agent → **Answer checker** (a different, stronger model catches more). A question that fails goes back to the teacher to fix. The check needs Python 3 on your machine for code questions (`LH_PYTHON` picks a specific interpreter; `LH_ANSWER_CHECK=0` turns the whole check off).

**Known** is measured by spaced practice, in Leitner boxes 0–5. A finished lesson puts a skill in box 1 (learned). In course practice sessions every problem is tagged with the skills it tests. A hint-free solve moves the skill up a box, but only once it is due again (1, 3, 7, 16, 35 days). A hinted solve leaves it where it is, and giving up drops a learned skill back to box 1. A skill is known from box 3. In the placement test, a correct answer at confidence 70 or more marks the skill and all its prerequisites as known; a less sure correct answer marks it learned; a wrong answer changes nothing, except that a skill you got wrong is never marked known just because it is a prerequisite of one you got right.

### Local dictation

Dictation is transcribed **on your machine** with Whisper (transformers.js + onnxruntime). It's free, works offline after a one-time model download, and audio never leaves the computer. It runs on the **GPU** through WebGPU (on a laptop with two GPUs, the discrete one). Each language has its own model, chosen by benchmark on 99 s of FLEURS speech on an RTX 5060 laptop:

| Language | Model (GPU) | Download | Speed | Word error rate* |
| --- | --- | --- | --- | --- |
| English | `onnx-community/whisper-large-v3-turbo` (fp16) | ~1.6 GB | ~12× real time | large-model English |
| Norwegian | `Hjertelig/nb-whisper-large-ONNX` (q4), the National Library's Norwegian Whisper, large | ~1.3 GB | ~5× real time | 5.7% |

\*Norwegian, measured on FLEURS nb_no. The small model used before was 8.0%.

Dictation is **live**: the recording is cut at natural pauses (after at least 8 s of speech, never past 25 s), and each piece is transcribed while you keep talking, so its text appears in the field a few seconds behind your voice. At stop only the last piece is left: on a 3.6-minute recording the text was complete 1.2 s after stop, against 44 s when the whole recording was transcribed at the end, with fewer word errors too (6.8% vs 12.8%). Esc throws a dictation away, including the pieces it already added.

If the GPU path can't run (no WebGPU adapter, a driver error), dictation falls back to the small models on the CPU (`whisper-small` and `nb-whisper-small-ONNX`, q8, ~6× real time), and Settings → General shows that it did. A transcription that fails on the GPU is retried on the CPU, so a recording is never lost; a failed transcription keeps the recording, and **Retry** sends it again.

The model for a lesson's language downloads the first time you dictate in that language. The dictation bar shows the progress, or you can download in advance under Settings → General → Dictation. Models are stored in the app's data folder under `models/stt`. Transcription runs in a separate worker process that exits after 10 idle minutes to free its memory (~1 GB).

To use Deepgram's cloud engine instead, choose *Deepgram (cloud)* under Settings → General → Dictation engine and add a Deepgram key; it gets the lesson's language too.

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. You pay your providers for usage; a live cost meter shows model costs.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and cloud dictation also contact external services, and the fork's upstream release check reads GitHub's public API (no account, nothing sent but the request). Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no LLM, no network
```

See the [development guide](docs/development.md), [architecture](docs/architecture.md), and [desktop release guide](docs/desktop-release.md).

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues).

## License

[AGPL-3.0](LICENSE)

The app is free and open forever. If we ever charge for anything, it will be for convenience — managed keys, hosting — never for features you can run locally.
