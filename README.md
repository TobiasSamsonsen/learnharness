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

### Use your Claude subscription (Claude Code)

This fork can run every agent on your Claude Pro/Max subscription instead of an API key, by routing model turns through your locally installed [Claude Code](https://claude.com/claude-code) CLI.

1. Install Claude Code and run `claude` once to sign in with your Claude account.
2. Start LearnHarness. When the `claude` CLI is found, **Claude Code (subscription)** appears under Settings → Keys as a detected provider; no key is needed.
3. In the model pickers, choose the `claude-code` models (e.g. `claude-sonnet-5-5` for the strong slot, `claude-haiku-5-5` for the cheap slot).

How it works: each model turn runs `claude -p` with Claude Code's own prompt, tools, settings, and MCP servers switched off. The app's tools are declared to the model through a do-nothing MCP stub, so its tool calls come back to LearnHarness, which runs them as it does for any provider. Claude Code owns the sign-in. LearnHarness never sees or stores a credential, and `ANTHROPIC_API_KEY` is stripped from the CLI's environment so turns bill the subscription, not a key.

Trade-offs: each turn starts a CLI process (a few seconds of overhead), the conversation is replayed as one transcript per turn, and usage counts against your plan's limits. The cost meter shows $0 for these models because they aren't billed per token.

Options: `LH_CLAUDE_CODE_BIN=/path/to/claude` pins the executable (useful when a GUI-launched app's `PATH` misses it), and `LH_CLAUDE_CODE=0` turns the provider off.

### Lesson language: English or Norwegian

Every lesson has a language, **English** or **Norsk (bokmål)**. The prober, teacher, and practice agents teach in it: messages, questions, options, plan labels, demos, and figures. The knowledge graph's propositions from that lesson are written in it, and dictation transcribes it.

- **Default:** Settings → General → *Default lesson language*. New lessons start in it; the language pill on the new-lesson screen sets the same default.
- **Per lesson:** the **EN / NO** pill next to the model picker, under the composer. Switching takes effect from the next turn; the agent continues in the new language even if earlier messages were in the other one.

Lessons created before this feature are treated as English.

### Local dictation

Dictation is transcribed **on your machine** with Whisper (transformers.js + onnxruntime, CPU). It's free, works offline after a one-time model download, and audio never leaves the computer. Each language has its own model, chosen by benchmark on FLEURS:

| Language | Model | Download | Word error rate* |
| --- | --- | --- | --- |
| English | `onnx-community/whisper-small` (q8) | ~250 MB | ~5% |
| Norwegian | `onnx-community/nb-whisper-small-ONNX` (q8), the National Library's Norwegian Whisper | ~410 MB | ~6% |

\*Measured on a handful of clips; a laptop CPU transcribes 10 s of speech in about 2 s.

The model for a lesson's language downloads the first time you dictate in that language. The dictation bar shows the progress, or you can download in advance under Settings → General → Dictation. Models are stored in the app's data folder under `models/stt`. Transcription runs in a separate worker process that exits after 10 idle minutes to free its memory (~1 GB).

To use Deepgram's cloud engine instead, choose *Deepgram (cloud)* under Settings → General → Dictation engine and add a Deepgram key; it gets the lesson's language too.

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. You pay your providers for usage; a live cost meter shows model costs.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
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
