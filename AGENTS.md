# Agent guidance

## Project goal

App Studio is a mind-map driven AI app builder. A user describes an app idea, shapes it into a mind map where every node is one detail of the application (a feature, screen, data model, integration, rule or constraint), answers AI-generated questions for each node, and then lets a coordinator agent run one sub-agent per buildable node to generate the app.

The current product is a local Electron proof of concept. AI work runs through the CLI of a subscription the user already has — GitHub Copilot CLI, OpenAI Codex CLI or Claude Code — with the user choosing the model ID — or through **Local models**: any OpenAI-compatible server on the user's machine or network (LM Studio, Ollama, llama.cpp, or vLLM on Linux/WSL). Treat broader capabilities (verification loops, re-planning, deployment, merge conflict resolution between agents) as goals, not shipped features.

## Repository layout

- `src/main`: Electron lifecycle, IPC handlers, blueprint/settings persistence (`studio.ts`), provider adapters (`providers.ts`), the local-model client and sandboxed file-tool agent (`local.ts`) and safe CLI process spawning (`process.ts`).
- `src/preload`: the narrow, isolated `window.studio` bridge.
- `src/renderer`: React UI — app shell (`App.tsx`), React Flow mind map (`MindMap.tsx`), node inspector, build view and settings modal. All styling lives in `style.css`.
- `src/shared`: zod schemas and types, build planning and completeness (`plan.ts`), prompts and model-response parsing (`prompts.ts`), and tree layout.
- `tests`: Node test-runner tests for planning, prompts, process safety, local-agent path sandboxing and an end-to-end Local-models build against `tests/fixtures/mock-openai.mjs`.
- `scripts/smoke.mjs`: Playwright-driven desktop smoke test that also refreshes `docs/screenshots`.

## Development

Run commands from the repository root in PowerShell:

```powershell
npm install
npm run dev
```

If Electron's postinstall was blocked by npm script policy, run `node node_modules\electron\install.js` once. `npm run build` type checks and builds; `npm start` opens the build.

## Implementation principles

- Prompts are sent to provider CLIs on **stdin only**. Never interpolate user or model text into command-line arguments; arguments must pass `assertSafeArgs`.
- Never collect, store or proxy API keys or subscription credentials. Authentication belongs to each CLI's own login flow.
- Preserve Electron context isolation, sandboxing, deny-by-default navigation/permissions, IPC sender validation and zod validation at every IPC and filesystem boundary.
- Ask-mode calls (node analysis/naming, answer review, interview, branch suggestions, acceptance criteria) must not grant tools or write access. Only build agents get write access, and only inside the chosen output folder.
- Local-model agents only get `list_files`, `read_file`, `write_file` and `finish`. Every model-supplied path goes through `safePath` (relative only, no traversal, no `.git`/`.app-studio`, no symlink escapes). Do not add shell or network tools without an explicit design review.
- The blueprint is the source of truth. Build planning must stay deterministic and acyclic: foundation first, one agent per buildable node, integration last. `ux`, `architecture`, `rule` and `constraint` nodes are instruction-only: write their scoped details, answers and acceptance criteria to the output project's managed `AGENTS.md` section before building, preserving instructions outside that section.
- Child links use `parentId`; cross-connections use `connections`. A dependency's `sourceId` produces output consumed by `targetId`. Explicit dependencies must never be silently dropped; inferred data/parent ordering yields when it would create a cycle. Similarity provides context without ordering tasks.
- New manual nodes start `unspecified`. Analysis may classify only those nodes, and may rename only nodes with `titleSource: 'auto'`. Legacy nodes and manually renamed titles must be preserved. Answer review can add concrete child requirements and new questions only on explicit Answer submission.
- Be honest about status. Never show a node or build as built when an agent failed, was skipped or was cancelled, or when an agent wrote no files.
- Keep blueprints backward compatible with persisted JSON or add an explicit migration.
- Keep generated apps, user data, logs and build output out of Git.

## MCP coverage is required

- Every user-facing capability must have a typed, discoverable MCP tool so agents can fully operate both the application's functionality and its desktop interface. Do not ship UI-only workflows.
- Maintain the tool registry in `src/shared/automation.ts` and its exhaustive handler in `src/renderer/App.tsx`. Use the same UI handlers, validation, persistence, AI result application, busy/build locks and error reporting as a person using the app. Do not implement a second, divergent model of the application.
- Cover blueprint and node editing, questions and answers, branch suggestions, connections, layout, provider/settings management, build planning/start/cancel/output/logs, and desktop navigation, selection, viewport, window controls and screenshots. New capabilities must extend the tools and their integration coverage in the same change.
- Keep `src/main/mcp.ts` loopback-only and authenticated, reject browser origins/untrusted hosts, bound requests, and validate inputs at the MCP and IPC boundaries. Never expose arbitrary JavaScript evaluation, unrestricted shell execution or OS-wide keyboard/mouse control through the desktop server.
- Preserve the **Enable local MCP server** setting, default off for new and legacy installations. Disabling must immediately revoke new calls; already-started operations may finish, and builds have their own cancellation. Shut down the listener when the app exits.
- Local MCP bearer tokens are application-control secrets, not provider credentials. Generate them in memory, rotate them on each enable/restart, never persist/log them or include them in screenshots/tool state, and copy connection configuration only at the user's request.
- Test discovery and real MCP protocol calls plus desktop-visible and persisted outcomes with `npm run smoke:mcp`. Include validation errors, unsaved edits, stale writes, busy/build locks, failed AI, disable/re-enable, authentication and lifecycle behavior. Do not claim parity based only on tools being listed.
- The server exposes App Studio to external MCP clients. It is not an MCP client for build agents; do not claim external-server access for local models or provider integrations that have not been implemented.

