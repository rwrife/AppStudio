import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ProjectRunner, projectBinary, projectPlanSchema, projectUrl } from '../src/main/project'
import { runAgent, type ProviderCall } from '../src/main/providers'
import { parseSettings, Studio } from '../src/main/studio'
import { projectIsActive, type ProjectActivity } from '../src/shared/types'
import { desktopCommandSchema } from '../src/shared/automation'

const fixtures = join(import.meta.dirname, 'fixtures')
const settings = parseSettings({ provider: 'copilot' })
const planAgent: typeof runAgent = async (call: ProviderCall) => {
  if (call.prompt.includes('application build agent')) return JSON.stringify({ commands: [{ binary: 'node', args: ['fixture-build.mjs'] }] })
  const port = call.prompt.match(/on port (\d+)/)![1]
  return JSON.stringify({ commands: [{ binary: 'node', args: ['fixture-launch.mjs', port] }], url: `http://127.0.0.1:${port}/` })
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-project-'))
  for (const file of ['fixture-build.mjs', 'fixture-launch.mjs', 'fixture-server.mjs']) await copyFile(join(fixtures, file), join(dir, file))
  return dir
}
async function until(check: () => boolean) {
  for (let i = 0; i < 250; i++) {
    if (check()) return
    await delay(40)
  }
  assert.ok(check(), 'project action reached the expected state')
}

test('AI plans a real build; actual exit codes, logs and persisted results determine success', async () => {
  const dir = await setup()
  let saved: ProjectActivity | undefined
  const runner = new ProjectRunner(() => {}, async activity => { saved = structuredClone(activity) }, planAgent)
  try {
    runner.start('blueprint', dir, 'build', settings)
    assert.throws(() => runner.start('blueprint', dir, 'run', settings), /Stop/)
    await until(() => !runner.active)
    assert.equal(runner.activity?.status, 'done')
    assert.equal(await readFile(join(dir, 'compiled.txt'), 'utf8'), 'Built by a real project process')
    assert.match(saved!.log, /Compiled fixture application/)
    await writeFile(join(dir, 'build-failure'), '')
    runner.start('blueprint', dir, 'build', settings)
    await until(() => !runner.active)
    assert.equal(runner.activity?.status, 'failed')
    assert.match(runner.activity!.error!, /code 7/)
    assert.match(runner.activity!.log, /Fixture compiler error/)
  } finally { await runner.stop(); await rm(dir, { recursive: true, force: true }) }
})

test('Run verifies HTTP readiness, opens a preview and Stop terminates the owned grandchild server', async () => {
  const dir = await setup()
  const runner = new ProjectRunner(() => {}, async () => {}, planAgent)
  let opened: string | undefined
  runner.onReady = async url => { opened = url }
  try {
    runner.start('blueprint', dir, 'run', settings)
    await until(() => !!opened || !runner.active)
    assert.equal(runner.activity?.status, 'running', runner.activity?.error ?? 'The preview must be ready')
    assert.match(await (await fetch(opened!)).text(), /generated app is running/)
    await runner.stop()
    assert.equal(runner.activity?.status, 'stopped')
    assert.equal(runner.activity?.url, undefined)
    await assert.rejects(fetch(opened!))
    assert.equal(runner.active, false)
  } finally { await runner.stop(); await rm(dir, { recursive: true, force: true }) }
})

