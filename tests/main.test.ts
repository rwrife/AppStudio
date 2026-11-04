import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeArgs, runCommand } from '../src/main/process'
import { providerDefs } from '../src/main/providers'
import { Studio } from '../src/main/studio'

test('provider args only contain safe characters', () => {
  for (const def of Object.values(providerDefs)) {
    assertSafeArgs(def.askArgs('claude-sonnet-5.5'))
    assertSafeArgs(def.agentArgs('gpt-5.3-codex'))
    assert.ok(!def.askArgs('m').includes('--allow-all-tools'), `${def.id} ask mode must not grant tools`)
  }
  assert.throws(() => assertSafeArgs(['model & calc']), /unsafe/)
  assert.throws(() => assertSafeArgs(['"x"']), /unsafe/)
})

const fixtures = join(import.meta.dirname, 'fixtures')

test('prompts travel over stdin, never as arguments', async () => {
  const result = await runCommand(process.execPath, { cwd: fixtures, args: ['echo.mjs'], stdin: 'hello "quoted" & | world', timeoutMs: 10_000 })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'hello "quoted" & | world')
})

test('runCommand honours cancellation', async () => {
  const controller = new AbortController()
  const pending = runCommand(process.execPath, { cwd: fixtures, args: ['sleep.mjs'], stdin: '', timeoutMs: 20_000, signal: controller.signal })
  setTimeout(() => controller.abort(), 200)
  await assert.rejects(pending, /Cancelled/)
})

test('demo provider runs a full interview and multi-agent build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-'))
  try {
    const studio = new Studio(join(dir, 'data'), join(dir, 'docs'))
    await studio.load()
    const blueprint = await studio.createBlueprint('A booking app for personal trainers')
    const questions = await studio.interview(blueprint, blueprint.nodes[0].id)
    assert.ok(questions.questions.length >= 3)
    const branches = await studio.suggestBranches(blueprint, blueprint.nodes[0].id)
    const root = blueprint.nodes[0]
    blueprint.nodes.push(...branches.map((item, index) => ({ id: `n${index}`, parentId: root.id, kind: item.kind, title: item.title, summary: item.summary, questions: [], acceptance: [], status: 'draft' as const, position: { x: 300, y: index * 150 } })))
    await studio.saveBlueprint(blueprint)
    const run = await studio.startBuild(blueprint.id)
    for (let i = 0; i < 100 && studio.snapshot().run?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 200))
    const finished = studio.snapshot().run!
    assert.equal(finished.status, 'done', finished.tasks.map(task => `${task.id}:${task.status}:${task.error ?? ''}`).join('\n'))
    const buildable = branches.filter(item => item.kind !== 'rule' && item.kind !== 'constraint').length
    assert.equal(finished.tasks.length, buildable + 2)
    const files = await readdir(join(run.outputDir, 'demo-output'))
    assert.equal(files.length, finished.tasks.length)
    const saved = studio.snapshot().blueprints[0]
    assert.equal(saved.nodes.find(node => node.parentId === null)!.status, 'built')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
