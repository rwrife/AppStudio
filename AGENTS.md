# Agent guidance

## Project goal

App Studio is a mind-map driven AI app builder. A user describes an app idea, shapes it into a mind map where every node is one detail of the application (a feature, screen, data model, integration, rule or constraint), answers AI-generated questions for each node, and then lets a coordinator agent run one sub-agent per buildable node to generate the app.

The current product is a local Electron proof of concept. AI work runs through the CLI of a subscription the user already has — GitHub Copilot CLI, OpenAI Codex CLI or Claude Code — with the user choosing the model ID. A built-in Demo provider returns canned responses so the full flow can be exercised offline. Treat broader capabilities (verification loops, re-planning, deployment, merge conflict resolution between agents) as goals, not shipped features.

## Repository layout

- `src/main`: Electron lifecycle, IPC handlers, blueprint/settings persistence (`studio.ts`), provider adapters (`providers.ts`) and safe CLI process spawning (`process.ts`).
- `src/preload`: the narrow, isolated `window.studio` bridge.
- `src/renderer`: React UI — app shell (`App.tsx`), React Flow mind map (`MindMap.tsx`), node inspector, build view and settings modal. All styling lives in `style.css`.
- `src/shared`: zod schemas and types, build planning and completeness (`plan.ts`), prompts and model-response parsing (`prompts.ts`), and tree layout.
- `tests`: Node test-runner tests for planning, prompts, process safety and an end-to-end Demo-provider build.
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
- Ask-mode calls (interview, branch suggestions, acceptance criteria) must not grant tools or write access. Only build agents get write access, and only inside the chosen output folder.
- The blueprint is the source of truth. Build planning must stay deterministic and acyclic: foundation first, one agent per buildable node, integration last. `rule` and `constraint` nodes are context for other agents, not agents themselves.
- Be honest about status. Never show a node or build as built when an agent failed, was skipped or was cancelled, and never present Demo output as generated code.
- Keep blueprints backward compatible with persisted JSON or add an explicit migration.
- Keep generated apps, user data, logs and build output out of Git.

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
- Node kinds have quiet, distinct hues: app (accent border), feature (warm neutral), screen (plum), data (slate blue), integration (teal), rule/constraint (dashed neutral border).

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

1. **AI asks before it builds.** Every buildable node should be interviewed and have acceptance criteria before the build. Gaps are surfaced (Needs detail strip, build warning) but the user can explicitly choose **Build anyway**.
2. **One obvious next step.** Each panel has at most one primary action. The left step list always reflects real progress through Idea → Mind map → Questions → Build.
3. **Honest, visible status.** Show what the agents are doing, live logs, failures with reasons, and skipped/cancelled tasks. Demo results are labelled as placeholders.
4. **The user stays in control.** Suggestions arrive in a tray the user accepts or edits; nothing is added to the map silently. Editing locks while a build runs, and builds can be stopped.
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
```

`npm run smoke` launches the built app hidden with the Demo provider, drives idea → branches → interview → build, and rewrites the screenshots in `docs/screenshots`. Real provider checks need the relevant CLI installed and signed in; do not fake or assume a provider result.

## README maintenance

- Update `README.md` in the same change whenever adding or materially changing a user-facing feature, setup step, provider or limitation.
- Use actual UI labels and working commands. Refresh screenshots with `npm run smoke` and inspect them before committing; omit private paths and personal data.
- Distinguish shipped behaviour from goals, and report real provider results rather than assuming them.
