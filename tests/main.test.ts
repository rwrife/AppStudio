import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeArgs, runCommand } from '../src/main/process'
import { providerDefs } from '../src/main/providers'
import { localAgent, localAsk, parseFileBlocks, safePath, stripThinking } from '../src/main/local'
import { parseSettings, Studio } from '../src/main/studio'
import { startMockServer } from './fixtures/mock-openai.mjs'

test('provider args only contain safe characters', () => {
  for (const def of Object.values(providerDefs)) {
    assertSafeArgs(def.askArgs('claude-sonnet-5.5'))
    assertSafeArgs(def.agentArgs('gpt-5.3-codex'))
    assert.ok(!def.askArgs('m').includes('--allow-all-tools'), `${def.id} ask mode must not grant tools`)
  }
  assert.deepEqual(providerDefs.local.agentArgs('m'), [], 'local models are called over HTTP, not a CLI')
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

test('local provider runs a full interview and multi-agent build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-'))
  const mock = await startMockServer({ thinking: true })
  try {
    const studio = new Studio(join(dir, 'data'), join(dir, 'docs'))
    await studio.load()
    await studio.saveSettings({ ...studio.snapshot().settings, provider: 'local', localEndpoint: mock.url })
    assert.match(await studio.testProvider(), /Local models/)
    const blueprint = await studio.createBlueprint('A booking app for personal trainers')
    const questions = await studio.interview(blueprint, blueprint.nodes[0].id)
    assert.ok(questions.questions.length >= 3)
    const branches = await studio.suggestBranches(blueprint, blueprint.nodes[0].id)
    const root = blueprint.nodes[0]
    blueprint.nodes.push(...branches.map((item, index) => ({ id: `n${index}`, parentId: root.id, kind: item.kind, title: item.title, summary: item.summary, questions: [], acceptance: [], status: 'draft' as const, position: { x: 300, y: index * 150 } })))
    blueprint.nodes.push(
      { id: 'ux', parentId: root.id, kind: 'ux', title: 'Visual language', summary: 'Use large high-contrast controls.', questions: [], acceptance: [], status: 'draft', position: { x: 600, y: 0 } },
      { id: 'architecture', parentId: root.id, kind: 'architecture', title: 'Tooling', summary: 'Use TypeScript.', questions: [], acceptance: [], status: 'draft', position: { x: 600, y: 200 } }
    )
    await studio.saveBlueprint(blueprint)
    const output = studio.outputDirFor(blueprint.id)
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'AGENTS.md'), '# Existing guidance\nKeep the license.\n')
    const run = await studio.startBuild(blueprint.id)
    for (let i = 0; i < 100 && studio.snapshot().run?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 200))
    const finished = studio.snapshot().run!
    assert.equal(finished.status, 'done', finished.tasks.map(task => `${task.id}:${task.status}:${task.error ?? ''}`).join('\n'))
    const buildable = branches.filter(item => item.kind !== 'rule' && item.kind !== 'constraint').length
    assert.equal(finished.tasks.length, buildable + 2)
    const folders = (await readdir(run.outputDir)).filter(name => name.startsWith('task-'))
    assert.equal(folders.length, finished.tasks.length)
    assert.ok(mock.requests.every(body => body.model === 'mock-model'), 'uses the first non-embedding model')
    const saved = studio.snapshot().blueprints[0]
    assert.equal(saved.nodes.find(node => node.parentId === null)!.status, 'built')
    assert.ok(!finished.tasks.some(task => task.nodeId === 'ux' || task.nodeId === 'architecture'))
    const instructions = await readFile(join(output, 'AGENTS.md'), 'utf8')
    assert.match(instructions, /# Existing guidance\nKeep the license/)
    assert.match(instructions, /UX design: Visual language/)
    assert.match(instructions, /Architecture: Tooling/)
    assert.match(instructions, /Use TypeScript/)
    await studio.saveBlueprint({ ...saved, name: 'Renamed project' })
    assert.equal(studio.outputDirFor(saved.id), output, 'renaming must not move existing code or AGENTS.md to another folder')
  } finally { await mock.close(); await rm(dir, { recursive: true, force: true }) }
})

test('analysis names and classifies unselected nodes but preserves selected types and user titles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-analysis-'))
  const mock = await startMockServer({ analysis: { kind: 'architecture', title: 'Desktop tooling', message: 'A technical decision.', questions: [] } })
  try {
    const studio = new Studio(dir)
    await studio.load()
    await studio.saveSettings({ ...studio.snapshot().settings, localEndpoint: mock.url })
    const bp = await studio.createBlueprint('I want a calculator')
    const child = { ...bp.nodes[0], id: 'child', parentId: bp.nodes[0].id, kind: 'unspecified' as const, title: 'New node', summary: 'Use Electron on Windows.' }
    bp.nodes.push(child)
    const result = await studio.analyzeNode(bp, child.id)
    assert.equal(result.kind, 'architecture')
    assert.equal(result.title, 'Desktop tooling')
    assert.deepEqual(result.questions, [])
    const explicit = { ...child, kind: 'feature' as const, title: 'My chosen name', titleSource: 'manual' as const }
    bp.nodes[1] = explicit
    const selected = await studio.analyzeNode(bp, explicit.id)
    assert.equal(selected.kind, 'feature')
    assert.equal(selected.title, 'My chosen name')
    const legacy = { ...explicit, titleSource: undefined }
    bp.nodes[1] = legacy
    assert.equal((await studio.analyzeNode(bp, legacy.id)).title, legacy.title)
    assert.ok(mock.requests.every(request => !request.tools), 'analysis has no file or command tools')
  } finally { await mock.close(); await rm(dir, { recursive: true, force: true }) }
})

