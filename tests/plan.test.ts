import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedTasks, blueprintSpec, completeness, planBuild, runnableTasks } from '../src/shared/plan'
import { tidyLayout } from '../src/shared/layout'
import type { Blueprint, MindNode } from '../src/shared/types'

const node = (id: string, parentId: string | null, kind: MindNode['kind'], extra: Partial<MindNode> = {}): MindNode =>
  ({ id, parentId, kind, title: id, summary: '', questions: [], acceptance: [], status: 'draft', position: { x: 0, y: 0 }, ...extra })

const blueprint = (nodes: MindNode[]): Blueprint => ({ id: 'bp', name: 'Test', createdAt: '', updatedAt: '', outputDir: '', nodes })

test('plan has foundation first, one agent per buildable node, integration last', () => {
  const tasks = planBuild(blueprint([node('root', null, 'app'), node('booking', 'root', 'feature'), node('client', 'root', 'data'), node('cancel', 'booking', 'rule'), node('calendar', 'booking', 'screen')]))
  assert.deepEqual(tasks.map(task => task.id), ['foundation', 'agent-booking', 'agent-client', 'agent-calendar', 'integrate'])
  const byId = Object.fromEntries(tasks.map(task => [task.id, task]))
  assert.deepEqual(byId['agent-client'].dependsOn, ['foundation'])
  assert.deepEqual(new Set(byId['agent-booking'].dependsOn), new Set(['foundation', 'agent-client']))
  assert.deepEqual(new Set(byId['agent-calendar'].dependsOn), new Set(['foundation', 'agent-booking', 'agent-client']))
  assert.deepEqual(new Set(byId.integrate.dependsOn), new Set(['agent-booking', 'agent-client', 'agent-calendar']))
})

test('data nested under a feature does not create a dependency cycle', () => {
  const tasks = planBuild(blueprint([node('root', null, 'app'), node('booking', 'root', 'feature'), node('record', 'booking', 'data')]))
  const byId = Object.fromEntries(tasks.map(task => [task.id, task]))
  assert.deepEqual(byId['agent-record'].dependsOn, ['foundation'])
  assert.ok(byId['agent-booking'].dependsOn.includes('agent-record'))
  // Simulate execution order to prove every task becomes runnable.
  const order: string[] = []
  for (let guard = 0; guard < 10 && tasks.some(task => task.status === 'waiting'); guard++) for (const task of runnableTasks(tasks)) { task.status = 'done'; order.push(task.id) }
  assert.deepEqual(order, ['foundation', 'agent-record', 'agent-booking', 'integrate'])
})

test('tasks depending on a failed task become blocked', () => {
  const tasks = planBuild(blueprint([node('root', null, 'app'), node('a', 'root', 'feature'), node('b', 'a', 'screen')]))
  tasks[0].status = 'done'
  tasks.find(task => task.id === 'agent-a')!.status = 'failed'
  assert.deepEqual(blockedTasks(tasks).map(task => task.id), ['agent-b', 'integrate'])
})

test('completeness requires every question answered and acceptance criteria', () => {
  const questions = [{ id: 'q1', question: 'Who?', why: '', answer: 'Trainers' }, { id: 'q2', question: 'What?', why: '', answer: '' }]
  assert.equal(completeness(node('a', 'r', 'feature', { questions })).ready, false)
  const answered = questions.map(item => ({ ...item, answer: 'x' }))
  assert.equal(completeness(node('a', 'r', 'feature', { questions: answered })).ready, false)
  assert.equal(completeness(node('a', 'r', 'feature', { questions: answered, acceptance: ['Works'] })).ready, true)
  assert.equal(completeness(node('r', null, 'app', { questions: answered })).ready, true)
})

test('spec includes answered questions and acceptance criteria in tree order', () => {
  const spec = blueprintSpec(blueprint([node('root', null, 'app', { title: 'Gym app' }), node('b', 'root', 'feature', { title: 'Booking', questions: [{ id: 'q', question: 'Refunds?', why: '', answer: 'Within 24h' }], acceptance: ['Client can book'] })]))
  assert.match(spec, /\[App\] Gym app\n {2}- \[Feature\] Booking\n {4}- Q: Refunds\?\n {6}A: Within 24h\n {4}- Accept: Client can book/)
})

test('tidy layout places children right of parents and centres parents', () => {
  const laid = tidyLayout(blueprint([node('root', null, 'app'), node('a', 'root', 'feature'), node('b', 'root', 'feature')]))
  const pos = Object.fromEntries(laid.nodes.map(item => [item.id, item.position]))
  assert.equal(pos.a.x, pos.b.x)
  assert.ok(pos.a.x > pos.root.x)
  assert.equal(pos.root.y, (pos.a.y + pos.b.y) / 2)
})
