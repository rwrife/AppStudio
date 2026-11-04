import { z } from 'zod'

export const nodeKinds = ['app', 'feature', 'screen', 'data', 'integration', 'rule', 'constraint'] as const
export type NodeKind = typeof nodeKinds[number]

export const nodeStatuses = ['draft', 'ready', 'queued', 'building', 'built', 'failed'] as const
export type NodeStatus = typeof nodeStatuses[number]

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const text = (max: number) => z.string().max(max)

export const questionSchema = z.object({
  id,
  question: text(600).min(1),
  why: text(400).default(''),
  answer: text(4000).default('')
})
export type Question = z.infer<typeof questionSchema>

export const mindNodeSchema = z.object({
  id,
  parentId: id.nullable(),
  kind: z.enum(nodeKinds),
  title: text(120).min(1),
  summary: text(2000).default(''),
  questions: z.array(questionSchema).max(40).default([]),
  acceptance: z.array(text(400)).max(30).default([]),
  status: z.enum(nodeStatuses).default('draft'),
  position: z.object({ x: z.number().finite(), y: z.number().finite() })
})
export type MindNode = z.infer<typeof mindNodeSchema>

export const blueprintSchema = z.object({
  id,
  name: text(120).min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  outputDir: text(1000).default(''),
  nodes: z.array(mindNodeSchema).min(1).max(400)
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
  localEndpoint: endpointSchema.default('')
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
export interface BranchSuggestion { kind: NodeKind; title: string; summary: string }

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
}

export interface Snapshot {
  blueprints: Blueprint[]
  settings: ProviderSettings
  run?: BuildRun
}

export interface StudioApi {
  snapshot(): Promise<Snapshot>
  providers(): Promise<ProviderInfo[]>
  saveSettings(settings: ProviderSettings): Promise<ProviderSettings>
  createBlueprint(idea: string): Promise<Blueprint>
  saveBlueprint(blueprint: Blueprint): Promise<Blueprint>
  deleteBlueprint(id: string): Promise<void>
  interview(blueprint: Blueprint, nodeId: string): Promise<InterviewResult>
  suggestBranches(blueprint: Blueprint, nodeId: string): Promise<BranchSuggestion[]>
  draftAcceptance(blueprint: Blueprint, nodeId: string): Promise<string[]>
  testProvider(): Promise<string>
  chooseOutputDir(blueprintId: string): Promise<string | undefined>
  startBuild(blueprintId: string): Promise<BuildRun>
  cancelBuild(): Promise<void>
  revealOutput(blueprintId: string): Promise<void>
  onUpdate(callback: (snapshot: Snapshot) => void): () => void
}