test('submitted answers add only new questions and branches and carry the whole idea context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-answer-'))
  const mock = await startMockServer({
    answer: {
      questions: [{ question: 'Which functions?', why: 'Scope.' }, { question: 'Which functions?', why: 'Duplicate.' }, { question: 'Who is it for?', why: 'Already asked.' }],
      branches: [
        { kind: 'feature', title: 'Scientific functions', summary: 'Support trigonometry.' },
        { kind: 'feature', title: 'Scientific functions', summary: 'Duplicate.' },
        { kind: 'ux', title: 'Dark theme', summary: 'Use a dark visual theme.' },
        { kind: 'architecture', title: 'Desktop runtime', summary: 'Already exists.' }
      ]
    }
  })
  try {
    const studio = new Studio(dir)
    await studio.load()
    await studio.saveSettings({ ...studio.snapshot().settings, localEndpoint: mock.url })
    const bp = await studio.createBlueprint('I want a calculator')
    const root = bp.nodes[0]
    root.questions = [{ id: 'q', question: 'Who is it for?', why: '', answer: 'Engineering students need scientific functions and a dark theme.' }]
    bp.nodes.push({ ...root, id: 'existing', parentId: root.id, kind: 'architecture', title: 'Desktop runtime', questions: [] })
    const result = await studio.answerQuestion(bp, root.id, 'q')
    assert.deepEqual(result.branches.map(item => item.title), ['Scientific functions', 'Dark theme'])
    assert.deepEqual(result.questions.map(item => item.question), ['Which functions?'])
    assert.match(mock.requests[0].messages[0].content + mock.requests[0].messages[1].content, /Engineering students/)
    assert.ok(mock.requests.every(request => !request.tools), 'answer review is read-only')
    root.questions[0].answer = ' '
    await assert.rejects(studio.answerQuestion(bp, root.id, 'q'), /Enter an answer/)
  } finally { await mock.close(); await rm(dir, { recursive: true, force: true }) }
})

test('malformed analysis is retried and rejected; saved details remain intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-invalid-analysis-'))
  const mock = await startMockServer({ analysis: { kind: 'not-a-kind', title: 'Bad', message: 'Bad', questions: [] } })
  try {
    const studio = new Studio(dir)
    await studio.load()
    await studio.saveSettings({ ...studio.snapshot().settings, localEndpoint: mock.url })
    const bp = await studio.createBlueprint('A calculator with keyboard shortcuts')
    await assert.rejects(studio.analyzeNode(bp, bp.nodes[0].id), /did not match the expected shape/)
    assert.equal(mock.requests.length, 2)
    const restored = new Studio(dir)
    await restored.load()
    assert.equal(restored.snapshot().blueprints[0].nodes[0].summary, 'A calculator with keyboard shortcuts')
  } finally { await mock.close(); await rm(dir, { recursive: true, force: true }) }
})

test('local agent falls back to file blocks when the server rejects tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-'))
  const mock = await startMockServer({ rejectTools: true })
  try {
    const settings = parseSettings({ provider: 'local', localEndpoint: mock.url })
    const lines: string[] = []
    await localAgent(settings, 'Build it', dir, 20_000, undefined, chunk => lines.push(chunk))
    assert.match(lines.join(''), /file-block mode/)
    assert.equal(await readFile(join(dir, 'block-1', 'index.ts'), 'utf8'), 'export const ok = true\n')
  } finally { await mock.close(); await rm(dir, { recursive: true, force: true }) }
})

test('local provider reports a missing server clearly', async () => {
  const settings = parseSettings({ provider: 'local', localEndpoint: 'http://127.0.0.1:9/v1' })
  await assert.rejects(localAsk(settings, 'hi', 5_000), /No OpenAI-compatible server answered at http:\/\/127\.0\.0\.1:9\/v1/)
})

