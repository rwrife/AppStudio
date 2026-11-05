import { _electron as electron, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockServer } from '../tests/fixtures/mock-openai.mjs'

const root = join(import.meta.dirname, '..')
const data = await mkdtemp(join(tmpdir(), 'app-studio-mcp-smoke-'))
const options = { delayAnalysisMs: 200, failAnalysis: false }
const mock = await startMockServer(options)
await writeFile(join(data, 'settings.json'), JSON.stringify({ provider: 'local', localEndpoint: mock.url, maxParallelAgents: 1 }))
const launchOptions = { args: [root], cwd: root, env: { ...process.env, APP_STUDIO_DATA_DIR: data, APP_STUDIO_MCP_PORT: '0', APP_STUDIO_HIDDEN: '1' } }
let app = await electron.launch(launchOptions)
let client
let appClosed = false
const exercised = new Set()
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('#idea').waitFor()
  // Exercise OS-boundary tools without changing the user's clipboard or opening Explorer.
  await app.evaluate(({ clipboard, shell }) => {
    clipboard.writeText = text => { globalThis.mcpCopiedConfig = JSON.parse(text) }
    shell.openPath = async path => { globalThis.mcpRevealedPath = path; return '' }
  })
  assert.equal((await page.evaluate(() => window.studio.mcpStatus())).state, 'disabled')
  const enable = async () => {
    await page.getByTitle('Model settings').click()
    await page.getByLabel('Enable local MCP server').check()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    return page.evaluate(() => window.studio.mcpStatus())
  }
  const firstStatus = await enable()
  assert.equal(firstStatus.state, 'running')
  const connect = async status => {
    client = new Client({ name: 'app-studio-desktop-smoke', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(status.endpoint), { requestInit: { headers: { Authorization: `Bearer ${status.token}` } } }))
  }
  await connect(firstStatus)
  const tools = (await client.listTools()).tools
  const call = async (name, args = {}, expectedError) => {
    exercised.add(name)
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })
    const text = response.content.find(item => item.type === 'text')?.text
    if (expectedError) { assert.equal(response.isError, true, name); assert.match(text, expectedError); return }
    assert.ok(!response.isError, `${name}: ${text}`)
    return JSON.parse(text)
  }
  const state = () => call('studio_get_state')
  const active = result => result.snapshot.blueprints.find(bp => bp.id === result.desktop.activeBlueprintId)
  assert.equal((await state()).snapshot.blueprints.length, 0)
  await call('providers_refresh')
  await call('provider_test')
  await call('mcp_copy_config')
  assert.equal(await app.evaluate(() => globalThis.mcpCopiedConfig.mcpServers['app-studio'].headers.Authorization.length), 71)

  let result = await call('blueprint_create', { idea: 'I want a calculator' })
  let blueprint = active(result)
  assert.ok(blueprint, 'created blueprint is active in desktop state')
  const blueprintId = blueprint.id
  const rootId = blueprint.nodes[0].id
  assert.equal(blueprint.nodes[0].title, 'Calculator')
  assert.equal(blueprint.nodes[0].questions.length, 4)
  await expect(page.getByRole('textbox', { name: 'Node title' })).toHaveValue('Calculator')
  const temporary = active(await call('blueprint_create', { idea: 'Temporary app', analyze: false }))
  await call('blueprint_open', { blueprintId })
  await call('blueprint_delete', { blueprintId: temporary.id, confirm: true })
  assert.equal((await state()).snapshot.blueprints.length, 1)

  result = await call('node_add', { parentId: rootId })
  const saveId = result.result.nodeId
  await call('node_update', { nodeId: saveId, patch: { summary: 'Save a document to a local file.' } })
  const analyzing = call('node_analyze', { nodeId: saveId })
  await expect(page.locator('.viewport-notice')).toContainText('Analyzing')
  assert.ok((await state()).desktop.busy)
  await call('node_update', { nodeId: saveId, patch: { title: 'Must not apply' } }, /running|busy/i)
  await analyzing
  await expect(page.getByRole('textbox', { name: 'Node title' })).toHaveValue('Save document')
  await call('node_update', { nodeId: saveId, patch: { title: 'Save calculation' } })
  await call('node_analyze', { nodeId: saveId })
  await call('acceptance_draft', { nodeId: saveId })
  await call('node_interview', { nodeId: saveId })
  blueprint = active(await state())
  const savedNode = blueprint.nodes.find(node => node.id === saveId)
  assert.equal(savedNode.titleSource, 'manual')
  assert.equal(savedNode.title, 'Save calculation')
  assert.ok(savedNode.acceptance.length && savedNode.questions.length)
  assert.equal(savedNode.summary, 'Save a document to a local file.', 'partial updates preserve other fields')
  const questionId = blueprint.nodes[0].questions[0].id
  await call('question_answer', { nodeId: rootId, questionId, answer: 'Scientific, for engineering students.' })
  blueprint = active(await state())
  assert.ok(blueprint.nodes.some(node => node.title === 'Scientific functions'))
  assert.equal(blueprint.nodes[0].questions[0].reviewedAnswer, 'Scientific, for engineering students.')
  await call('branches_suggest', { nodeId: rootId })
  await expect(page.getByRole('dialog', { name: 'Suggested branches' })).toBeVisible()
  await call('branches_accept', { indices: [0] })
  await call('branches_suggest', { nodeId: rootId })
  await call('branches_dismiss')
  await expect(page.getByRole('dialog', { name: 'Suggested branches' })).toHaveCount(0)
  result = await call('node_add', { parentId: rootId, kind: 'screen', title: 'Open calculation', summary: 'Open a saved document.' })
  const openId = result.result.nodeId
  await call('connection_add', { connection: { sourceId: saveId, targetId: openId, kind: 'dependency' } })
  await call('connection_add', { connection: { sourceId: openId, targetId: saveId, kind: 'dependency' } }, /cycle/)
  await call('desktop_dismiss_error')
  const link = active(await state()).connections[0]
  await call('connection_delete', { connectionId: link.id })
  await call('connection_add', { connection: { sourceId: saveId, targetId: openId, kind: 'similar' } })
  await expect(page.locator('.edge-similar')).toHaveCount(1)
  await call('map_tidy')
  await call('map_viewport', { viewport: { x: 40, y: 70, zoom: 0.5 } })
  assert.deepEqual((await state()).viewport, { x: 40, y: 70, zoom: 0.5 })
  await call('map_viewport')
  await call('desktop_set_view', { nodeId: saveId, tab: 'map' })

  // A focused title draft must be preserved before an agent changes selection.
  await page.getByRole('textbox', { name: 'Node title' }).fill('User draft title')
  result = await state()
  assert.equal(result.pendingNodeTitle, 'User draft title')
  assert.equal(result.hasUnsavedBlueprintEdits, true)
  await call('desktop_set_view', { nodeId: openId })
  assert.equal(active(await state()).nodes.find(node => node.id === saveId).title, 'User draft title')
  blueprint = active(await state())
  await call('node_update', { nodeId: openId, patch: { summary: 'An intervening edit.' } })
  await call('blueprint_save', { blueprint, expectedUpdatedAt: blueprint.updatedAt }, /changed/)
  blueprint = active(await state())
  blueprint.name = 'MCP calculator'
  blueprint.nodes.find(node => node.id === openId).status = 'built'
  await call('blueprint_save', { blueprint, expectedUpdatedAt: blueprint.updatedAt })
  assert.notEqual(active(await state()).nodes.find(node => node.id === openId).status, 'built')

  // Provider failures must be tool errors, not success-shaped results.
  options.failAnalysis = true
  await call('node_update', { nodeId: openId, patch: { summary: 'Keep this after failure.' } })
  await call('node_analyze', { nodeId: openId }, /AI analysis failed/)
  assert.equal(active(await state()).nodes.find(node => node.id === openId).summary, 'Keep this after failure.')
  options.failAnalysis = false
  await call('desktop_dismiss_error')
  await call('node_analyze', { nodeId: openId })
  const toDelete = (await call('node_add', { parentId: openId })).result.nodeId
  await call('node_add', { parentId: toDelete })
  await call('node_delete', { nodeId: toDelete, confirm: true })
  assert.ok(!active(await state()).nodes.some(node => node.id === toDelete || node.parentId === toDelete))

  await call('desktop_set_view', { settingsOpen: true })
  await expect(page.getByRole('dialog', { name: 'Model & agents' })).toBeVisible()
  assert.ok((await call('desktop_scroll', { panel: 'settings', top: 1_000_000 })).result.top > 0)
  await page.locator('#parallel').fill('2')
  await call('desktop_set_view', { settingsOpen: false }, /unsaved edits/)
  await call('desktop_set_view', { settingsOpen: false, discardSettingsEdits: true })
  await call('settings_update', { patch: { maxParallelAgents: 2, selectedModel: { local: 'mock-model' } } })
  result = await state()
  assert.equal(result.snapshot.settings.mcpEnabled, true)
  assert.equal(result.snapshot.settings.maxParallelAgents, 2)
  assert.equal(result.snapshot.settings.localEndpoint, mock.url)
  await call('build_set_output', { directory: 'relative' }, /absolute/)
  const output = join(data, 'generated')
  await call('build_set_output', { directory: output })
  await call('build_reveal')
  assert.equal(await app.evaluate(() => globalThis.mcpRevealedPath), output)
  await call('build_start', {}, /detail/)
  await call('build_start', { allowGaps: true })
  await call('node_update', { nodeId: rootId, patch: { summary: 'Forbidden during build' } }, /Stop|build/)
  await call('build_cancel')
  await expect.poll(async () => (await state()).snapshot.run.status).not.toBe('running')
  await call('build_start', { allowGaps: true })
  await expect.poll(async () => (await state()).snapshot.run.status, { timeout: 60_000 }).toBe('done')
  await call('desktop_set_view', { tab: 'build', taskId: 'foundation' })
  await expect(page.locator('.task-card.selected')).toContainText('Foundation')
  assert.match(await readFile(join(output, 'AGENTS.md'), 'utf8'), /# App Studio instructions/)
  assert.equal((await state()).snapshot.run.tasks.every(task => task.status === 'done' && task.log.length > 0), true)

  await call('desktop_window', { operation: 'resize', width: 1300, height: 850 })
  result = await call('desktop_window', { operation: 'state' })
  assert.equal(result.bounds.width, 1300)
  exercised.add('desktop_screenshot')
  const image = await client.callTool({ name: 'desktop_screenshot' })
  assert.ok(!image.isError)
  assert.equal(image.content[0].mimeType, 'image/png')
  assert.equal(Buffer.from(image.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG')
  await call('desktop_set_view', { tab: 'map' })
  await page.reload()
  await page.locator('.react-flow__node').first().waitFor()
  assert.equal(active(await state()).name, 'MCP calculator', 'changes persist across reload')
  await call('settings_update', { patch: { mcpEnabled: false } })
  assert.equal((await page.evaluate(() => window.studio.mcpStatus())).state, 'disabled')
  assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).mcpEnabled, false)
  await assert.rejects(fetch(firstStatus.endpoint))
  await client.close()
  const secondStatus = await enable()
  assert.notEqual(secondStatus.token, firstStatus.token)
  assert.equal((await fetch(secondStatus.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${firstStatus.token}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
  await connect(secondStatus)
  assert.equal(active(await state()).name, 'MCP calculator')
  assert.deepEqual([...exercised].sort(), tools.map(tool => tool.name).sort(), 'every registered tool is exercised')
  assert.deepEqual(errors, [], 'no renderer errors')
  await client.close()
  await app.close()
  appClosed = true
  await assert.rejects(fetch(secondStatus.endpoint), 'app exit closes the listener')
  assert.ok(!(await readFile(join(data, 'settings.json'), 'utf8')).includes(secondStatus.token), 'tokens are not persisted')
  app = await electron.launch(launchOptions)
  appClosed = false
  const restartedPage = await app.firstWindow()
  await restartedPage.locator('.react-flow__node').first().waitFor()
  const restarted = await restartedPage.evaluate(() => window.studio.mcpStatus())
  assert.equal(restarted.state, 'running', 'saved enable setting starts the server on app launch')
  assert.notEqual(restarted.token, secondStatus.token)
  await connect(restarted)
  assert.equal(active(await state()).name, 'MCP calculator')
  await client.close()
  await app.close()
  appClosed = true
  console.log(`MCP desktop smoke passed: ${exercised.size} tools, real protocol, persisted workflows and desktop outcomes.`)
} finally {
  await client?.close()
  if (!appClosed) await app.close()
  await mock.close()
  await rm(data, { recursive: true, force: true })
}
