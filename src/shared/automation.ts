import { z } from 'zod'
import { blueprintSchema, connectionSchema, endpointSchema, modelIdSchema, nodeKinds, providerIds, questionSchema, resourceModeSchema } from './types'
import type { NodeSize } from './layout'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const node = { nodeId: id }
const branch = z.object({ kind: z.enum(nodeKinds).exclude(['app']), title: z.string().min(1).max(120), summary: z.string().max(2000).default('') })
const perProviderPatch = <T extends z.ZodType>(schema: T) => z.object({ copilot: schema.optional(), codex: schema.optional(), claude: schema.optional(), local: schema.optional() }).strict()
const settingsPatch = z.object({
  provider: z.enum(providerIds).optional(),
  models: perProviderPatch(z.array(modelIdSchema).max(50)).optional(),
  selectedModel: perProviderPatch(modelIdSchema.or(z.literal(''))).optional(),
  binaryPaths: perProviderPatch(z.string().max(1000)).optional(),
  localEndpoint: endpointSchema.optional(),
  maxParallelAgents: z.number().int().min(1).max(6).optional(),
  mcpEnabled: z.boolean().optional()
}).strict()
const nodePatch = z.object({
  title: z.string().min(1).max(120).optional(),
  summary: z.string().max(2000).optional(),
  kind: z.enum(nodeKinds).optional(),
  resourceMode: resourceModeSchema.optional(),
  parentId: id.nullable().optional(),
  questions: z.array(questionSchema).max(40).optional(),
  acceptance: z.array(z.string().max(400)).max(30).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional()
}).strict()
export const viewportSchema = z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.2).max(1.6) })