## Design system

App Studio shares CharacterStudio's layout language and component vocabulary, re-themed from green to **red**. Tokens are defined once at the top of `src/renderer/style.css`; use the variables, do not hard-code new colours.

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `--bg` / `--panel` / `--canvas` | `#141111` / `#1b1616` / `#110d0d` | App background, side panels, map viewport |
| `--line` / `--line-strong` | `#352b2b` / `#4a3939` | Dividers and control borders |
| `--text` / `--text-soft` / `--muted` | `#ece3e2` / `#c9b9b7` / `#988b8a` | Primary, secondary and helper text |
| `--accent` / `--accent-hover` / `--accent-ink` | `#f28b82` / `#ffaba3` / `#3b1412` | Primary actions, selection, active step, progress |
| `--tint` / `--tint-strong` / `--tint-border` / `--tint-text` | `#2c1d1c` / `#3d2524` / `#6e3e3b` / `#f3cbc6` | Secondary buttons, selected rows, chips |
| `--success` | `#9fd6ae` | Built, available, passed |
| `--warning` | `#e3bd7d` | Needs detail, missing CLI, queued |
| `--danger` | `#ff6f61` on `#461b18` | Failures and destructive actions |

- **Red is the brand accent, not the error signal.** Because the accent is red, errors must always pair `--danger` with an icon and explicit text (and a filled danger background where it is a banner or pill). Never communicate failure by colour alone.
- Success stays green and warnings amber so status never competes with the accent.
- Node kinds have quiet, distinct hues defined by `--node-*` tokens: app (accent), feature (warm neutral), screen (plum), data (slate), integration (teal), UX design (mauve), architecture (blue), business rule (amber), constraint (sage). Instruction-only cards have a dashed border and an AGENTS.md label; color alone is not the signal.

### Layout

- 70px topbar: brand mark + `app studio` wordmark and version at left, centred workspace tabs (**Blueprint** / **Build**), model chip at right.
- Three-column body: 248px workflow panel, flexible centre viewport (min 420px), 320px inspector. A 31px footer shows the pipeline breadcrumb and active provider.
- Centre panels start with a scene heading (kicker + title + tag) and an optional compact toolbar (`.view-tabs`); the viewport is a rounded, bordered canvas.

### Typography

- `Segoe UI Variable`, 13px base. Panel titles 21px/600, scene titles 17px/600.
- Section kickers are uppercase, 9px, weight 650, 1.65px letter spacing, numbered where they map to the workflow (`02 / DETAIL NODE`).
- Helper text uses `--muted` at 11–12px with 1.6 line height. Monospace only for logs and file paths.

### Components

- **Primary button** (`.primary`): accent fill, accent-ink text, one per panel at most.
- **Secondary button** (`.secondary`): tint fill with tint border. Icon buttons are transparent until hover.
- **Step list**: numbered circles that become a check when done and accent when active; each step has a title, short status and trailing icon.
- **Status pills**: Draft, Needs detail, Ready (accent outline), Queued (amber), Building (accent fill), Built (green), Failed (danger fill).
- **Mind cards**: kind tag, status pill, title, two-line summary, completeness meter and an accent `+` add-child handle on hover/selection.
- **Banners and checks**: success/warning/danger variants always include an icon, a bold line and a sentence that says what to do next.
- Use `lucide-react` icons at 12–16px. Do not mix icon sets.

## UX principles

1. **AI asks before it builds.** Every buildable node should be interviewed or analyzed and have acceptance criteria before the build. A current analysis may legitimately find no follow-up questions necessary. Initial questions adapt to the idea's scope, audience, platform, usage and visual design. Gaps are surfaced (Needs detail strip, build warning) but the user can explicitly choose **Build anyway**.
2. **One obvious next step.** Each panel has at most one primary action. The left step list always reflects real progress through Idea → Mind map → Questions → Build.
3. **Honest, visible status.** Show what the agents are doing, live logs, failures with reasons, and skipped/cancelled tasks. Local agents cannot run commands, and the build view says so.
4. **The user stays in control.** Branch suggestions arrive in a tray the user accepts or edits. Explicit Answer submission may automatically add child nodes grounded in that answer, with visible result counts; typing alone must not expand the map. Names and types the user chose are never overwritten by analysis. Editing locks while a build or AI request runs, and builds can be stopped.
5. **Your subscription, your machine.** Make it clear which provider and model will be used and that credentials stay with the CLI. Explain permission implications before agents run.
6. **Empty states teach.** Empty views explain what will appear and how to get there, in one or two sentences.
7. **Accessible by default.** Every icon button has an `aria-label`, focus is visible (2px accent outline), dialogs are labelled, and colour is never the only signal.

The `design` and `ux` custom agents in `.github/agents` apply these rules when reviewing or changing the UI.

## Validation

```powershell
npm test
npm run typecheck
npm run build
npm run smoke
npm run smoke:mcp
```

`npm run smoke` launches the built app hidden against the mock OpenAI-compatible server, drives calculator idea → analysis → Answer expansion → typed connections → build, verifies AGENTS.md and failure recovery, and rewrites the screenshots in `docs/screenshots`. Real provider checks need the relevant CLI installed and signed in; do not fake or assume a provider result.

## README maintenance

- Update `README.md` in the same change whenever adding or materially changing a user-facing feature, setup step, provider or limitation.
- Use actual UI labels and working commands. Refresh screenshots with `npm run smoke` and inspect them before committing; omit private paths and personal data.
- Distinguish shipped behaviour from goals, and report real provider results rather than assuming them.
