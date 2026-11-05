import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blueprintSchema, type Blueprint, type MindNode, type NodeConnection } from '../src/shared/types'
import { blockedTasks, blueprintGaps, blueprintSpec, isBuildable, planBuild, resourceProblems, runnableTasks } from '../src/shared/plan'
import { agentPrompt, analysisResponse, branchesResponse } from '../src/shared/prompts'
import { mergeAgentInstructions } from '../src/shared/instructions'
import { desktopCommandSchema } from '../src/shared/automation'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Studio } from '../src/main/studio'
import { startMockServer } from './fixtures/mock-openai.mjs'

const node = (id: string, kind: MindNode['kind']): MindNode => ({
  id, kind, parentId: kind === 'app' ? null : 'root', title: id, summary: '', questions: [],
  acceptance: [], status: 'draft', position: { x: 0, y: 0 }
})
const link = (kind: NodeConnection['kind'], sourceId: string, targetId: string): NodeConnection =>
  ({ id: `${kind}-${sourceId}-${targetId}`, kind, sourceId, targetId })
const fixture = (): Blueprint => ({
  id: 'bp', name: 'Resources', createdAt: '', updatedAt: '', outputDir: '',
  nodes: [node('root', 'app'), node('storage', 'feature'), node('save', 'feature'), node('open', 'screen'), node('arch', 'architecture'), node('foobar', 'resource')],
  connections: [link('defines', 'storage', 'foobar'), link('references', 'save', 'foobar'), link('references', 'open', 'foobar')]
})

test('resource contracts have one creator and many consumers, but no resource agent', () => {
  const bp = fixture()
  bp.connections.push(link('references', 'storage', 'foobar'))
  const tasks = planBuild(bp)
  assert.equal(isBuildable(bp.nodes.at(-1)!), false)
  assert.deepEqual(resourceProblems(bp), [])
  assert.deepEqual(tasks.map(task => task.id), ['foundation', 'agent-storage', 'agent-save', 'agent-open', 'integrate'])
  assert.deepEqual(tasks.find(task => task.id === 'agent-storage')!.dependsOn, ['foundation'])
  assert.deepEqual(tasks.find(task => task.id === 'agent-save')!.dependsOn, ['foundation', 'agent-storage'])
  assert.deepEqual(tasks.find(task => task.id === 'agent-open')!.dependsOn, ['foundation', 'agent-storage'])
  assert.match(agentPrompt(bp, tasks[1]), /Resources you DEFINE/)
  assert.doesNotMatch(agentPrompt(bp, tasks[1]), /Resources you REFERENCE/, 'self-reference must not prohibit the owner from creating its resource')
  tasks[0].status = 'done'
  assert.deepEqual(runnableTasks(tasks).map(task => task.id), ['agent-storage'])
  tasks[1].status = 'done'
  assert.deepEqual(runnableTasks(tasks).map(task => task.id), ['agent-save', 'agent-open'])
})

test('failed or cancelled resource owners block all consumers and integration', () => {
  for (const status of ['failed', 'cancelled', 'skipped'] as const) {
    const tasks = planBuild(fixture())
    tasks[0].status = 'done'
    tasks[1].status = status
    assert.deepEqual(runnableTasks(tasks), [])
    assert.deepEqual(blockedTasks(tasks).map(task => task.id), ['agent-save', 'agent-open', 'integrate'])
  }
})

test('App and Architecture definitions are created by foundation, not phantom agents', () => {
  for (const owner of ['root', 'arch']) {
    const bp = fixture()
    bp.connections[0] = link('defines', owner, 'foobar')
    bp.connections.push(link('references', 'arch', 'foobar'))
    const tasks = planBuild(bp)
    assert.deepEqual(tasks.find(task => task.id === 'agent-save')!.dependsOn, ['foundation'])
    assert.match(agentPrompt(bp, tasks[0]), /Resources you DEFINE and must implement before finishing: foobar \[foobar\]/)
    assert.match(blueprintSpec(bp), /Creation task: foundation/)
    tasks[0].status = 'done'
    tasks[0].log = 'Created the SQLite schema in db/schema.sql.'
    assert.match(agentPrompt(bp, tasks.find(task => task.id === 'agent-save')!, tasks), /Completed defining task foundation.*\nCreated the SQLite schema/)
  }
})

test('external resources have no creator and never add a provisioning dependency', () => {
  const bp = fixture()
  bp.nodes.at(-1)!.resourceMode = 'external'
  bp.connections = bp.connections.filter(item => item.kind !== 'defines')
  assert.deepEqual(resourceProblems(bp), [])
  const tasks = planBuild(bp)
  assert.deepEqual(tasks.find(task => task.id === 'agent-save')!.dependsOn, ['foundation'])
  assert.match(blueprintSpec(bp), /Externally provided. No agent may recreate or provision/)
  assert.doesNotMatch(agentPrompt(bp, tasks[0]), /Resources you DEFINE/)
})

