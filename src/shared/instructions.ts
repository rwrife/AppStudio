import { ancestorsOf, contextKinds, kindLabels, resourceContracts } from './plan'
import type { Blueprint } from './types'

const start = '<!-- app-studio:instructions:start -->'
const end = '<!-- app-studio:instructions:end -->'

export function agentInstructions(blueprint: Blueprint) {
  const lines = [
    start,
    '# App Studio instructions',
    '',
    `Application: ${blueprint.name}`,
    'Use these design decisions, technical choices, business rules and constraints for current and future tasks.',
    'A node path describes its scope; application-level instructions apply throughout the project.',
    'These nodes describe instructions, not separate code-output tasks.',
    'Read BLUEPRINT.md for the full idea, answers, acceptance criteria and node connections.',
    ''
  ]
  for (const node of blueprint.nodes.filter(item => contextKinds.includes(item.kind))) {
    lines.push(`## ${kindLabels[node.kind]}: ${node.title}`, '',
      `Scope: ${[...ancestorsOf(blueprint, node.id), node].map(item => item.title).join(' > ')}`, '', node.summary)
    for (const question of node.questions) lines.push(question.answer.trim()
      ? `- ${question.question} ${question.answer.trim()}`
      : `- Unresolved: ${question.question}`)
    for (const criterion of node.acceptance.filter(item => item.trim())) lines.push(`- Acceptance: ${criterion}`)
    for (const link of blueprint.connections.filter(item => item.kind === 'similar' && (item.sourceId === node.id || item.targetId === node.id))) {
      const other = blueprint.nodes.find(item => item.id === (link.sourceId === node.id ? link.targetId : link.sourceId))
      if (other) lines.push(`- Similar to: ${other.title}. Reuse applicable decisions and patterns.`)
    }
    lines.push('')
  }
  const resources = resourceContracts(blueprint)
  if (resources) lines.push('# Shared resources', '', resources, '')
  lines.push(end)
  return lines.join('\n')
}

/** Replace only our managed section; preserve instructions authored by users or other tools. */
export function mergeAgentInstructions(existing: string, blueprint: Blueprint) {
  const section = agentInstructions(blueprint)
  const first = existing.indexOf(start), last = existing.indexOf(end)
  if (first === -1 && last === -1) return `${existing}${existing ? '\n\n' : ''}${section}\n`
  if (first === -1 || last < first || existing.indexOf(start, first + start.length) !== -1 || existing.indexOf(end, last + end.length) !== -1)
    throw new Error('AGENTS.md has an invalid App Studio instruction section. Repair its markers before building.')
  return existing.slice(0, first) + section + existing.slice(last + end.length)
}
