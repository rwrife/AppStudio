import { blueprintSchema, contextKinds, type Blueprint, type BuildTask, type MindNode, type NodeConnection, type NodeKind } from './types'

export const kindLabels: Record<NodeKind, string> = {
  app: 'App', unspecified: 'Auto-detect', feature: 'Feature', screen: 'Screen', data: 'Data', integration: 'Integration',
  ux: 'UX design', architecture: 'Architecture', rule: 'Business rule', constraint: 'Constraint'
}

export { contextKinds } from './types'
export const isBuildable = (node: MindNode) => node.kind !== 'app' && !contextKinds.includes(node.kind)
export function defaultConnection(blueprint: Blueprint, link: Omit<NodeConnection, 'kind'>): NodeConnection {
  const dependency: NodeConnection = { ...link, kind: 'dependency' }
  const duplicate = blueprint.connections.some(item => item.sourceId === link.sourceId && item.targetId === link.targetId && item.kind === 'dependency')
  if (duplicate || blueprintSchema.safeParse({ ...blueprint, connections: [...blueprint.connections, dependency] }).success) return dependency
  return { ...link, kind: 'similar' }
}
export const hasCurrentAnalysis = (node: MindNode) => !!node.analysis &&
  node.analysis.title === node.title && node.analysis.summary === node.summary && node.analysis.kind === node.kind

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
  const reviewedWithoutQuestions = hasCurrentAnalysis(node) && node.analysis?.noFollowUps
  const answerScore = asked ? answered / asked : reviewedWithoutQuestions ? 1 : 0
  const percent = Math.round(100 * (0.15 * (node.summary.trim() ? 1 : 0) + 0.55 * answerScore + 0.3 * (criteria ? 1 : 0)))
  return { answered, asked, criteria, percent, ready: node.kind !== 'unspecified' && (asked > 0 || !!reviewedWithoutQuestions) && answered === asked && (node.kind === 'app' || criteria > 0) }
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
  if (blueprint.connections.length) {
    const title = (id: string) => blueprint.nodes.find(node => node.id === id)!.title
    out.push('', 'Connections:')
    for (const link of blueprint.connections) out.push(link.kind === 'dependency'
      ? `- ${title(link.targetId)} consumes the output of ${title(link.sourceId)} (build ${title(link.sourceId)} first).`
      : `- ${title(link.sourceId)} is similar to ${title(link.targetId)}: reuse behaviour and patterns where appropriate; no build-order dependency.`)
  }
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
  blueprint = blueprintSchema.parse(blueprint)
  const root = rootOf(blueprint)
  const task = (nodeId: string, title: string, role: BuildTask['role'], dependsOn: string[]): BuildTask =>
    ({ id: role === 'coordinator' ? `coordinator-${nodeId}` : `agent-${nodeId}`, nodeId, title, role, dependsOn, status: 'waiting', log: '' })
  const foundation = task(root.id, `Foundation: ${root.title}`, 'coordinator', [])
  foundation.id = 'foundation'
  const buildable = blueprint.nodes.filter(isBuildable)
  const buildableIds = new Set(buildable.map(node => node.id))
  const dataTasks = buildable.filter(node => node.kind === 'data').map(node => `agent-${node.id}`)
  const agents = buildable.map(node => task(node.id, `${kindLabels[node.kind]}: ${node.title}`, 'agent',
    ['foundation', ...blueprint.connections.filter(link => link.kind === 'dependency' && link.targetId === node.id).map(link => `agent-${link.sourceId}`)]))
  const byId = new Map(agents.map(item => [item.id, item]))
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true
    if (seen.has(from)) return false
    seen.add(from)
    return byId.get(from)?.dependsOn.some(dep => reaches(dep, target, seen)) ?? false
  }
  // Explicit input/output dependencies take precedence over inferred data/parent ordering.
  for (const node of buildable) {
    const current = byId.get(`agent-${node.id}`)!
    const isData = node.kind === 'data'
    const parent = ancestorsOf(blueprint, node.id).reverse().find(item => buildableIds.has(item.id) && (item.kind === 'data') === isData)
    const inferred = [...(parent ? [`agent-${parent.id}`] : []), ...(isData ? [] : dataTasks)]
    for (const dep of inferred) if (!current.dependsOn.includes(dep) && !reaches(dep, current.id)) current.dependsOn.push(dep)
  }
  const integrate = task(root.id, 'Integrate & verify', 'coordinator', agents.length ? agents.map(item => item.id) : ['foundation'])
  integrate.id = 'integrate'
  return [foundation, ...agents, integrate]
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
