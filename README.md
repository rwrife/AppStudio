# App Studio

App Studio is an AI-powered, no-code app builder that works from a **mind map**. You describe an idea, shape it into features, screens, data, integrations, UX design, architecture, business rules and constraints, and answer AI questions about the details. A coordinator runs **one sub-agent per code-output node**; instruction-only nodes go into **AGENTS.md** for current and future tasks.

> **Status:** proof of concept (v0.1). The full idea → map → interview → multi-agent build loop works end to end. Verification loops, re-planning, deployment and merge-conflict handling between agents are goals, not shipped features.

![Mind map with AI interview](docs/screenshots/blueprint.png)

## How it works

1. **Describe the idea.** **Start blueprint** saves the root `App` node and analyzes it automatically. AI gives it a short name and asks idea-specific questions about scope, target audience, runtime, how people will use it, and look and feel. For "I want a calculator," this could mean basic versus scientific, desktop versus web/mobile, and visual style—not a generic checklist.
2. **Save and analyze nodes.** Use **Add child**, enter the details, then **Save & analyze**. Leave **Node type** on **Auto-detect** for AI to classify it, or select a type yourself. AI names the node and adds zero to five follow-up questions only when needed. Rename the title at any time; future analysis preserves your chosen name and type. Naming and analysis use the selected provider/model, including **Local models**, not a separate service.
3. **Submit answers to expand the map.** Each question has an **Answer** button. It saves the response and uses the whole blueprint to ask relevant follow-ups and, when warranted, automatically create child nodes for concrete requirements in that answer. For example, "scientific calculator on desktop with a dark theme" can produce a feature, an architecture instruction, and a UX instruction. Typing alone never expands the map. Added nodes remain editable and removable. **Suggest branches** still offers a separate tray you explicitly accept.
4. **Connect related details.** In **Connections**, **Child of** controls the hierarchy; **Depends on (input from)** links a producer to its consumer (Save document → Open document); **Similar to** shares patterns without imposing build order. The map uses labeled solid, dashed-arrow and dotted links. Duplicate, dangling, self-referential and cyclic dependencies are rejected.
5. **Review and build.** Answers and acceptance criteria form each node's spec; **Needs detail** surfaces gaps. A current analysis with no follow-up questions counts as reviewed, but non-root nodes still need acceptance criteria. **Draft with AI** works from answered questions or analyzed details. The foundation agent scaffolds the app and writes `APP_STUDIO.md`, code-output sub-agents follow explicit dependencies, and an integration agent writes `BUILD_REPORT.md`.

Edits auto-save even before analysis. If AI analysis or answer review fails, the saved text is kept, an error is shown, and the same button retries. Analysis does not invent a successful result when the provider is unavailable.

### Node types and durable instructions

| Node types | Output |
| --- | --- |
| Feature, Screen, Data, Integration | Code, through a dedicated sub-agent |
| UX design, Architecture, Business rule, Constraint | Instructions in `AGENTS.md`, with node scope, details, answers, unresolved questions and acceptance criteria |

Each type has a distinct color shade and a text label. Instruction-only cards also show **AGENTS.md instructions** and a dashed border; they are not reported as coding-agent work.

Before each build, App Studio writes or refreshes a marked section in the output project's `AGENTS.md`. User-authored instructions outside that section are preserved. Agents are told to read it along with `APP_STUDIO.md`, so tooling, design and business decisions guide the foundation and later tasks. Editing the blueprint refreshes those instructions on the next build. Instruction-only nodes do not get a coding sub-agent or participate in code input/output dependencies; use hierarchy and similarity to describe their scope.

Explicit producer/consumer dependencies take priority over default data-first and parent-first ordering. Similarity links appear in the shared specification but do not add scheduling dependencies. Existing saved blueprints load with their original node types/names and an empty cross-connection list.

![Multi-agent build view](docs/screenshots/build.png)

Live logs, failures, skipped and cancelled tasks are shown honestly. A node is marked **Built** only when its agent succeeded.

## Model providers

App Studio never stores API keys. Open **Model & agents** (the chip at the top right) to choose a provider and a model you supply:

