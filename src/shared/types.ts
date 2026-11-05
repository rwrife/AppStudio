import { z } from 'zod'

export const nodeKinds = ['app', 'unspecified', 'feature', 'screen', 'data', 'integration', 'resource', 'ux', 'architecture', 'rule', 'constraint'] as const
export type NodeKind = typeof nodeKinds[number]
export const contextKinds: readonly NodeKind[] = ['ux', 'architecture', 'rule', 'constraint']
export const connectionKinds = ['dependency', 'similar', 'defines', 'references'] as const
export const resourceModeSchema = z.enum(['managed', 'external'])

export const nodeStatuses = ['draft', 'ready', 'queued', 'building', 'built', 'failed'] as const
export type NodeStatus = typeof nodeStatuses[number]

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const text = (max: number) => z.string().max(max)

export const questionSchema = z.object({
  id,
  question: text(600).min(1),
  why: text(400).default(''),
  answer: text(4000).default(''),
  reviewedAnswer: text(4000).optional()
})
export type Question = z.infer<typeof questionSchema>

export const mindNodeSchema = z.object({
  id,
  parentId: id.nullable(),
  kind: z.enum(nodeKinds),
  resourceMode: resourceModeSchema.optional(),
  title: text(120).min(1),
  titleSource: z.enum(['auto', 'manual']).optional(),
  summary: text(2000).default(''),
  questions: z.array(questionSchema).max(40).default([]),
  acceptance: z.array(text(400)).max(30).default([]),
  analysis: z.object({
    title: text(120),
    summary: text(2000),
    kind: z.enum(nodeKinds),
    message: text(600),
    noFollowUps: z.boolean()
  }).optional(),
  status: z.enum(nodeStatuses).default('draft'),
  position: z.object({ x: z.number().finite(), y: z.number().finite() })
})
export type MindNode = z.infer<typeof mindNodeSchema>

export const connectionSchema = z.object({
  id,
  sourceId: id,
  targetId: id,
  kind: z.enum(connectionKinds)
})
export type NodeConnection = z.infer<typeof connectionSchema>

type BlueprintGraph = { nodes: MindNode[]; connections: NodeConnection[] }

export const isCodeNode = (node: Pick<MindNode, 'kind'>) =>
  node.kind !== 'app' && node.kind !== 'resource' && !contextKinds.includes(node.kind)

export const canDefineResource = (node: Pick<MindNode, 'kind'>) =>
  isCodeNode(node) || node.kind === 'app' || node.kind === 'architecture'

export const executionTaskId = (node: MindNode) =>
  node.kind === 'resource' ? undefined : isCodeNode(node) ? `agent-${node.id}` : 'foundation'

export function resourceOwner(blueprint: BlueprintGraph, resourceId: string) {
  const link = blueprint.connections.find(item => item.kind === 'defines' && item.targetId === resourceId)
  return blueprint.nodes.find(node => node.id === link?.sourceId)
}

/** Scheduling edges shared by validation and planning; resource references never become standalone tasks. */
export function buildDependencies(blueprint: BlueprintGraph) {
  const nodes = new Map(blueprint.nodes.map(node => [node.id, node]))
  const dependencies = new Map<string, Set<string>>([['foundation', new Set()]])
  for (const node of blueprint.nodes) if (isCodeNode(node)) dependencies.set(`agent-${node.id}`, new Set(['foundation']))
  for (const link of blueprint.connections) {
    const source = nodes.get(link.sourceId), target = nodes.get(link.targetId)
    if (!source || !target) continue
    if (link.kind === 'dependency' && isCodeNode(source) && isCodeNode(target))
      dependencies.get(`agent-${target.id}`)!.add(`agent-${source.id}`)
    if (link.kind === 'references' && target.kind === 'resource' && target.resourceMode !== 'external') {
      const owner = resourceOwner(blueprint, target.id)
      const producer = owner && executionTaskId(owner), consumer = executionTaskId(source)
      if (producer && consumer && producer !== consumer) dependencies.get(consumer)?.add(producer)
    }
  }
  return dependencies
}