test('unfinished resource drafts persist but remain visible ownership blockers', () => {
  const bp = fixture()
  bp.connections = bp.connections.filter(item => item.kind !== 'defines')
  const resource = bp.nodes.at(-1)!
  resource.summary = 'Local SQLite table'
  resource.acceptance = ['id is unique']
  resource.analysis = { title: resource.title, summary: resource.summary, kind: 'resource', noFollowUps: true, message: 'Reviewed' }
  assert.ok(blueprintSchema.safeParse(bp).success)
  assert.equal(resourceProblems(bp)[0].nodeId, 'foobar')
  assert.ok(blueprintGaps(bp).some(node => node.id === 'foobar'))
  assert.match(blueprintSpec(bp), /UNASSIGNED/)
  assert.doesNotThrow(() => planBuild(bp), 'the desktop can display a provisional plan while editing')
})

test('validation rejects conflicting owners, invalid directions and resource metadata on other kinds', () => {
  const bp = fixture()
  for (const extra of [
    link('defines', 'save', 'foobar'),
    link('defines', 'foobar', 'save'),
    link('references', 'save', 'storage'),
    link('references', 'foobar', 'save'),
    link('dependency', 'foobar', 'save'),
    link('dependency', 'save', 'foobar'),
    link('references', 'save', 'missing'),
    { ...bp.connections[1], id: 'duplicate' }
  ]) assert.equal(blueprintSchema.safeParse({ ...bp, connections: [...bp.connections, extra] }).success, false, JSON.stringify(extra))
  bp.nodes.push(node('rule', 'rule'), node('ux', 'ux'), node('limit', 'constraint'))
  for (const owner of ['rule', 'ux', 'limit'])
    assert.equal(blueprintSchema.safeParse({ ...bp, connections: [link('defines', owner, 'foobar')] }).success, false)
  bp.nodes.at(1)!.resourceMode = 'external'
  assert.equal(blueprintSchema.safeParse(bp).success, false)
  delete bp.nodes.at(1)!.resourceMode
  bp.nodes.find(node => node.id === 'foobar')!.resourceMode = 'external'
  assert.equal(blueprintSchema.safeParse(bp).success, false, 'external resources cannot have a creator')
})

test('derived, mixed and foundation resource cycles are rejected rather than dropping dependencies', () => {
  const bp = fixture()
  bp.nodes.push(node('other', 'resource'))
  for (const connections of [
    [...bp.connections, link('dependency', 'save', 'storage')],
    [...bp.connections, link('defines', 'save', 'other'), link('references', 'storage', 'other')],
    [...bp.connections, link('references', 'arch', 'foobar')],
    [...bp.connections, link('references', 'root', 'foobar')]
  ]) assert.throws(() => planBuild({ ...bp, connections }), /cycle/)
})

test('resource ordering overrides inferred data and parent ordering and deduplicates dependencies', () => {
  const bp = fixture()
  bp.nodes.find(node => node.id === 'save')!.kind = 'data'
  bp.nodes.find(node => node.id === 'storage')!.parentId = 'save'
  bp.nodes.push(node('other', 'resource'))
  bp.connections.push(link('defines', 'storage', 'other'), link('references', 'save', 'other'), link('dependency', 'storage', 'save'))
  const tasks = planBuild(bp)
  assert.deepEqual(tasks.find(task => task.id === 'agent-save')!.dependsOn, ['foundation', 'agent-storage'])
  assert.deepEqual(tasks.find(task => task.id === 'agent-storage')!.dependsOn, ['foundation'])
  for (let i = 0; i < tasks.length; i++) for (const task of runnableTasks(tasks)) task.status = 'done'
  assert.ok(tasks.every(task => task.status === 'done'))
})