| Provider | What it uses | Setup |
| --- | --- | --- |
| **GitHub Copilot** | Your Copilot subscription via the [Copilot CLI](https://github.com/github/copilot-cli) | Install the CLI and sign in (`copilot`, then `/login`). Model IDs such as `auto`, `claude-sonnet-5.5` or `gpt-6.1-sol` are passed to `--model`. |
| **OpenAI Codex** | ChatGPT Plus/Pro/Team via the Codex CLI | `npm i -g @openai/codex`, then `codex login`. |
| **Claude** | Claude Pro/Max via Claude Code | Install Claude Code, then run `claude` and sign in. |
| **Local models** | Any OpenAI-compatible `/v1` server on your machine or network | See below. |

![Model settings](docs/screenshots/settings.png)

Prompts are sent to CLIs on stdin only, never as command-line arguments. Naming, analysis, answer review, interview and suggestion calls run without tools; only build agents get write access, and only inside the chosen output folder.

### Local models

**Local models** talks to any server that implements the OpenAI chat-completions API. With **Auto-detect** it probes these on `127.0.0.1`:

| Server | Default URL | Start it with |
| --- | --- | --- |
| [LM Studio](https://lmstudio.ai) | `http://127.0.0.1:1234/v1` | `lms server start` (models load on first request) |
| [Ollama](https://ollama.com) | `http://127.0.0.1:11434/v1` | `ollama serve`, then `ollama pull qwen3:14b` |
| [vLLM](https://docs.vllm.ai) | `http://127.0.0.1:8000/v1` | `vllm serve <model>` on Linux or WSL2 (vLLM does not run natively on Windows) |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | `http://127.0.0.1:8080/v1` | `llama-server -m model.gguf --jinja` |

You can also enter a custom URL (for example a vLLM box on your network). Blueprint text is sent to whichever server you choose. ComfyUI is not supported here because it serves image/diffusion workflows, not chat models.

Pick a served model in **Model**, or leave **First loaded model**. Models with tool calling (Qwen3, Llama 3.1+, Gemma 4, gpt-oss) build best. Local build agents get a sandboxed toolset — `list_files`, `read_file`, `write_file`, `finish` — confined to the output folder. If a server rejects tool calling, agents fall back to replying with `### FILE: path` blocks. **Local agents cannot run commands**, so install dependencies and run the generated tests yourself.

## Getting started

Requires Node.js 22+ on Windows, macOS or Linux.

```powershell
npm install
npm run dev
```

If npm's script policy blocked Electron's postinstall (you'll see "Electron failed to install correctly"), run `node node_modules\electron\install.js` once.

Build output goes to `Documents\App Studio\<blueprint name>` by default; choose another folder from the **Build** tab. After the first build, that folder is retained even if the blueprint is renamed, so its code and `AGENTS.md` stay together.

## Validation

```powershell
npm test          # analysis, prompts, connections, instructions, planning, process safety and local-agent builds
npm run typecheck
npm run build
npm run smoke     # launches the built app hidden, drives the full flow, refreshes docs/screenshots
```

Tests and the smoke run use `tests/fixtures/mock-openai.mjs`, a small OpenAI-compatible server, so they need no model or subscription. The desktop smoke covers the calculator interview, Answer-triggered expansion, automatic naming with manual overrides, type detection, connections, failure/retry persistence, instruction-only output and a full build. Mock results verify the workflow, not real-model question quality.

## Limitations

- Proof of concept: no verification loop or re-planning after a failed agent; failed tasks block their dependants.
- Parallel sub-agents share one output folder and are told to stay in their node's folder; conflicting edits to shared files are possible.
- Local agents have no shell, so they cannot install packages or run tests.
- The Copilot CLI flow has been verified with a real subscription. The Codex and Claude Code flags follow their documentation but have not yet been verified on a real install.
- Local servers usually process one request at a time, so extra parallel agents queue on your GPU.

## Project guidance

See [AGENTS.md](AGENTS.md) for architecture, the red design system and UX principles. The `design` and `ux` custom agents in [.github/agents](.github/agents) apply them when reviewing UI changes.