export const blueprintSchema = z.object({
  id,
  name: text(120).min(1),
  nameSource: z.enum(['auto', 'manual']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  outputDir: text(1000).default(''),
  nodes: z.array(mindNodeSchema).min(1).max(400),
  connections: z.array(connectionSchema).max(2000).default([])
}).superRefine((blueprint, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: 'custom', message })
  const nodes = new Map(blueprint.nodes.map(node => [node.id, node]))
  if (nodes.size !== blueprint.nodes.length) problem('Node IDs must be unique.')
  if (blueprint.nodes.filter(node => node.parentId === null).length !== 1) problem('A blueprint needs exactly one root node.')
  for (const node of blueprint.nodes) {
    if ((node.parentId === null) !== (node.kind === 'app')) problem('Only the root node can have the App type.')
    if (node.kind !== 'resource' && node.resourceMode !== undefined) problem('Only Resource nodes can have a resource provision mode.')
    const seen = new Set([node.id])
    let parentId = node.parentId
    while (parentId) {
      if (seen.has(parentId)) { problem('Child connections cannot form a cycle.'); break }
      seen.add(parentId)
      const parent = nodes.get(parentId)
      if (!parent) { problem('A node references a missing parent.'); break }
      parentId = parent.parentId
    }
  }
  const ids = new Set<string>(), pairs = new Set<string>()
  const owners = new Set<string>()
  for (const link of blueprint.connections) {
    if (ids.has(link.id)) problem('Connection IDs must be unique.')
    ids.add(link.id)
    const pair = link.kind === 'similar' ? [link.sourceId, link.targetId].sort() : [link.sourceId, link.targetId]
    const key = JSON.stringify([link.kind, ...pair])
    if (pairs.has(key)) problem('This connection already exists.')
    pairs.add(key)
    const source = nodes.get(link.sourceId), target = nodes.get(link.targetId)
    if (!source || !target) { problem('A connection references a missing node.'); continue }
    if (source.id === target.id) problem('A node cannot connect to itself.')
    if (link.kind === 'dependency') {
      if (![source, target].every(isCodeNode))
        problem('Input/output dependencies connect code-output nodes. Use Defines and References for resources.')
    }
    if (link.kind === 'defines' || link.kind === 'references') {
      if (target.kind !== 'resource' || source.kind === 'resource')
        problem('Defines and References must point from a non-resource node to a Resource node.')
      if (link.kind === 'defines') {
        if (!canDefineResource(source)) problem('Only code-output, App or Architecture nodes can define a resource.')
        if (target.resourceMode === 'external') problem('Externally provided resources cannot have a Defines owner.')
        if (owners.has(target.id)) problem('A resource can have only one Defines owner.')
        owners.add(target.id)
      }
    }
  }
  const dependencies = buildDependencies(blueprint)
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return false
    if (visited.has(nodeId)) return true
    visiting.add(nodeId)
    for (const dependency of dependencies.get(nodeId) ?? []) if (!visit(dependency)) return false
    visiting.delete(nodeId)
    visited.add(nodeId)
    return true
  }
  for (const taskId of dependencies.keys()) if (!visit(taskId)) { problem('Build dependencies cannot form a cycle, including resource owners and foundation.'); break }
})
export type Blueprint = z.infer<typeof blueprintSchema>

export const providerIds = ['copilot', 'codex', 'claude', 'local'] as const
export type ProviderId = typeof providerIds[number]

export const modelIdSchema = z.string().regex(/^[a-zA-Z0-9._:/@-]{1,120}$/, 'Model IDs may only contain letters, digits and . _ : / @ -')

/** Base URL of an OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM). Empty means auto-detect. */
export const endpointSchema = z.string().trim().max(300).refine(value => {
  if (!value) return true
  try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password } catch { return false }
}, 'Use an http:// or https:// URL without credentials, e.g. http://127.0.0.1:11434/v1')

const perProvider = <T extends z.ZodType>(schema: T) => z.object({ copilot: schema, codex: schema, claude: schema, local: schema })

export const providerSettingsSchema = z.object({
  provider: z.enum(providerIds),
  models: perProvider(z.array(modelIdSchema).max(50).default([])),
  selectedModel: perProvider(modelIdSchema.or(z.literal('')).default('')),
  maxParallelAgents: z.number().int().min(1).max(6),
  binaryPaths: perProvider(text(1000).default('')),
  localEndpoint: endpointSchema.default(''),
  mcpEnabled: z.boolean().default(false)
})
export type ProviderSettings = z.infer<typeof providerSettingsSchema>

