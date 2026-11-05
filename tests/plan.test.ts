import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedTasks, blueprintSpec, completeness, defaultConnection, planBuild, runnableTasks } from '../src/shared/plan'
import { tidyLayout } from '../src/shared/layout'
import { blueprintSchema, type Blueprint, type MindNode } from '../src/shared/types'

const node = (id: string, parentId: string | null, kind: MindNode['kind'], extra: Partial<MindNode> = {}): MindNode =>
  ({ id, parentId, kind, title: id, summary: '', questions: [], acceptance: [], status: 'draft', position: { x: 0, y: 0 }, ...extra })

const blueprint = (nodes: MindNode[]): Blueprint => ({ id: 'bp', name: 'Test', createdAt: '', updatedAt: '', outputDir: '', nodes, connections: [] })

test('automatic connections prefer dependencies, fall back for instruction nodes and cycles, and reject duplicates', () => {
  const bp = blueprint([node('root', null, 'app'), node('a', 'root', 'feature'), node('b', 'root', 'screen'), node('rules', 'root', 'rule')])
  const candidate = (sourceId: string, targetId: string) => defaultConnection(bp, { id: 'new', sourceId, targetId })
  assert.equal(candidate('a', 'b').kind, 'dependency')
  assert.equal(candidate('a', 'root').kind, 'similar')
  assert.equal(candidate('rules', 'a').kind, 'similar')
  bp.connections.push({ id: 'existing', sourceId: 'a', targetId: 'b', kind: 'dependency' })
  assert.equal(candidate('b', 'a').kind, 'similar')
  assert.equal(candidate('a', 'b').kind, 'dependency')
  assert.equal(blueprintSchema.safeParse({ ...bp, connections: [...bp.connections, candidate('a', 'b')] }).success, false)
  bp.connections.push({ id: 'similar', sourceId: 'a', targetId: 'root', kind: 'similar' })
  for (const link of [candidate('a', 'root'), candidate('a', 'a'), candidate('missing', 'b')])
    assert.equal(blueprintSchema.safeParse({ ...bp, connections: [...bp.connections, link] }).success, false)
})

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

test('instruction-only nodes do not get coding agents, even when they have code-output children', () => {
  const bp = blueprint([node('root', null, 'app'), node('design', 'root', 'ux'), node('stack', 'root', 'architecture'), node('rule', 'root', 'rule'), node('limit', 'root', 'constraint'), node('screen', 'design', 'screen')])
  assert.deepEqual(planBuild(bp).map(item => item.id), ['foundation', 'agent-screen', 'integrate'])
})

test('explicit producer-to-consumer dependencies control build order; similarity does not', () => {
  const bp = blueprint([node('root', null, 'app'), node('open', 'root', 'feature'), node('save', 'root', 'feature'), node('copy', 'root', 'feature')])
  bp.connections = [
    { id: 'dep', kind: 'dependency', sourceId: 'save', targetId: 'open' },
    { id: 'like', kind: 'similar', sourceId: 'open', targetId: 'copy' }
  ]
  const tasks = planBuild(bp)
  assert.deepEqual(tasks.find(item => item.nodeId === 'open')!.dependsOn, ['foundation', 'agent-save'])
  assert.deepEqual(tasks.find(item => item.nodeId === 'copy')!.dependsOn, ['foundation'])
  tasks[0].status = 'done'
  assert.deepEqual(runnableTasks(tasks).map(item => item.id), ['agent-save', 'agent-copy'])
  assert.match(blueprintSpec(bp), /open consumes the output of save/)
  assert.match(blueprintSpec(bp), /open is similar to copy/)
})

test('explicit links override inferred parent/data ordering without silently dropping dependencies', () => {
  const bp = blueprint([node('root', null, 'app'), node('feature', 'root', 'feature'), node('data', 'feature', 'data'), node('screen', 'feature', 'screen')])
  bp.connections = [
    { id: 'a', kind: 'dependency', sourceId: 'feature', targetId: 'data' },
    { id: 'b', kind: 'dependency', sourceId: 'screen', targetId: 'feature' }
  ]
  const tasks = planBuild(bp)
  assert.ok(tasks.find(item => item.nodeId === 'data')!.dependsOn.includes('agent-feature'))
  assert.ok(tasks.find(item => item.nodeId === 'feature')!.dependsOn.includes('agent-screen'))
  const order: string[] = []
  for (let i = 0; i < tasks.length; i++) for (const task of runnableTasks(tasks)) { task.status = 'done'; order.push(task.id) }
  assert.deepEqual(order, ['foundation', 'agent-screen', 'agent-feature', 'agent-data', 'integrate'])
})

test('graph validation rejects dangling, duplicate, self, cyclic and instruction-only dependency links', () => {
  const bp = blueprint([node('root', null, 'app'), node('a', 'root', 'feature'), node('b', 'root', 'feature'), node('rule', 'root', 'rule')])
  const dep = { id: 'd', kind: 'dependency' as const, sourceId: 'a', targetId: 'b' }
  for (const connections of [
    [{ ...dep, targetId: 'missing' }], [{ ...dep, targetId: 'a' }], [dep, { ...dep, id: 'other' }],
    [dep, { ...dep, id: 'reverse', sourceId: 'b', targetId: 'a' }], [{ ...dep, targetId: 'rule' }],
    [{ ...dep, kind: 'similar' }, { ...dep, id: 'other', kind: 'similar', sourceId: 'b', targetId: 'a' }]
  ]) assert.equal(blueprintSchema.safeParse({ ...bp, connections }).success, false)
  assert.throws(() => planBuild({ ...bp, connections: [dep, { ...dep, id: 'reverse', sourceId: 'b', targetId: 'a' }] }), /cycle/)
  assert.equal(blueprintSchema.safeParse({ ...bp, nodes: [...bp.nodes, bp.nodes[1]] }).success, false)
  assert.equal(blueprintSchema.safeParse({ ...bp, nodes: bp.nodes.map(item => item.id === 'a' ? { ...item, parentId: 'b' } : item.id === 'b' ? { ...item, parentId: 'a' } : item) }).success, false)
})

test('old blueprints migrate to an empty connection list without losing selected types or titles', () => {
  const { connections, ...legacy } = blueprint([node('root', null, 'app'), node('rule', 'root', 'rule')])
  const migrated = blueprintSchema.parse(legacy)
  assert.deepEqual(migrated.connections, [])
  assert.equal(migrated.nodes[1].kind, 'rule')
  assert.equal(migrated.nodes[1].titleSource, undefined)
})

test('a current no-follow-ups analysis can be ready without fabricated questions', () => {
  const reviewed = node('a', 'root', 'feature', {
    summary: 'Save documents', acceptance: ['Saves the document'],
    analysis: { title: 'a', summary: 'Save documents', kind: 'feature', noFollowUps: true, message: 'Enough detail.' }
  })
  assert.equal(completeness(reviewed).ready, true)
  assert.equal(completeness(reviewed).percent, 100)
  assert.equal(completeness({ ...reviewed, summary: 'Changed requirement' }).ready, false)
  assert.equal(completeness({ ...reviewed, acceptance: [] }).ready, false)
  assert.equal(completeness({ ...reviewed, analysis: undefined }).ready, false)
})
