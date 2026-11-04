import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentInstructions, mergeAgentInstructions } from '../src/shared/instructions'
import { blueprintSchema } from '../src/shared/types'

const blueprint = blueprintSchema.parse({
  id: 'calculator', name: 'Calculator', createdAt: '', updatedAt: '',
  nodes: [
    { id: 'root', parentId: null, kind: 'app', title: 'Calculator', position: { x: 0, y: 0 } },
    { id: 'math', parentId: 'root', kind: 'feature', title: 'Scientific functions', position: { x: 0, y: 0 } },
    { id: 'ux', parentId: 'math', kind: 'ux', title: 'Quiet interface', summary: 'Use a high-contrast dark theme.', questions: [{ id: 'q', question: 'Button size?', answer: 'At least 44 pixels.' }], acceptance: ['Keyboard focus is visible.'], position: { x: 0, y: 0 } },
    { id: 'arch', parentId: 'root', kind: 'architecture', title: 'Desktop tooling', summary: 'Electron and TypeScript on Windows.', position: { x: 0, y: 0 } },
    { id: 'rule', parentId: 'root', kind: 'rule', title: 'Division by zero', summary: 'Show an explicit error.', position: { x: 0, y: 0 } },
    { id: 'constraint', parentId: 'root', kind: 'constraint', title: 'Offline', summary: 'No network needed.', position: { x: 0, y: 0 } }
  ]
})

test('AGENTS.md carries instruction-only details, scope, answers and acceptance criteria', () => {
  const content = agentInstructions(blueprint)
  assert.match(content, /Scope: Calculator > Scientific functions > Quiet interface/)
  assert.match(content, /Button size\? At least 44 pixels/)
  assert.match(content, /Acceptance: Keyboard focus is visible/)
  assert.match(content, /## Architecture: Desktop tooling/)
  assert.match(content, /## Business rule: Division by zero/)
  assert.match(content, /## Constraint: Offline/)
  assert.doesNotMatch(content, /## Feature:/)
})

test('instruction refresh preserves user text, removes stale rules and never duplicates the section', () => {
  const initial = mergeAgentInstructions('# My instructions\nDo not change the license.\n', blueprint) + '\nFooter instructions.\n'
  const next = { ...blueprint, nodes: blueprint.nodes.filter(node => node.kind !== 'rule') }
  const refreshed = mergeAgentInstructions(initial, next)
  assert.ok(refreshed.startsWith('# My instructions\nDo not change the license.\n'))
  assert.ok(refreshed.endsWith('\nFooter instructions.\n'))
  assert.doesNotMatch(refreshed, /Division by zero/)
  assert.equal(refreshed.split('<!-- app-studio:instructions:start -->').length, 2)
  assert.equal(mergeAgentInstructions(refreshed, next), refreshed)
})

test('malformed markers fail explicitly instead of overwriting external instructions', () => {
  for (const text of [
    'User text\n<!-- app-studio:instructions:start -->',
    '<!-- app-studio:instructions:end -->\n<!-- app-studio:instructions:start -->',
    mergeAgentInstructions('', blueprint) + mergeAgentInstructions('', blueprint)
  ]) assert.throws(() => mergeAgentInstructions(text, blueprint), /invalid App Studio instruction section/)
})