export interface ProviderInfo {
  id: ProviderId
  label: string
  subscription: string
  binary: string
  installed: boolean
  version?: string
  detail: string
  installHint: string
  loginHint: string
  suggestedModels: string[]
  /** Local provider only: the server that answered and the models it serves. */
  endpoint?: string
  serverModels?: string[]
}

export interface InterviewResult { questions: Question[] }
export interface NodeAnalysisResult extends InterviewResult { kind: NodeKind; title: string; message: string }
export interface BranchSuggestion { kind: NodeKind; title: string; summary: string }
export interface AnswerResult extends InterviewResult { branches: BranchSuggestion[] }

export const buildTaskStatuses = ['waiting', 'running', 'done', 'failed', 'cancelled', 'skipped'] as const
export type BuildTaskStatus = typeof buildTaskStatuses[number]

export interface BuildTask {
  id: string
  nodeId: string
  title: string
  role: 'coordinator' | 'agent'
  dependsOn: string[]
  status: BuildTaskStatus
  log: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

export interface BuildRun {
  id: string
  blueprintId: string
  provider: ProviderId
  model: string
  outputDir: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  tasks: BuildTask[]
  nodeIds?: string[]
}

export const projectActionSchema = z.enum(['build', 'run'])
export type ProjectAction = z.infer<typeof projectActionSchema>
export const projectActivitySchema = z.object({
  id, blueprintId: id, outputDir: text(1000), action: projectActionSchema,
  provider: z.enum(providerIds), model: text(120),
  status: z.enum(['preparing', 'running', 'stopping', 'done', 'failed', 'stopped']),
  startedAt: z.string(), finishedAt: z.string().optional(),
  log: text(120_000), error: text(4000).optional(), url: text(300).optional()
})
export type ProjectActivity = z.infer<typeof projectActivitySchema>
export function projectIsActive(activity?: ProjectActivity) {
  return !!activity && ['preparing', 'running', 'stopping'].includes(activity.status)
}

export interface Snapshot {
  blueprints: Blueprint[]
  settings: ProviderSettings
  run?: BuildRun
  buildStarting?: boolean
  projectActivity?: ProjectActivity
}

export interface StudioApi {
  mcpStatus(): Promise<McpStatus>
  copyMcpConfig(): Promise<void>
  setOutputDir(blueprintId: string, directory: string): Promise<Blueprint>
  onCommand(callback: (command: import('./automation').DesktopCommand) => Promise<unknown>): () => void
  snapshot(): Promise<Snapshot>
  providers(): Promise<ProviderInfo[]>
  saveSettings(settings: ProviderSettings): Promise<ProviderSettings>
  createBlueprint(idea: string): Promise<Blueprint>
  saveBlueprint(blueprint: Blueprint): Promise<Blueprint>
  renameBlueprint(id: string, name: string): Promise<Blueprint>
  deleteBlueprint(id: string): Promise<void>
  interview(blueprint: Blueprint, nodeId: string): Promise<InterviewResult>
  analyzeNode(blueprint: Blueprint, nodeId: string): Promise<NodeAnalysisResult>
  answerQuestion(blueprint: Blueprint, nodeId: string, questionId: string): Promise<AnswerResult>
  suggestBranches(blueprint: Blueprint, nodeId: string): Promise<BranchSuggestion[]>
  draftAcceptance(blueprint: Blueprint, nodeId: string): Promise<string[]>
  testProvider(): Promise<string>
  chooseOutputDir(blueprintId: string): Promise<string | undefined>
  startBuild(blueprintId: string): Promise<BuildRun>
  cancelBuild(): Promise<void>
  revealOutput(blueprintId: string): Promise<void>
  startProject(blueprintId: string, action: ProjectAction): Promise<ProjectActivity>
  stopProject(): Promise<void>
  openProject(blueprintId: string): Promise<void>
  onUpdate(callback: (snapshot: Snapshot) => void): () => void
}

export interface McpStatus {
  state: 'disabled' | 'running' | 'error'
  endpoint?: string
  token?: string
  error?: string
}
