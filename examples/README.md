# Example workflows

`brass-steam-calculator.blueprint.json` is a saved App Studio blueprint intended as an OOBE (out-of-box experience) example. It separates **build a calculator** into architecture, steampunk visual design, arithmetic rules, a safe calculation engine and a mobile calculator screen. The engine has calculation-output and history children; the screen has memory and copy-result children.

**Copy result** consumes **Calculation output** from the other branch. This demonstrates that a child's input dependency can cross the tree rather than only point to its parent. The hierarchy describes scope; explicit producer/consumer connections determine required build ordering. App Studio currently schedules all node agents centrally: nested nodes do **not** mean that a running agent recursively spawns more agents.

The JSON uses the normal `blueprintSchema` from `src/shared/types.ts`, not a separate workflow format. It preserves the node hierarchy, dependency/similarity connections, detailed requirements, AI analysis, answered questions and acceptance criteria. Build planning derives the foundation, code-node agents and final integration task from this source of truth. Architecture, design and rule nodes become managed `AGENTS.md` instructions instead of separate coding agents.

## Reusing it in onboarding

This is seed data for a future onboarding flow, not an automatically installed example. When offering **Start from an example**:

1. Read and validate the JSON with `blueprintSchema`.
2. Clone it rather than editing the checked-in example.
3. Give the blueprint a fresh ID and current creation/update timestamps. Node IDs are scoped to a blueprint; keep its internal references consistent.
4. Leave `outputDir` empty so the user chooses an output location. Keep the user's selected provider and model; the example contains neither credentials nor provider settings.
5. Save the clone through App Studio's normal persistence path and expose the onboarding action through MCP as required by `AGENTS.md`.
6. Show the map and build plan before starting any agents. Opening an example must not automatically run a build or claim that its nodes are built.

The checked-in workflow contains no generated application files, run logs, machine-specific output paths or built/failed statuses. Those belong in the user's chosen output directory, outside this repository. A build writes its own managed `AGENTS.md`, `BLUEPRINT.md`, `APP_STUDIO.md` and `BUILD_REPORT.md`.

`npm test` validates the example schema, its reviewed requirements and its deterministic build graph.