test('shared contracts survive renaming and are persisted in managed instructions', () => {
  const bp = fixture()
  const resource = bp.nodes.at(-1)!
  resource.title = 'Renamed table'
  resource.summary = 'SQLite foobar(id INTEGER PRIMARY KEY)'
  resource.questions = [{ id: 'q', question: 'Location?', why: '', answer: 'app.db' }, { id: 'q2', question: 'Retention?', why: '', answer: '' }]
  resource.acceptance = ['Preserve records during upgrades']
  const text = mergeAgentInstructions('# Keep this\n', bp)
  assert.match(text, /^# Keep this/)
  assert.match(text, /Resource: Renamed table \[foobar\]/)
  assert.match(text, /SQLite foobar/)
  assert.match(text, /app.db/)
  assert.match(text, /Unresolved: Retention\?/)
  assert.match(text, /Preserve records during upgrades/)
  assert.match(text, /Defined by: storage \[storage\]. Creation task: agent-storage/)
  assert.match(text, /Referenced by: save \[save\], open \[open\]/)
  assert.deepEqual(planBuild(bp).find(task => task.id === 'agent-save')!.dependsOn, ['foundation', 'agent-storage'])
})

test('creator prompts assign ownership and consumers receive only successful creator handoffs', () => {
  const bp = fixture(), tasks = planBuild(bp)
  const owner = tasks.find(task => task.id === 'agent-storage')!
  const consumer = tasks.find(task => task.id === 'agent-save')!
  assert.match(agentPrompt(bp, owner), /Resources you DEFINE and must implement before finishing: foobar/)
  assert.match(agentPrompt(bp, owner), /report exact implementation paths, schema, exports\/access methods/)
  owner.status = 'done'
  owner.log = 'Created src/storage.ts, export openFoobar; id is the primary key.'
  const prompt = agentPrompt(bp, consumer, tasks)
  assert.match(prompt, /Resources you REFERENCE: foobar/)
  assert.match(prompt, /Do not recreate, replace or independently redefine it/)
  assert.match(prompt, /Completed defining task agent-storage/)
  assert.match(prompt, /Created src\/storage.ts, export openFoobar/)
  owner.status = 'failed'
  assert.doesNotMatch(agentPrompt(bp, consumer, tasks), /Completed defining task/)
})

test('AI and MCP schemas discover and validate resource creation, modes and links', () => {
  assert.ok(analysisResponse.safeParse({ kind: 'resource', title: 'foobar', message: 'Table contract', questions: [] }).success)
  assert.ok(branchesResponse.safeParse({ branches: [{ kind: 'resource', title: 'foobar' }] }).success)
  assert.ok(desktopCommandSchema.safeParse({ action: 'node_add', parentId: 'root', kind: 'resource', resourceMode: 'external' }).success)
  assert.ok(desktopCommandSchema.safeParse({ action: 'node_update', nodeId: 'foobar', patch: { resourceMode: 'managed' } }).success)
  assert.equal(desktopCommandSchema.safeParse({ action: 'node_update', nodeId: 'foobar', patch: { resourceMode: 'invented' } }).success, false)
  for (const kind of ['defines', 'references']) assert.ok(desktopCommandSchema.safeParse({
    action: 'connection_add', connection: { kind, sourceId: 'save', targetId: 'foobar' }
  }).success)
})

test('build startup rejects unowned resources before writing output, including after reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-resource-draft-'))
  try {
    const studio = new Studio(join(dir, 'data'), join(dir, 'docs'))
    await studio.load()
    const bp = fixture()
    bp.connections = bp.connections.filter(link => link.kind !== 'defines')
    await studio.saveBlueprint(bp)
    const restored = new Studio(join(dir, 'data'), join(dir, 'docs'))
    await restored.load()
    await assert.rejects(restored.startBuild(bp.id), /needs one Defines owner/)
    assert.equal(restored.snapshot().run, undefined)
    assert.equal(restored.snapshot().buildStarting, false)
    assert.deepEqual(await readdir(dir), ['data'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('real local build orders resource consumers, carries handoffs and skips them after owner failure or cancellation', async () => {
  for (const outcome of ['done', 'failed', 'cancelled'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'app-studio-resource-build-'))
    const mock = await startMockServer({ failAgentFor: outcome === 'failed' ? '[Feature] storage.' : undefined, delayAgentMs: 80 })
    try {
      const studio = new Studio(join(dir, 'data'), join(dir, 'docs'))
      await studio.load()
      await studio.saveSettings({ ...studio.snapshot().settings, provider: 'local', localEndpoint: mock.url, maxParallelAgents: 3 })
      await studio.saveBlueprint(fixture())
      await studio.startBuild('bp')
      if (outcome === 'cancelled') {
        for (let i = 0; i < 100 && studio.snapshot().run?.tasks[1].status === 'waiting'; i++)
          await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(studio.snapshot().run?.tasks[1].status, 'running')
        studio.cancelBuild()
      }
      for (let i = 0; i < 200 && studio.snapshot().run?.status === 'running'; i++)
        await new Promise(resolve => setTimeout(resolve, 20))
      const run = studio.snapshot().run!
      assert.equal(run.status, outcome)
      const owner = run.tasks.find(task => task.id === 'agent-storage')!
      const consumer = run.tasks.find(task => task.id === 'agent-save')!
      assert.equal(owner.status, outcome)
      assert.ok(!run.tasks.some(task => task.nodeId === 'foobar'))
      assert.notEqual(studio.snapshot().blueprints[0].nodes.find(node => node.id === 'foobar')!.status, 'built')
      const prompts = mock.requests.filter(body => body.tools && body.messages.at(-1).role === 'user')
        .map(body => body.messages.find((item: { role: string }) => item.role === 'user').content as string)
      if (outcome === 'done') {
        assert.ok(Date.parse(consumer.startedAt!) >= Date.parse(owner.finishedAt!))
        assert.ok(prompts.some(prompt => prompt.startsWith('You are a sub-agent implementing exactly one node of an application blueprint: [Feature] save.') &&
          prompt.includes('Completed defining task agent-storage') && prompt.includes('Wrote implementation notes.')))
        const instructions = await readFile(join(run.outputDir, 'AGENTS.md'), 'utf8')
        assert.match(instructions, /Creation task: agent-storage/)
        assert.match(instructions, /Referenced by: save \[save\], open \[open\]/)
      } else {
        assert.ok(['skipped', 'cancelled'].includes(consumer.status))
        assert.equal(consumer.startedAt, undefined)
        assert.ok(!prompts.some(prompt => /^\S.*\[Feature\] save\./.test(prompt.split('\n')[0])))
      }
    } finally { await mock.close(); await rm(dir, { recursive: true, force: true }) }
  }
})
