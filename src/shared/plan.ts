import type { Blueprint, BuildTask, MindNode, NodeKind } from './types'

export const kindLabels: Record<NodeKind, string> = {
  app: 'App', feature: 'Feature', screen: 'Screen', data: 'Data', integration: 'Integration', rule: 'Rule', constraint: 'Constraint'
}

/** Rules and constraints shape other work; they are given to agents as context rather than built by their own agent. */
export const contextKinds: NodeKind[] = ['rule', 'constraint']
export const isBuildable = (node: MindNode) => node.kind !== 'app' && !contextKinds.includes(node.kind)

export function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'node'
}

export function rootOf(blueprint: Blueprint) {
  const root = blueprint.nodes.find(node => node.parentId === null)
  if (!root) throw new Error('Blueprint has no root node.')
  return root
}

export function childrenOf(blueprint: Blueprint, id: string) {
  return blueprint.nodes.filter(node => node.parentId === id)
}

export function ancestorsOf(blueprint: Blueprint, id: string) {
  const byId = new Map(blueprint.nodes.map(node => [node.id, node]))
  const chain: MindNode[] = []
  let current = byId.get(id)?.parentId
  while (current && chain.length < 100) {
    const node = byId.get(current)
    if (!node) break
    chain.unshift(node)
    current = node.parentId
  }
  return chain
}

export function descendantIds(blueprint: Blueprint, id: string) {
  const result = new Set<string>()
  const visit = (parent: string) => {
    for (const child of childrenOf(blueprint, parent)) if (!result.has(child.id)) { result.add(child.id); visit(child.id) }
  }
  visit(id)
  return result
}

export interface Completeness { answered: number; asked: number; criteria: number; percent: number; ready: boolean }

export function completeness(node: MindNode): Completeness {
  const asked = node.questions.length
  const answered = node.questions.filter(question => question.answer.trim()).length
  const criteria = node.acceptance.filter(item => item.trim()).length
  const answerScore = asked ? answered / asked : 0
  const percent = Math.round(100 * (0.15 * (node.summary.trim() ? 1 : 0) + 0.55 * answerScore + 0.3 * (criteria ? 1 : 0)))
  return { answered, asked, criteria, percent, ready: asked > 0 && answered === asked && (node.kind === 'app' || criteria > 0) }
}

export function blueprintGaps(blueprint: Blueprint) {
  return blueprint.nodes.filter(node => !completeness(node).ready)
}

function describeNode(node: MindNode, depth = 0) {
  const pad = '  '.repeat(depth)
  const lines = [`${pad}- [${kindLabels[node.kind]}] ${node.title}${node.summary.trim() ? ` — ${node.summary.trim()}` : ''}`]
  for (const question of node.questions) if (question.answer.trim()) lines.push(`${pad}  - Q: ${question.question}\n${pad}    A: ${question.answer.trim()}`)
  for (const item of node.acceptance) if (item.trim()) lines.push(`${pad}  - Accept: ${item.trim()}`)
  return lines.join('\n')
}

/** Markdown specification derived from the whole map; every agent receives the same source of truth. */
export function blueprintSpec(blueprint: Blueprint) {
  const out: string[] = []
  const walk = (node: MindNode, depth: number) => {
    out.push(describeNode(node, depth))
    for (const child of childrenOf(blueprint, node.id)) walk(child, depth + 1)
  }
  walk(rootOf(blueprint), 0)
  return out.join('\n')
}

export function nodeContext(blueprint: Blueprint, nodeId: string) {
  const node = blueprint.nodes.find(item => item.id === nodeId)
  if (!node) throw new Error('Node not found in blueprint.')
  const ancestors = ancestorsOf(blueprint, nodeId)
  const siblings = node.parentId ? childrenOf(blueprint, node.parentId).filter(item => item.id !== nodeId) : []
  const children = childrenOf(blueprint, nodeId)
  return [
    `Application: ${rootOf(blueprint).title}`,
    ancestors.length ? `Path: ${ancestors.map(item => item.title).join(' > ')} > ${node.title}` : '',
    `Focus node: [${kindLabels[node.kind]}] ${node.title}`,
    node.summary.trim() ? `Summary: ${node.summary.trim()}` : '',
    siblings.length ? `Sibling nodes: ${siblings.map(item => `${item.title} (${kindLabels[item.kind]})`).join(', ')}` : '',
    children.length ? `Child nodes: ${children.map(item => `${item.title} (${kindLabels[item.kind]})`).join(', ')}` : '',
    '',
    'Whole blueprint so far:',
    blueprintSpec(blueprint)
  ].filter(line => line !== '').join('\n')
}

/**
 * Turns the specification graph into an execution graph: one coordinator foundation task, one sub-agent per
 * buildable node (data before the features and screens that use it, parents before children), and a final
 * coordinator integration pass that reconciles seams between agents.
 */
export function planBuild(blueprint: Blueprint): BuildTask[] {
  const root = rootOf(blueprint)
  const task = (nodeId: string, title: string, role: BuildTask['role'], dependsOn: string[]): BuildTask =>
    ({ id: role === 'coordinator' ? `coordinator-${nodeId}` : `agent-${nodeId}`, nodeId, title, role, dependsOn, status: 'waiting', log: '' })
  const foundation = task(root.id, `Foundation: ${root.title}`, 'coordinator', [])
  foundation.id = 'foundation'
  const buildable = blueprint.nodes.filter(isBuildable)
  const buildableIds = new Set(buildable.map(node => node.id))
  const dataTasks = buildable.filter(node => node.kind === 'data').map(node => `agent-${node.id}`)
  const agents = buildable.map(node => {
    const isData = node.kind === 'data'
    const parent = ancestorsOf(blueprint, node.id).reverse().find(item => buildableIds.has(item.id) && (item.kind === 'data') === isData)
    const deps = new Set(['foundation'])
    if (parent) deps.add(`agent-${parent.id}`)
    if (!isData) for (const data of dataTasks) deps.add(data)
    deps.delete(`agent-${node.id}`)
    return task(node.id, `${kindLabels[node.kind]}: ${node.title}`, 'agent', [...deps])
  })
  removeCycles(agents) // defensive: the rules above are acyclic, but persisted data could be malformed
  const integrate = task(root.id, 'Integrate & verify', 'coordinator', agents.length ? agents.map(item => item.id) : ['foundation'])
  integrate.id = 'integrate'
  return [foundation, ...agents, integrate]
}

function removeCycles(tasks: BuildTask[]) {
  const byId = new Map(tasks.map(item => [item.id, item]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (current: BuildTask) => {
    state.set(current.id, 'visiting')
    current.dependsOn = current.dependsOn.filter(dep => {
      const target = byId.get(dep)
      if (!target) return true
      if (state.get(dep) === 'visiting') return false
      if (!state.has(dep)) visit(target)
      return true
    })
    state.set(current.id, 'done')
  }
  for (const item of tasks) if (!state.has(item.id)) visit(item)
}

export function runnableTasks(tasks: BuildTask[]) {
  const status = new Map(tasks.map(item => [item.id, item.status]))
  return tasks.filter(item => item.status === 'waiting' && item.dependsOn.every(dep => (status.get(dep) ?? 'done') === 'done'))
}

/** Tasks whose dependencies failed or were cancelled can never run. */
export function blockedTasks(tasks: BuildTask[]) {
  const status = new Map(tasks.map(item => [item.id, item.status]))
  return tasks.filter(item => item.status === 'waiting' && item.dependsOn.some(dep => ['failed', 'cancelled', 'skipped'].includes(status.get(dep) ?? '')))
}
