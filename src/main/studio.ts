import { mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { ask, detectProviders, providerDefs, runAgent } from './providers'
import { blockedTasks, blueprintSpec, isBuildable, planBuild, runnableTasks, slug } from '../shared/plan'
import { acceptancePrompt, acceptanceResponse, agentPrompt, analysisPrompt, analysisResponse, answerPrompt, answerResponse, branchesPrompt, branchesResponse, extractJson, interviewPrompt, questionsResponse } from '../shared/prompts'
import { mergeAgentInstructions } from '../shared/instructions'
import { blueprintSchema, providerSettingsSchema, type Blueprint, type BranchSuggestion, type BuildRun, type ProviderSettings, type Snapshot } from '../shared/types'

export const defaultSettings: ProviderSettings = {
  provider: 'local',
  models: { copilot: ['auto', 'claude-sonnet-5.5'], codex: [], claude: ['sonnet'], local: [] },
  selectedModel: { copilot: 'auto', codex: '', claude: 'sonnet', local: '' },
  maxParallelAgents: 3,
  binaryPaths: { copilot: '', codex: '', claude: '', local: '' },
  localEndpoint: '',
  mcpEnabled: false
}

/** Reads saved settings field by field, keeping valid values, filling gaps from defaults and migrating the retired "demo" provider. */
export function parseSettings(raw: unknown): ProviderSettings {
  const input: Record<string, unknown> = raw && typeof raw === 'object' ? { ...raw } : {}
  if (input.provider === 'demo') input.provider = 'local'
  const value: Record<string, unknown> = { ...defaultSettings }
  for (const key of Object.keys(defaultSettings) as (keyof ProviderSettings)[]) {
    const fallback = defaultSettings[key]
    const incoming = input[key]
    if (incoming === undefined) continue
    const merged = typeof fallback === 'object' && incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? { ...fallback, ...incoming } : incoming
    if (providerSettingsSchema.safeParse({ ...value, [key]: merged }).success) value[key] = merged
  }
  return providerSettingsSchema.parse(value)
}

const askTimeout = 4 * 60_000
const agentTimeout = 45 * 60_000
const maxLog = 120_000
const newId = () => randomUUID().replace(/-/g, '').slice(0, 16)

export class Studio {
  private blueprints = new Map<string, Blueprint>()
  private settings = defaultSettings
  private run?: BuildRun
  private abort?: AbortController
  private starting = false
  private emitTimer?: NodeJS.Timeout
  onUpdate?: (snapshot: Snapshot) => void

  constructor(private readonly dataDir: string, private readonly documentsDir = join(homedir(), 'Documents')) {}

  private get blueprintDir() { return join(this.dataDir, 'blueprints') }

  async load() {
    await mkdir(this.blueprintDir, { recursive: true })
    try { this.settings = parseSettings(JSON.parse(await readFile(join(this.dataDir, 'settings.json'), 'utf8'))) } catch { this.settings = defaultSettings }
    for (const file of await readdir(this.blueprintDir)) {
      if (!file.endsWith('.json')) continue
      try {
        const blueprint = blueprintSchema.parse(JSON.parse(await readFile(join(this.blueprintDir, file), 'utf8')))
        // Interrupted builds must not look finished or in progress after a restart.
        for (const node of blueprint.nodes) if (node.status === 'queued' || node.status === 'building') node.status = 'ready'
        this.blueprints.set(blueprint.id, blueprint)
      } catch (error) { console.warn(`Skipping unreadable blueprint ${file}:`, error) }
    }
  }

  snapshot(): Snapshot {
    return { blueprints: [...this.blueprints.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), settings: this.settings, run: this.run, buildStarting: this.starting }
  }

  private emit(immediate = false) {
    if (immediate) { clearTimeout(this.emitTimer); this.emitTimer = undefined; this.onUpdate?.(this.snapshot()); return }
    this.emitTimer ??= setTimeout(() => { this.emitTimer = undefined; this.onUpdate?.(this.snapshot()) }, 200)
  }

  private writes = new Map<string, Promise<void>>()

  // Serialise writes per file: concurrent renames onto the same target fail with EPERM on Windows.
  private writeJson(file: string, value: unknown) {
    const body = JSON.stringify(value, null, 2)
    const next = (this.writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const temp = `${file}.${newId()}.tmp`
      await writeFile(temp, body)
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, file); return } catch (error) {
          if (attempt >= 4 || (error as NodeJS.ErrnoException).code !== 'EPERM') { await rm(temp, { force: true }); throw error }
          await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
        }
      }
    })
    this.writes.set(file, next)
    void next.finally(() => { if (this.writes.get(file) === next) this.writes.delete(file) }).catch(() => {})
    return next
  }

  providers() { return detectProviders(this.settings) }

  async saveSettings(input: unknown) {
    const settings = providerSettingsSchema.parse(input)
    await this.writeJson(join(this.dataDir, 'settings.json'), settings)
    this.settings = settings
    this.emit(true)
    return this.settings
  }

  async createBlueprint(idea: unknown) {
    const text = z.string().trim().min(3).max(2000).parse(idea)
    const now = new Date().toISOString()
    const first = text.split(/[.\n]/)[0].trim()
    const title = first.length <= 48 ? first : `${first.slice(0, 48).replace(/\s+\S*$/, '')}…`
    const blueprint: Blueprint = {
      id: newId(), name: title, createdAt: now, updatedAt: now, outputDir: '', connections: [],
      nodes: [{ id: newId(), parentId: null, kind: 'app', title, titleSource: 'auto', summary: text, questions: [], acceptance: [], status: 'draft', position: { x: 0, y: 0 } }]
    }
    return this.saveBlueprint(blueprint)
  }

  async saveBlueprint(input: unknown) {
    const blueprint = blueprintSchema.parse(input)
    blueprint.updatedAt = new Date().toISOString()
    this.blueprints.set(blueprint.id, blueprint)
    await this.writeJson(join(this.blueprintDir, `${blueprint.id}.json`), blueprint)
    this.emit()
    return blueprint
  }

  async deleteBlueprint(id: unknown) {
    const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(id)
    if (this.run?.status === 'running' && this.run.blueprintId === key) throw new Error('Stop the running build before deleting this blueprint.')
    this.blueprints.delete(key)
    await rm(join(this.blueprintDir, `${key}.json`), { force: true })
    this.emit(true)
  }

  private focus(input: unknown, nodeId: unknown) {
    const blueprint = blueprintSchema.parse(input)
    const node = blueprint.nodes.find(item => item.id === nodeId)
    if (!node) throw new Error('Select a node first.')
    return { blueprint, node }
  }

  private async askJson<T>(prompt: string, schema: z.ZodType<T>) {
    let problem = 'invalid JSON'
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await ask({ settings: this.settings, prompt: attempt ? `${prompt}\n\nYour previous answer was rejected (${problem}). Reply with valid JSON matching the schema only.` : prompt, cwd: this.dataDir, timeoutMs: askTimeout })
      try {
        const parsed = schema.safeParse(extractJson(output))
        if (parsed.success) return parsed.data
        problem = parsed.error.issues[0]?.message ?? problem
      } catch (error) { problem = error instanceof Error ? error.message : String(error) }
    }
    throw new Error(`The model's answer did not match the expected shape: ${problem}`)
  }

  async interview(input: unknown, nodeId: unknown) {
    const { blueprint, node } = this.focus(input, nodeId)
    const result = await this.askJson(interviewPrompt(blueprint, node), questionsResponse)
    return { questions: this.newQuestions(node, result.questions) }
  }

  private newQuestions(node: Blueprint['nodes'][number], questions: { question: string; why: string }[]) {
    const existing = new Set(node.questions.map(item => item.question.trim().toLowerCase()))
    const fresh = questions.filter(item => {
      const key = item.question.trim().toLowerCase()
      if (existing.has(key)) return false
      existing.add(key)
      return true
    }).map(item => ({ id: newId(), question: item.question, why: item.why, answer: '' }))
    if (node.questions.length + fresh.length > 40) throw new Error('This node has reached the 40-question limit. Remove unneeded questions and try again.')
    return fresh
  }

  async analyzeNode(input: unknown, nodeId: unknown) {
    const { blueprint, node } = this.focus(input, nodeId)
    const schema = analysisResponse.refine(result => node.kind !== 'unspecified' || result.kind !== 'app', 'Only the root can have the App type.')
    const result = await this.askJson(analysisPrompt(blueprint, node), schema)
    const kind = node.kind === 'unspecified' ? result.kind : node.kind
    blueprintSchema.parse({ ...blueprint, nodes: blueprint.nodes.map(item => item.id === node.id ? { ...item, kind } : item) })
    return { kind, title: node.titleSource === 'auto' ? result.title : node.title, message: result.message, questions: this.newQuestions(node, result.questions) }
  }

  async answerQuestion(input: unknown, nodeId: unknown, questionId: unknown) {
    const { blueprint, node } = this.focus(input, nodeId)
    const question = node.questions.find(item => item.id === questionId)
    if (!question?.answer.trim()) throw new Error('Enter an answer before submitting it.')
    const result = await this.askJson(answerPrompt(blueprint, node, question), answerResponse)
    const existing = new Set(blueprint.nodes.map(item => item.title.trim().toLowerCase()))
    const branches = result.branches.filter(item => {
      const key = item.title.trim().toLowerCase()
      if (existing.has(key)) return false
      existing.add(key)
      return true
    })
    if (blueprint.nodes.length + branches.length > 400) throw new Error('This blueprint has reached the 400-node limit. Remove unneeded nodes before expanding this answer.')
    return { questions: this.newQuestions(node, result.questions), branches }
  }

  async suggestBranches(input: unknown, nodeId: unknown): Promise<BranchSuggestion[]> {
    const { blueprint, node } = this.focus(input, nodeId)
    const existing = new Set(blueprint.nodes.filter(item => item.parentId === node.id).map(item => item.title.trim().toLowerCase()))
    return (await this.askJson(branchesPrompt(blueprint, node), branchesResponse)).branches.filter(item => !existing.has(item.title.trim().toLowerCase()))
  }

  async draftAcceptance(input: unknown, nodeId: unknown) {
    const { blueprint, node } = this.focus(input, nodeId)
    return (await this.askJson(acceptancePrompt(blueprint, node), acceptanceResponse)).criteria
  }

  async testProvider() {
    const output = await ask({ settings: this.settings, prompt: 'Reply with exactly the word READY and nothing else. Do not use tools.', cwd: this.dataDir, timeoutMs: this.settings.provider === 'local' ? 5 * 60_000 : 90_000 })
    if (!/READY/i.test(output)) throw new Error(`Unexpected reply: ${output.trim().slice(0, 200)}`)
    return `${providerDefs[this.settings.provider].label} responded with model "${this.settings.selectedModel[this.settings.provider] || 'default'}".`
  }

  defaultOutputDir(blueprint: Blueprint) { return join(this.documentsDir, 'App Studio', slug(blueprint.name)) }

  async setOutputDir(id: string, dir: string) {
    z.string().min(1).max(1000).refine(value => isAbsolute(value) && !value.includes('\0'), 'Choose an absolute output directory.').parse(dir)
    const blueprint = this.blueprints.get(id)
    if (!blueprint) throw new Error('Blueprint not found.')
    if (this.run?.status === 'running' && this.run.blueprintId === id) throw new Error('Stop the build before changing its output directory.')
    return this.saveBlueprint({ ...blueprint, outputDir: dir })
  }

  outputDirFor(id: string) {
    const blueprint = this.blueprints.get(id)
    if (!blueprint) throw new Error('Blueprint not found.')
    return blueprint.outputDir || this.defaultOutputDir(blueprint)
  }

  async startBuild(id: unknown) {
    if (this.starting || this.run?.status === 'running') throw new Error('A build is already running.')
    this.starting = true
    this.emit(true)
    try { return await this.beginBuild(id) } finally { this.starting = false; this.emit(true) }
  }

  private async beginBuild(id: unknown) {
    const blueprint = this.blueprints.get(z.string().parse(id))
    if (!blueprint) throw new Error('Blueprint not found.')
    const outputDir = this.outputDirFor(blueprint.id)
    // Keep future builds in the same project even if AI or the user later renames the root.
    blueprint.outputDir = outputDir
    await mkdir(join(outputDir, '.app-studio'), { recursive: true })
    const instructionsPath = join(outputDir, 'AGENTS.md')
    let existingInstructions = ''
    try { existingInstructions = await readFile(instructionsPath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(instructionsPath, mergeAgentInstructions(existingInstructions, blueprint))
    await writeFile(join(outputDir, 'BLUEPRINT.md'), `# ${blueprint.name}\n\nGenerated by App Studio from the mind map.\n\n${blueprintSpec(blueprint)}\n`)
    await this.writeJson(join(outputDir, '.app-studio', 'blueprint.json'), blueprint)
    const settings = this.settings
    this.run = {
      id: newId(), blueprintId: blueprint.id, provider: settings.provider, model: settings.selectedModel[settings.provider] ?? '',
      outputDir, startedAt: new Date().toISOString(), status: 'running', tasks: planBuild(blueprint)
    }
    for (const node of blueprint.nodes) if (isBuildable(node) || node.kind === 'app') node.status = 'queued'
    await this.saveBlueprint(blueprint)
    this.abort = new AbortController()
    void this.execute(this.run, blueprint, settings, this.abort.signal)
    this.emit(true)
    return this.run
  }

  cancelBuild() {
    this.abort?.abort()
  }

  private async setNodeStatus(blueprintId: string, nodeId: string, status: Blueprint['nodes'][number]['status']) {
    const blueprint = this.blueprints.get(blueprintId)
    const node = blueprint?.nodes.find(item => item.id === nodeId)
    if (!blueprint || !node) return
    node.status = status
    await this.saveBlueprint(blueprint)
  }

  private async execute(run: BuildRun, blueprint: Blueprint, settings: ProviderSettings, signal: AbortSignal) {
    const running = new Map<string, Promise<void>>()
    const startTask = (task: BuildRun['tasks'][number]) => {
      task.status = 'running'
      task.startedAt = new Date().toISOString()
      if (task.role === 'agent') void this.setNodeStatus(run.blueprintId, task.nodeId, 'building')
      const append = (chunk: string) => { task.log = (task.log + chunk).slice(-maxLog); this.emit() }
      const work = (async () => {
        try {
          const summary = await runAgent({ settings, taskId: task.id, prompt: agentPrompt(blueprint, task), cwd: run.outputDir, timeoutMs: agentTimeout, signal, onOutput: append })
          if (!task.log.includes(summary.trim().slice(0, 200))) append(`\n${summary.trim()}\n`)
          task.status = 'done'
          if (task.role === 'agent') await this.setNodeStatus(run.blueprintId, task.nodeId, 'built')
        } catch (error) {
          task.status = signal.aborted ? 'cancelled' : 'failed'
          task.error = error instanceof Error ? error.message : String(error)
          if (task.role === 'agent') await this.setNodeStatus(run.blueprintId, task.nodeId, 'failed')
        } finally {
          task.finishedAt = new Date().toISOString()
          running.delete(task.id)
          this.emit(true)
        }
      })()
      running.set(task.id, work)
    }
    // The coordinator tasks are serial by construction (foundation first, integrate last); agents fan out.
    while (true) {
      for (const task of blockedTasks(run.tasks)) { task.status = 'skipped'; task.error = 'A task it depends on did not finish.' }
      if (signal.aborted) for (const task of run.tasks) if (task.status === 'waiting') task.status = 'cancelled'
      const capacity = settings.maxParallelAgents - running.size
      if (!signal.aborted) for (const task of runnableTasks(run.tasks).slice(0, Math.max(0, capacity))) startTask(task)
      if (!running.size) break
      await Promise.race(running.values())
    }
    const statuses = run.tasks.map(task => task.status)
    run.status = signal.aborted ? 'cancelled' : statuses.every(status => status === 'done') ? 'done' : 'failed'
    run.finishedAt = new Date().toISOString()
    const fresh = this.blueprints.get(run.blueprintId)
    if (fresh) {
      for (const node of fresh.nodes) if (node.status === 'queued' || node.status === 'building') node.status = 'ready'
      const root = fresh.nodes.find(node => node.parentId === null)
      if (root) root.status = run.status === 'done' ? 'built' : run.status === 'failed' ? 'failed' : 'ready'
      await this.saveBlueprint(fresh)
    }
    try { await this.writeJson(join(run.outputDir, '.app-studio', `run-${run.id}.json`), run) } catch (error) { console.warn('Could not save run log:', error) }
    this.emit(true)
  }
}