test('safePath keeps agent writes inside the project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-'))
  try {
    for (const bad of ['../x', '..\\x', 'C:\\x', '/etc/passwd', '.git/config', 'src/../../x', '.app-studio/state.json', '']) {
      await assert.rejects(safePath(dir, bad), Error, bad)
    }
    assert.equal((await safePath(dir, 'src/a.ts')).rel, 'src/a.ts')
    assert.equal((await safePath(dir, 'src\\b.ts')).rel, 'src/b.ts')
    assert.equal((await safePath(dir, '.')).rel, '.')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('parseFileBlocks and stripThinking handle typical local model output', () => {
  const files = parseFileBlocks('Intro\n### FILE: src/a.ts\n```ts\nconst a = 1\n```\n\n## FILE: `README.md`\n```\n# Hi\n```')
  assert.deepEqual(files, [{ path: 'src/a.ts', content: 'const a = 1\n' }, { path: 'README.md', content: '# Hi\n' }])
  assert.equal(stripThinking('<think>{ "x": 1 }</think>{"ok":true}'), '{"ok":true}')
  assert.equal(stripThinking('stray reasoning</think> READY'), 'READY')
})

test('saved settings migrate from the retired demo provider', () => {
  const migrated = parseSettings({ provider: 'demo', models: { copilot: ['auto'], codex: [], claude: [], demo: [] }, selectedModel: { copilot: 'auto', codex: '', claude: '', demo: '' }, maxParallelAgents: 2, binaryPaths: { copilot: '', codex: '', claude: '', demo: '' } })
  assert.equal(migrated.provider, 'local')
  assert.equal(migrated.maxParallelAgents, 2)
  assert.deepEqual(migrated.models.local, [])
  assert.equal(migrated.selectedModel.copilot, 'auto')
  assert.equal(migrated.localEndpoint, '')
  const kept = parseSettings({ provider: 'copilot', localEndpoint: 'file:///etc', maxParallelAgents: 99 })
  assert.equal(kept.provider, 'copilot', 'one bad field does not reset the rest')
  assert.equal(kept.localEndpoint, '')
  assert.equal(kept.maxParallelAgents, 3)
  assert.equal(parseSettings(null).provider, 'local')
})

test('build startup is locked and output paths must be absolute', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-start-lock-'))
  const mock = await startMockServer()
  try {
    const studio = new Studio(dir, join(dir, 'docs'))
    await studio.load()
    await studio.saveSettings({ ...studio.snapshot().settings, localEndpoint: mock.url })
    const bp = await studio.createBlueprint('An app with one feature')
    await assert.rejects(studio.setOutputDir(bp.id, 'relative'), /absolute/)
    const first = studio.startBuild(bp.id)
    assert.equal(studio.snapshot().buildStarting, true)
    await assert.rejects(studio.startBuild(bp.id), /already running/)
    await first
    assert.equal(studio.snapshot().buildStarting, false)
    studio.cancelBuild()
    for (let i = 0; i < 100 && studio.snapshot().run?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.notEqual(studio.snapshot().run?.status, 'running')
  } finally { await mock.close(); await rm(dir, { recursive: true, force: true }) }
})

test('nodes and blueprint names can be added during generation without changing the active plan or losing status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-studio-next-build-'))
  const mock = await startMockServer({ delayAgentMs: 150 })
  const studio = new Studio(join(dir, 'data'), join(dir, 'docs'))
  try {
    await studio.load()
    await studio.saveSettings({ ...studio.snapshot().settings, localEndpoint: mock.url })
    const bp = await studio.createBlueprint('An evolving calculator')
    await studio.startBuild(bp.id)
    const next = structuredClone(studio.snapshot().blueprints[0])
    next.nodes.push({ id: 'later', parentId: next.nodes[0].id, kind: 'feature', title: 'A later requirement', summary: 'Save for next rebuild.', questions: [], acceptance: [], status: 'draft', position: { x: 300, y: 0 } })
    await studio.saveBlueprint(next)
    await studio.renameBlueprint(bp.id, 'My calculator')
    const lateSave = structuredClone(studio.snapshot().blueprints[0])
    const bad = structuredClone(lateSave)
    bad.nodes[0].summary = 'Changing an active requirement'
    await assert.rejects(studio.saveBlueprint(bad), /read-only/)
    assert.ok(!studio.snapshot().run!.tasks.some(task => task.nodeId === 'later'))
    for (let i = 0; i < 100 && studio.snapshot().run?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(studio.snapshot().run!.status, 'done')
    await studio.saveBlueprint(lateSave)
    assert.equal(studio.snapshot().blueprints[0].nodes[0].status, 'built', 'a delayed autosave cannot overwrite live build status')
    assert.equal(studio.snapshot().blueprints[0].nodes.find(node => node.id === 'later')!.status, 'draft')
    assert.equal(studio.snapshot().blueprints[0].name, 'My calculator')
    assert.equal(studio.snapshot().blueprints[0].outputDir, next.outputDir)
    await studio.startBuild(bp.id)
    for (let i = 0; i < 100 && studio.snapshot().run?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(studio.snapshot().run!.tasks.find(task => task.nodeId === 'later')!.status, 'done')
  } finally { studio.cancelBuild(); await mock.close(); await rm(dir, { recursive: true, force: true }) }
})
