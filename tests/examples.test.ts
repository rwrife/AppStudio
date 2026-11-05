import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { blueprintSchema } from '../src/shared/types'
import { blueprintGaps, contextKinds, isBuildable, planBuild } from '../src/shared/plan'

test('the steampunk OOBE workflow is reusable, reviewed and has a complete build graph', async () => {
  const text = await readFile(join(import.meta.dirname, '..', 'examples', 'brass-steam-calculator.blueprint.json'), 'utf8')
  const blueprint = blueprintSchema.parse(JSON.parse(text))
  const root = blueprint.nodes.find(node => node.parentId === null)!
  assert.equal(root.title, 'build a calculator')
  assert.ok(blueprint.nodes.length >= 6 && blueprint.nodes.length <= 10)
  assert.equal(blueprint.outputDir, '')
  assert.deepEqual(blueprintGaps(blueprint), [])
  assert.ok(blueprint.nodes.every(node => !['built', 'building', 'queued', 'failed'].includes(node.status)))
  assert.ok(blueprint.nodes.some(node => node.questions.some(question => question.answer && question.reviewedAnswer === question.answer)))
  for (const kind of ['architecture', 'ux', 'rule', 'feature', 'data', 'screen']) {
    assert.ok(blueprint.nodes.some(node => node.kind === kind), `missing ${kind} node`)
  }
  assert.ok(blueprint.connections.some(link => link.kind === 'dependency'))
  assert.ok(blueprint.connections.some(link => link.kind === 'similar'))
  const output = blueprint.nodes.find(node => node.title === 'Calculation output')!
  const copy = blueprint.nodes.find(node => node.title === 'Copy result')!
  assert.ok(output && copy)
  assert.notEqual(output.parentId, root.id)
  assert.notEqual(copy.parentId, root.id)
  assert.notEqual(copy.parentId, output.parentId)
  assert.ok(blueprint.connections.some(link => link.kind === 'dependency' && link.sourceId === output.id && link.targetId === copy.id))
  assert.doesNotMatch(text, /Bearer |[A-Z]:\\\\Users\\\\/)
  const tasks = planBuild(blueprint)
  assert.equal(tasks.length, blueprint.nodes.filter(isBuildable).length + 2)
  assert.equal(tasks[0].id, 'foundation')
  assert.equal(tasks.at(-1)!.id, 'integrate')
  assert.ok(tasks.find(task => task.nodeId === copy.id)!.dependsOn.includes(`agent-${output.id}`))
  for (const node of blueprint.nodes.filter(node => contextKinds.includes(node.kind))) {
    assert.ok(!tasks.some(task => task.nodeId === node.id), 'instruction nodes must not get coding agents')
  }
  const completed = new Set<string>()
  while (completed.size < tasks.length) {
    const next = tasks.find(task => !completed.has(task.id) && task.dependsOn.every(id => completed.has(id)))
    assert.ok(next, 'the example build graph must be acyclic and have no missing dependencies')
    completed.add(next.id)
  }
})
