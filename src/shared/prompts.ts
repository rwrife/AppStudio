import { z } from 'zod'
import { blueprintSpec, kindLabels, nodeContext, slug } from './plan'
import { nodeKinds, type Blueprint, type BuildTask, type MindNode } from './types'

/** Pulls the first JSON value out of model output that may include prose or markdown fences. */
export function extractJson(output: string): unknown {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], output].filter((item): item is string => !!item)
  for (const candidate of candidates) {
    for (let start = 0; start < candidate.length; start++) {
      const open = candidate[start]
      if (open !== '{' && open !== '[') continue
      const end = matchingBracket(candidate, start)
      if (end < 0) continue
      try { return JSON.parse(candidate.slice(start, end + 1)) } catch { /* keep scanning */ }
    }
  }
  throw new Error('The model did not return JSON. Try again or pick a stronger model.')
}

function matchingBracket(text: string, start: number) {
  const stack: string[] = []
  let inString = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']')
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return -1
      if (!stack.length) return i
    }
  }
  return -1
}

export const questionsResponse = z.object({
  questions: z.array(z.object({ question: z.string().min(3).max(600), why: z.string().max(400).optional().default('') })).min(1).max(8)
})
export const branchesResponse = z.object({
  branches: z.array(z.object({ kind: z.enum(nodeKinds).exclude(['app']), title: z.string().min(1).max(120), summary: z.string().max(600).optional().default('') })).min(1).max(8)
})
export const acceptanceResponse = z.object({ criteria: z.array(z.string().min(3).max(400)).min(1).max(10) })

const jsonOnly = 'Respond with JSON only, no markdown fences or commentary. Do not use tools, read files or run commands.'

export function interviewPrompt(blueprint: Blueprint, node: MindNode) {
  const answered = node.questions.filter(item => item.answer.trim())
  return [
    'You are a product analyst helping a user specify an application as a mind map. Each node is one detail of the app.',
    `Ask the most important clarifying questions for the focus node so an engineer could build it without guessing.`,
    'Ask about behaviour, edge cases, data and user expectations. Do not ask about anything already answered in the blueprint.',
    'Ask 3 to 5 short, concrete questions; prefer questions with answerable options. Include a one-line "why" for each.',
    answered.length ? `Already answered for this node:\n${answered.map(item => `- ${item.question}: ${item.answer}`).join('\n')}` : '',
    '',
    nodeContext(blueprint, node.id),
    '',
    `${jsonOnly} Schema: {"questions":[{"question":string,"why":string}]}`
  ].filter(Boolean).join('\n')
}

export function branchesPrompt(blueprint: Blueprint, node: MindNode) {
  return [
    'You are a product analyst helping a user break an application down as a mind map.',
    `Suggest the missing child nodes for the focus node. Kinds: feature, screen, data, integration, rule, constraint.`,
    'Suggest 3 to 6 children that do not duplicate existing nodes. Keep titles under 5 words and summaries to one sentence.',
    '',
    nodeContext(blueprint, node.id),
    '',
    `${jsonOnly} Schema: {"branches":[{"kind":string,"title":string,"summary":string}]}`
  ].join('\n')
}

export function acceptancePrompt(blueprint: Blueprint, node: MindNode) {
  return [
    'You are a QA lead. Write testable acceptance criteria for the focus node of this application blueprint.',
    'Base them only on the summary and answers given. 3 to 6 criteria, each one observable sentence.',
    '',
    nodeContext(blueprint, node.id),
    '',
    `${jsonOnly} Schema: {"criteria":[string]}`
  ].join('\n')
}

const sharedRules = [
  'Rules:',
  '- Work only inside the current working directory. Do not push, publish, deploy or contact external services.',
  '- Keep the project buildable. Prefer small, conventional files over clever abstractions.',
  '- Read APP_STUDIO.md and existing code first; follow the stack and conventions the foundation established.',
  '- Never claim something works unless you ran it. Record anything unfinished honestly.'
].join('\n')

export function agentPrompt(blueprint: Blueprint, task: BuildTask) {
  const spec = blueprintSpec(blueprint)
  const node = blueprint.nodes.find(item => item.id === task.nodeId)
  if (!node) throw new Error(`Task ${task.id} references a missing node.`)
  if (task.id === 'foundation') return [
    'You are the coordinating engineer for a multi-agent build. Other agents will each implement one node of the blueprint below in parallel after you finish.',
    'Set up the foundation: choose a simple stack that fits the blueprint (default to a Vite + React + TypeScript web app unless the blueprint says otherwise), scaffold the project, shared data types, routing/navigation shell and a README.',
    'Write APP_STUDIO.md describing: stack, folder layout, where each node should live (one folder per node using the slugs below), shared types, and how to run and test the app.',
    `Node folders: ${blueprint.nodes.filter(item => item.parentId).map(item => `${slug(item.title)} (${kindLabels[item.kind]})`).join(', ') || 'none'}`,
    'Do not implement individual features beyond placeholders; leave those to the node agents.',
    sharedRules, '', 'Blueprint:', spec
  ].join('\n')
  if (task.id === 'integrate') return [
    'You are the coordinating engineer. Node agents have finished implementing their parts of the blueprint below.',
    'Integrate the work: wire every feature and screen into navigation, reconcile duplicated or conflicting types, make the project install, build and pass its tests, and update README.md with how to run it.',
    'Then write BUILD_REPORT.md listing each node, what was built, how it meets its acceptance criteria, and any gaps.',
    sharedRules, '', 'Blueprint:', spec
  ].join('\n')
  const context = blueprint.nodes.filter(item => item.parentId === node.id && (item.kind === 'rule' || item.kind === 'constraint'))
  return [
    `You are a sub-agent implementing exactly one node of an application blueprint: [${kindLabels[node.kind]}] ${node.title}.`,
    `Put your code in the folder for "${slug(node.title)}" described in APP_STUDIO.md. Other agents are editing other folders at the same time; only touch shared files when unavoidable and keep those edits minimal.`,
    node.summary.trim() ? `Summary: ${node.summary.trim()}` : '',
    node.questions.some(item => item.answer.trim()) ? `Decisions:\n${node.questions.filter(item => item.answer.trim()).map(item => `- ${item.question} → ${item.answer.trim()}`).join('\n')}` : '',
    context.length ? `Rules and constraints that apply:\n${context.map(item => `- ${item.title}: ${item.summary}`).join('\n')}` : '',
    node.acceptance.length ? `Acceptance criteria (verify each):\n${node.acceptance.map(item => `- ${item}`).join('\n')}` : '',
    'Add focused tests where the stack supports them. Finish by summarising what you built and how each acceptance criterion is met.',
    sharedRules, '', 'Whole blueprint for context:', spec
  ].filter(Boolean).join('\n')
}