// Each operation is also one MCP tool. Keep this registry and the exhaustive desktop handler in sync.
export const desktopCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('studio_get_state') }).describe('Read saved data, current draft, selected node, view, suggestions, provider availability, build plan, gaps, resource ownership problems, full build logs and project Build/Run activity, logs, errors and preview URL.'),
  z.object({ action: z.literal('mcp_copy_config') }).describe('Copy the running MCP server configuration to the local clipboard, including its current bearer token. Only on the user’s request. Does not return the token.'),
  z.object({ action: z.literal('blueprint_create'), idea: z.string().trim().min(3).max(2000), analyze: z.boolean().default(true) }).describe('Create and open a blueprint. Analyze its root by default, as Start blueprint does. AI failure leaves the new blueprint saved.'),
  z.object({ action: z.literal('blueprint_open'), blueprintId: id }).describe('Save the current draft and open an existing blueprint in the desktop.'),
  z.object({ action: z.literal('blueprint_rename'), blueprintId: id, name: z.string().trim().min(1).max(120) }).strict().describe('Rename a blueprint in the workspace list without changing its root requirements or output folder. The chosen name survives AI naming. Works during code generation; uses the same Rename control as the desktop.'),
  z.object({ action: z.literal('blueprint_save'), blueprint: blueprintSchema, expectedUpdatedAt: z.string() }).describe('Replace the active blueprint for batch editing; pass updatedAt from studio_get_state. Statuses are derived, never accepted as proof of a build. Output directory must be changed with build_set_output.'),
  z.object({ action: z.literal('blueprint_delete'), blueprintId: id, confirm: z.literal(true) }).describe('Delete a saved blueprint after explicit confirmation. Generated output is retained.'),
  z.object({ action: z.literal('node_add'), parentId: id, ...branch.partial().shape, position: nodePatch.shape.position, resourceMode: resourceModeSchema.optional() }).describe('Add and select a child, including during active code generation. Optional position is in map coordinates, equivalent to dragging the + point onto empty space. New nodes join the next rebuild, not the running task graph. Defaults to an auto-named, unspecified node. Resource nodes have no agent: resourceMode is managed (default, needs a Defines owner before building) or external (never created by an agent).'),
  z.object({ action: z.literal('node_update'), ...node, patch: nodePatch }).describe('Edit a node, including answers, criteria, parent, position and Resource provision mode (managed or external). Remove Defines before switching to external. Editing an answer does not submit it. Explicit titles are manual and survive analysis.'),
  z.object({ action: z.literal('node_rename'), ...node, title: z.string().trim().min(1).max(120) }).strict().describe('Rename a node through the same manual-title edit as Rename node in the inspector. AI analysis preserves the name. Existing nodes in the active code-generation plan remain read-only; newly added nodes may be renamed for the next rebuild.'),
  z.object({ action: z.literal('node_delete'), ...node, confirm: z.literal(true) }).describe('Delete a non-root node and its descendants and connections.'),
  z.object({ action: z.literal('connection_add'), connection: connectionSchema.omit({ id: true }).partial({ kind: true }) }).describe('Add dependency (source produces, target consumes), similar, defines (source owner creates target Resource) or references (source consumer uses target Resource). Omit kind for the same behavior as dragging the + point onto another node: dependency if valid, otherwise similarity. Each managed resource has one Defines owner: code-output nodes use their agent; App/Architecture owners use foundation. Instruction-only references also apply to foundation. Consumers wait for the owner to succeed. External resources have no owner. Cycles, conflicting owners, duplicates and dangling links are rejected.'),
  z.object({ action: z.literal('connection_update'), connectionId: id, patch: connectionSchema.omit({ id: true }).partial().strict() }).describe('Edit a relationship line’s type, source or target, as in its properties inspector. Swap sourceId and targetId to reverse direction. Changes are validated atomically; invalid cycles or instruction-node dependencies leave the original relationship intact.'),
  z.object({ action: z.literal('connection_delete'), connectionId: id }).describe('Remove a cross-connection from the active blueprint.'),
  z.object({ action: z.literal('node_analyze'), ...node }).describe('Save and analyze a node, applying its name/type, questions and analysis result exactly like Save & analyze.'),
  z.object({ action: z.literal('node_interview'), ...node }).describe('Ask for and append new interview questions for a node.'),
  z.object({ action: z.literal('question_answer'), ...node, questionId: id, answer: z.string().trim().min(1).max(4000) }).describe('Explicitly submit an answer, review it with AI and apply the resulting child nodes and follow-up questions. Saves the answer even if AI fails.'),
  z.object({ action: z.literal('branches_suggest'), ...node }).describe('Ask AI for branches and show them in the desktop suggestion tray without adding nodes.'),
  z.object({ action: z.literal('branches_accept'), indices: z.array(z.number().int().nonnegative()).min(1).max(400) }).describe('Accept selected zero-based indices from the current suggestion tray and persist the new children.'),
  z.object({ action: z.literal('branches_dismiss') }).describe('Dismiss the suggestion tray without adding nodes.'),
  z.object({ action: z.literal('acceptance_draft'), ...node }).describe('Draft acceptance criteria with AI and append them to the node.'),
  z.object({ action: z.literal('map_tidy') }).describe('Arrange the active mind map with the same layout as Tidy and fit it in the viewport.'),
  z.object({ action: z.literal('desktop_set_view'), tab: z.enum(['map', 'build']).optional(), nodeId: id.optional(), edgeId: z.string().max(128).optional(), taskId: z.string().max(128).optional(), settingsOpen: z.boolean().optional(), discardSettingsEdits: z.boolean().default(false) }).describe('Switch Blueprint/Build tabs, select a node, relationship line (edgeId link-<connectionId> or child-<childNodeId>) or build task/log, or open/close Model & agents. Closing edited settings requires explicit discardSettingsEdits.'),
  z.object({ action: z.literal('map_viewport'), viewport: viewportSchema.optional() }).describe('Pan/zoom the visible map to x/y/zoom, or fit all nodes when viewport is omitted.'),
  z.object({ action: z.literal('desktop_scroll'), panel: z.enum(['workspace', 'inspector', 'center', 'settings', 'log', 'projectLog']), top: z.number().finite().min(0).max(1_000_000) }).describe('Scroll an App Studio panel to a vertical pixel offset, for inspecting off-screen settings, questions, agent logs or project Build/Run logs. Returns actual position and scroll extent.'),
  z.object({ action: z.literal('settings_update'), patch: settingsPatch }).describe('Save provider, model lists/selection, CLI paths, local endpoint, parallelism or mcpEnabled. Omitted fields and providers are preserved. Close the settings dialog first. Disabling MCP revokes new requests immediately.'),
  z.object({ action: z.literal('providers_refresh') }).describe('Re-detect provider CLIs and local models and refresh the desktop provider list.'),
  z.object({ action: z.literal('provider_test') }).describe('Test the selected saved provider and model with a real read-only READY request.'),
  z.object({ action: z.literal('build_set_output'), directory: z.string().min(1).max(1000) }).describe('Set an absolute build output directory without a native file-picker dialog.'),
  z.object({ action: z.literal('build_start'), allowGaps: z.boolean().default(false) }).describe('Start/rebuild the active blueprint. Requires an available provider; unfinished detail requires explicit allowGaps (Build anyway). CLI agents may write files and execute commands in the output folder.'),
  z.object({ action: z.literal('build_cancel') }).describe('Request cancellation of the running build; inspect state until tasks have stopped.'),
  z.object({ action: z.literal('build_reveal') }).describe('Open the active blueprint output folder in the operating system file manager.'),
  z.object({ action: z.literal('project_build') }).strict().describe('Build the generated project, not regenerate it. The selected CLI agent inspects the actual stack and chooses dependency/build commands; App Studio executes them in the output folder with live logs. Requires code generation and other project actions to be idle. Returns immediately: poll snapshot.projectActivity in studio_get_state for completion/failure. Executes project code with the user’s permissions; local models cannot do this.'),
  z.object({ action: z.literal('project_run') }).strict().describe('Run the generated app. A CLI agent determines prerequisites and a foreground launch command for the actual stack. App Studio manages the process, verifies and opens a loopback web preview when applicable. Returns immediately; poll snapshot.projectActivity for readiness or failure. Does not accept arbitrary commands.'),
  z.object({ action: z.literal('project_stop') }).strict().describe('Stop the current project Build/Run action, including its AI preparation or owned app process tree. Separate from build_cancel, which stops code generation.'),
  z.object({ action: z.literal('project_open') }).strict().describe('Reopen the active project’s currently running, verified local web preview in the default browser. Native and console apps have no preview URL.'),
  z.object({ action: z.literal('desktop_dismiss_error') }).describe('Dismiss the desktop error banner.')
])
export type DesktopCommand = z.infer<typeof desktopCommandSchema>

export const windowCommandSchema = z.object({
  operation: z.enum(['state', 'focus', 'minimize', 'maximize', 'restore', 'resize']),
  width: z.number().int().min(1100).max(3840).optional(),
  height: z.number().int().min(740).max(2160).optional()
})
export type WindowCommand = z.infer<typeof windowCommandSchema>

export interface MapControl {
  getNodeSizes(): ReadonlyMap<string, NodeSize>
  getViewport(): z.infer<typeof viewportSchema>
  setViewport(viewport: z.infer<typeof viewportSchema>): Promise<boolean>
  fitView(): Promise<boolean>
}