test('agent errors, malformed plans and missing tools are failures, never successful builds', async () => {
  const dir = await setup()
  try {
    for (const answer of ['{"error":"Cannot build this project."}', 'Not JSON', '{"commands":[{"binary":"app-studio-nonexistent-compiler","args":[]}]}']) {
      const runner = new ProjectRunner(() => {}, async () => {}, async () => answer)
      runner.start('blueprint', dir, 'build', settings)
      await until(() => !runner.active)
      assert.equal(runner.activity?.status, 'failed')
      assert.ok(runner.activity?.error)
    }
    const localRunner = new ProjectRunner(() => {}, async () => {}, planAgent)
    assert.throws(() => localRunner.start('blueprint', dir, 'run', parseSettings({ provider: 'local' })), /CLI provider/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('cancel during agent preparation prevents execution; restart never restores a running preview', async () => {
  const dir = await setup()
  const runner = new ProjectRunner(() => {}, async () => {}, async call => {
    await delay(1000, undefined, { signal: call.signal })
    return planAgent(call)
  })
  try {
    runner.start('blueprint', dir, 'build', settings)
    await runner.stop()
    assert.equal(runner.activity?.status, 'stopped')
    await assert.rejects(readFile(join(dir, 'compiled.txt')))
    runner.restore({ ...runner.activity!, status: 'running', url: 'http://127.0.0.1:1234/' })
    assert.equal(runner.activity?.status, 'stopped')
    assert.equal(runner.activity?.url, undefined)
    assert.match(runner.activity!.error!, /closed during/)
  } finally { await runner.stop(); await rm(dir, { recursive: true, force: true }) }
})

test('launch plans reject shell injection, escaping executables and nonlocal preview URLs', async () => {
  const dir = await setup()
  try {
    for (const command of [
      { binary: 'cmd', args: ['/c', 'echo'] },
      { binary: 'powershell.exe', args: [] },
      { binary: '../outside', args: [] },
      { binary: '/usr/bin/node', args: [] },
      { binary: 'node', args: ['fixture-build.mjs&calc'] },
      { binary: 'node', args: ['a path with spaces'] }
    ]) await assert.rejects(projectBinary(dir, command))
    const external = await mkdtemp(join(tmpdir(), 'app-studio-outside-'))
    try {
      await writeFile(join(external, 'program'), '')
      await symlink(external, join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      await assert.rejects(projectBinary(dir, { binary: './linked/program', args: [] }), /escapes/)
    } finally { await rm(join(dir, 'linked'), { recursive: true, force: true }); await rm(external, { recursive: true, force: true }) }
    for (const url of ['https://evil.example/', 'http://127.0.0.1:9999/', 'http://user:pass@127.0.0.1:1234/', 'file:///tmp/app']) assert.throws(() => projectUrl(url, 1234))
    assert.equal(projectUrl('http://127.0.0.1:1234/', 1234), 'http://127.0.0.1:1234/')
    assert.equal(projectPlanSchema.safeParse({ commands: [] }).success, false)
    assert.equal(desktopCommandSchema.safeParse({ action: 'project_run', command: 'anything' }).success, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Studio permits map edits but blocks generation, deletion and output changes during project actions', async () => {
  const dir = await setup()
  const studio = new Studio(join(dir, 'data'), join(dir, 'docs'))
  try {
    await studio.load()
    const bp = await studio.createBlueprint('A generated application')
    studio.project.activity = { id: 'action', blueprintId: bp.id, outputDir: dir, action: 'run', provider: 'copilot', model: 'auto', status: 'preparing', startedAt: new Date().toISOString(), log: '' }
    assert.ok(projectIsActive(studio.snapshot().projectActivity))
    await assert.rejects(studio.startBuild(bp.id), /Stop the project/)
    await assert.rejects(studio.setOutputDir(bp.id, dir), /Stop the project/)
    await studio.saveBlueprint(bp)
    await assert.rejects(studio.deleteBlueprint(bp.id), /Stop the project/)
    studio.project.activity.status = 'running'
    await studio.saveBlueprint({ ...bp, name: 'Updated while preview runs' })
    assert.equal(studio.snapshot().blueprints[0].name, 'Updated while preview runs')
    await assert.rejects(studio.saveBlueprint({ ...bp, outputDir: dir }), /Stop the project/)
    await assert.rejects(studio.setOutputDir(bp.id, dir), /Stop the project/)
    await assert.rejects(studio.startBuild(bp.id), /Stop the project/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
