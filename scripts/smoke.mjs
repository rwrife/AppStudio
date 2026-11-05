// End-to-end smoke test: launches the built app against a mock OpenAI-compatible server (Local models),
// drives idea → analysis → answer expansion → connections → build, and saves screenshots.
import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockServer } from '../tests/fixtures/mock-openai.mjs'
import { assertMapLayout } from './assert-map-layout.mjs'

const root = join(import.meta.dirname, '..')
const shots = join(root, 'docs', 'screenshots')
const data = await mkdtemp(join(tmpdir(), 'app-studio-smoke-'))
await mkdir(shots, { recursive: true })
const mockOptions = { delayAnalysisMs: 150, failAnalysis: false }
const mock = await startMockServer(mockOptions)
await writeFile(join(data, 'settings.json'), JSON.stringify({ provider: 'local', localEndpoint: mock.url, maxParallelAgents: 3 }))

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, APP_STUDIO_DATA_DIR: data, APP_STUDIO_HIDDEN: '1' } })
const errors = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  // Hidden windows throttle rendering, which freezes CSS transitions mid-way in screenshots.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }' })
  await expect(page.locator('.brand-tagline')).toHaveText('Your mind map. Made real.')
  await expect(page.locator('.topbar')).not.toContainText('POC 0.1')
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    const header = await page.locator('.topbar').evaluate(element => {
      const rect = selector => {
        const box = element.querySelector(selector).getBoundingClientRect()
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
      }
      return {
        height: element.getBoundingClientRect().height,
        brand: rect('.brand'), name: rect('.brand-name > strong'), tagline: rect('.brand-tagline'),
        tabs: rect('.workspace-tabs'), settings: rect('.connection'),
        underline: getComputedStyle(element.querySelector('.workspace-tabs button.active')).borderBottomWidth
      }
    })
    assert.equal(header.height, 78)
    assert.ok(header.tagline.top >= header.name.bottom, 'subtitle sits beneath the wordmark')
    assert.ok(header.brand.right < header.tabs.left, 'branding does not overlap the workspace tabs')
    assert.ok(header.tabs.right < header.settings.left, 'settings do not overlap the workspace tabs')
    assert.ok(Math.abs((header.tabs.left + header.tabs.right) / 2 - width / 2) < 1, 'workspace tabs stay centered')
    assert.equal(header.underline, '2px', 'active workspace has an underline')
  }
  const savedBlueprint = async () => (await page.evaluate(() => window.studio.snapshot())).blueprints[0]
  const idle = async () => expect(page.locator('.viewport-notice')).toHaveCount(0, { timeout: 15_000 })
  const selectNode = async title => {
    await page.locator('.react-flow__node').filter({ has: page.locator('strong', { hasText: new RegExp(`^${title}$`) }) }).click()
    await expect(page.getByRole('textbox', { name: 'Node title' })).toHaveValue(title)
  }
  const dragNode = async (id, dx, dy) => {
    const card = page.locator(`.react-flow__node[data-id="${id}"]`)
    const position = (await savedBlueprint()).nodes.find(node => node.id === id).position
    await card.hover()
    const before = await card.boundingBox()
    assert.ok(before)
    const zoom = await page.locator('.react-flow__viewport').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)
    const start = { x: before.x + before.width / 2, y: before.y + 40 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 2, start.y)
    await page.mouse.move(start.x + dx / 2, start.y + dy / 2, { steps: 6 })
    // A snapshot update during a drag must not hide the card or reset its live position.
    await page.evaluate(async () => {
      const snapshot = await window.studio.snapshot()
      await window.studio.saveBlueprint(snapshot.blueprints[0])
    })
    await expect(card).toBeVisible()
    await expect.poll(async () => {
      const current = await card.boundingBox()
      return Math.abs(current.x - before.x - (dx / 2 - 2)) < 1 && Math.abs(current.y - before.y - dy / 2) < 1
    }).toBe(true)
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 })
    await expect.poll(async () => {
      const current = await card.boundingBox()
      return { x: Math.round(current.x - before.x), y: Math.round(current.y - before.y) }
    }).toEqual({ x: dx - 2, y: dy })
    await page.mouse.up()
    await expect.poll(async () => {
      const current = (await savedBlueprint()).nodes.find(node => node.id === id).position
      return Math.abs(current.x - position.x - (dx - 2) / zoom) < 0.01 && Math.abs(current.y - position.y - dy / zoom) < 0.01
    }).toBe(true)
  }
  const answer = async (question, text) => {
    const card = page.locator('.question').filter({ has: page.getByRole('textbox', { name: `Answer: ${question}`, exact: true }) })
    await card.getByRole('textbox').fill(text)
    await card.getByRole('button', { name: 'Answer', exact: true }).click()
    await idle()
    await expect(card.getByRole('button', { name: 'Answer reviewed' })).toBeDisabled()
  }
  const addNode = async (summary, kind) => {
    await page.locator('.view-tabs').getByRole('button', { name: 'Add child', exact: true }).click()
    await expect(page.getByLabel('Node type')).toHaveValue('unspecified')
    await page.locator('#summary').fill(summary)
    if (kind) await page.getByLabel('Node type').selectOption(kind)
    await page.getByRole('button', { name: 'Save & analyze', exact: true }).click()
    await idle()
  }

  await page.locator('#idea').fill('I want a calculator')
  await page.getByRole('button', { name: /Start blueprint/ }).click()
  await expect(page.getByRole('textbox', { name: 'Node title' })).toHaveValue('Calculator')
  await idle()
  const controls = page.locator('.react-flow__controls')
  const controlButtons = controls.getByRole('button')
  await expect(controlButtons).toHaveCount(3)
  const controlLayout = await controls.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      border: style.borderWidth,
      shadow: style.boxShadow,
      overflow: style.overflow,
      buttons: [...element.querySelectorAll('button')].map(button => {
        const rect = button.getBoundingClientRect()
        const buttonStyle = getComputedStyle(button)
        return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, border: buttonStyle.borderWidth, radius: buttonStyle.borderRadius }
      })
    }
  })
  assert.equal(controlLayout.border, '0px', 'map controls have no shared border')
  assert.equal(controlLayout.shadow, 'none')
  assert.equal(controlLayout.overflow, 'visible', 'keyboard focus outlines are not clipped')
  controlLayout.buttons.forEach((button, index) => {
    assert.equal(button.width, 32)
    assert.equal(button.height, 32)
    assert.equal(button.border, '1px', 'each control has its own complete border')
    assert.equal(button.radius, '7px')
    if (index) assert.equal(button.top - controlLayout.buttons[index - 1].bottom, 6, 'map controls are visibly separated')
  })
  const mapZoom = () => page.locator('.react-flow__viewport').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a)
  await expect.poll(mapZoom).toBe(1)
  await controlButtons.nth(0).click()
  await expect.poll(mapZoom).toBeGreaterThan(1)
  await controlButtons.nth(1).click()
  await expect.poll(mapZoom).toBe(1)
  await controlButtons.nth(0).focus()
  await page.keyboard.press('Tab')
  await expect(controlButtons.nth(1)).toBeFocused()
  await expect(controlButtons.nth(1)).toHaveCSS('outline-width', '2px')
  await controlButtons.nth(0).click()
  await expect.poll(mapZoom).toBeGreaterThan(1)
  await controlButtons.nth(2).click()
  await expect.poll(mapZoom).toBe(1.6)
  await page.mouse.move(0, 0)
  await expect(page.locator('.question')).toHaveCount(4)
  await page.getByRole('textbox', { name: 'Answer: Do you need a basic or scientific calculator, and who will use it?', exact: true }).fill('Scientific, for engineering students.')
  assert.equal((await savedBlueprint()).nodes.length, 1, 'typing does not create nodes')
  await answer('Do you need a basic or scientific calculator, and who will use it?', 'Scientific, for engineering students.')
  assert.equal((await savedBlueprint()).nodes.length, 2)
  const dragNodes = (await savedBlueprint()).nodes
  await dragNode(dragNodes[0].id, 45, 55)
  await dragNode(dragNodes[1].id, -45, -55)
  const draggedPositions = (await savedBlueprint()).nodes.map(node => node.position)
  await page.reload()
  await page.locator('.react-flow__node').first().waitFor()
  assert.deepEqual((await savedBlueprint()).nodes.map(node => node.position), draggedPositions)
  await selectNode('Calculator')
  await expect(page.getByRole('textbox', { name: 'Answer: Which scientific functions should be included first?', exact: true })).toBeVisible()
  await answer('Should this run on desktop, web or mobile?', 'Desktop on Windows.')
  await answer('How will people use the calculator day to day?', 'Quick homework calculations with keyboard input.')
  await answer('Is there a specific look and feel it should follow?', 'A dark theme with large buttons.')
  await answer('Which scientific functions should be included first?', 'Trigonometry, logarithms and square roots.')
  let blueprint = await savedBlueprint()
  assert.equal(blueprint.nodes.length, 4)
  assert.deepEqual(blueprint.nodes.map(node => node.kind), ['app', 'feature', 'architecture', 'ux'])

  await addNode('Save a document to a local file.')
  await expect(page.getByLabel('Node type')).toHaveValue('feature')
  await expect(page.getByRole('textbox', { name: 'Node title' })).toHaveValue('Save document')
  await expect(page.getByText('AI found no follow-up questions needed for the current details.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Node title' }).fill('Save calculation')
  await page.getByRole('textbox', { name: 'Node title' }).press('Enter')
  await page.getByRole('button', { name: 'Save & analyze', exact: true }).click()
  await idle()
  await expect(page.getByRole('textbox', { name: 'Node title' })).toHaveValue('Save calculation')
  await page.getByRole('button', { name: 'Draft with AI' }).click()
  await idle()
  await expect(page.getByLabel('Criterion 1', { exact: true })).toBeVisible()

  await addNode('Open a saved document and display its contents.', 'screen')
  await expect(page.getByLabel('Node type')).toHaveValue('screen', { timeout: 10_000 })
  await expect(page.getByRole('textbox', { name: 'Node title' })).toHaveValue('Open document')
  blueprint = await savedBlueprint()
  const save = blueprint.nodes.find(node => node.title === 'Save calculation')
  const open = blueprint.nodes.find(node => node.title === 'Open document')
  const scientific = blueprint.nodes.find(node => node.title === 'Scientific functions')
  await page.getByLabel('Relationship', { exact: true }).selectOption('dependency')
  await page.getByLabel('Connected node', { exact: true }).selectOption(save.id)
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  await expect(page.locator('.edge-dependency')).toHaveCount(1)
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('already exists')
  await page.getByRole('button', { name: 'Dismiss error' }).click()
  await page.getByLabel('Relationship', { exact: true }).selectOption('similar')
  await page.getByLabel('Connected node', { exact: true }).selectOption(scientific.id)
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  await expect(page.locator('.edge-similar')).toHaveCount(1)
  await selectNode('Save calculation')
  await page.getByLabel('Relationship', { exact: true }).selectOption('dependency')
  await page.getByLabel('Connected node', { exact: true }).selectOption(open.id)
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('cycle')
  await page.getByRole('button', { name: 'Dismiss error' }).click()
  await expect(page.locator('.edge-dependency')).toHaveCount(1)
  await selectNode('Open document')
  await page.getByLabel('Child of').selectOption(blueprint.nodes[0].id)
  await page.getByRole('button', { name: 'Remove connection to Scientific functions' }).click()
  await expect(page.locator('.edge-similar')).toHaveCount(0)
  await page.getByLabel('Relationship', { exact: true }).selectOption('similar')
  await page.getByLabel('Connected node', { exact: true }).selectOption(scientific.id)
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  await expect(page.locator('.edge-similar')).toHaveCount(1)
  await selectNode('Save calculation')

  // A failed analysis still saves the user's details and can be retried after a reload.
  mockOptions.failAnalysis = true
  await addNode('Business rule: dividing by zero shows an explicit error.')
  await expect(page.getByRole('alert')).toContainText('Node saved, but AI analysis failed')
  await expect(page.getByLabel('Node type')).toHaveValue('unspecified')
  const failedNode = (await savedBlueprint()).nodes.find(node => node.title === 'New node')
  assert.equal(failedNode.summary, 'Business rule: dividing by zero shows an explicit error.')
  mockOptions.failAnalysis = false
  await page.reload()
  await page.locator('.react-flow__node').first().waitFor()
  await selectNode('New node')
  await page.getByRole('button', { name: 'Save & analyze', exact: true }).click()
  await idle()
  await expect(page.getByLabel('Node type')).toHaveValue('rule')
  await expect(page.getByRole('textbox', { name: 'Node title' })).toHaveValue('Calculation rules')
  await expect(page.locator('.edge-dependency')).toHaveCount(1)
  await expect(page.locator('.edge-similar')).toHaveCount(1)

  // Resource-side controls create the same directed ownership/reference links as MCP.
  await selectNode('Calculator')
  await addNode('Local SQLite table for saved calculations: id and expression.', 'resource')
  await page.getByRole('textbox', { name: 'Node title' }).fill('Calculation store')
  await page.getByRole('textbox', { name: 'Node title' }).press('Enter')
  await expect(page.getByLabel('Resource provision')).toHaveValue('managed')
  await page.getByRole('button', { name: 'Build', exact: true }).click()
  await page.getByLabel('Build anyway').check()
  await expect(page.getByText('Resource ownership is incomplete')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start build', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Blueprint', exact: true }).click()
  await selectNode('Calculation store')
  blueprint = await savedBlueprint()
  const architecture = blueprint.nodes.find(node => node.kind === 'architecture')
  const resource = blueprint.nodes.find(node => node.kind === 'resource')
  await page.getByLabel('Relationship', { exact: true }).selectOption('defines')
  await page.getByLabel('Connected node', { exact: true }).selectOption(architecture.id)
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  await expect(page.locator('.connection-list')).toContainText('Defined by Desktop runtime')
  await page.getByLabel('Resource provision').selectOption('external')
  await expect(page.getByRole('alert')).toContainText('Externally provided')
  await page.getByRole('button', { name: 'Dismiss error' }).click()
  await expect(page.getByLabel('Resource provision')).toHaveValue('managed')
  await page.getByRole('button', { name: 'Remove connection to Desktop runtime' }).click()
  await page.getByLabel('Resource provision').selectOption('external')
  await expect(page.locator('.mind-card.kind-resource')).toContainText('External resource')
  await page.getByLabel('Resource provision').selectOption('managed')
  await page.getByLabel('Relationship', { exact: true }).selectOption('defines')
  await page.getByLabel('Connected node', { exact: true }).selectOption(architecture.id)
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  await page.getByLabel('Relationship', { exact: true }).selectOption('references')
  await page.getByLabel('Connected node', { exact: true }).selectOption(save.id)
  await page.getByRole('button', { name: 'Add connection', exact: true }).click()
  await expect(page.locator('.edge-defines')).toHaveCount(1)
  await expect(page.locator('.edge-references')).toHaveCount(1)
  await expect(page.locator('.connection-list')).toContainText('Referenced by Save calculation')

  // Distinct node-type fills and labels communicate both kind and instruction-only output.
  const colors = await page.locator('.mind-card').evaluateAll(cards => Object.fromEntries(cards.map(card => [
    [...card.classList].find(name => name.startsWith('kind-')), getComputedStyle(card).backgroundColor
  ])))
  assert.equal(new Set(Object.values(colors)).size, Object.keys(colors).length)
  await expect(page.locator('.mind-card.kind-rule')).toContainText('AGENTS.md instructions')
  await page.getByRole('button', { name: 'Tidy' }).click()
  await page.waitForTimeout(800)
  await assertMapLayout(page, await savedBlueprint())
  await selectNode('Calculator')
  await page.locator('.right-panel').evaluate(panel => { panel.scrollTop = 0 })
  await page.screenshot({ path: join(shots, 'blueprint.png') })
  await selectNode('Calculation store')
  await page.locator('.right-panel').evaluate(panel => { panel.scrollTop = 0 })
  await page.screenshot({ path: join(shots, 'resources.png') })

  await page.getByRole('button', { name: 'Build', exact: true }).click()
  await expect(page.getByText(/3 instruction-only nodes go to/)).toBeVisible()
  await page.getByLabel('Build anyway').check()
  await page.getByRole('button', { name: 'Start build' }).click()
  await page.getByText(/All \d+ tasks finished/).waitFor({ timeout: 60_000 })
  await page.waitForTimeout(500)
  const finished = await page.evaluate(() => window.studio.snapshot())
  const instructions = await readFile(join(finished.run.outputDir, 'AGENTS.md'), 'utf8')
  assert.match(instructions, /Desktop runtime/)
  assert.match(instructions, /Dark visual style/)
  assert.match(instructions, /Calculation rules/)
  assert.match(instructions, /Resource: Calculation store/)
  assert.match(instructions, /Creation task: foundation/)
  assert.match(instructions, /Referenced by: Save calculation/)
  assert.equal(finished.run.tasks.length, 5, 'three code nodes plus foundation and integration')
  assert.ok(!finished.run.tasks.some(task => task.nodeId === resource.id))
  const openTask = finished.run.tasks.find(task => task.nodeId === open.id)
  assert.ok(openTask.dependsOn.includes(`agent-${save.id}`))
  const hidePrivatePath = await page.addStyleTag({ content: '.run-meta, .path-field input { visibility: hidden; }' })
  await page.screenshot({ path: join(shots, 'build.png') })
  await hidePrivatePath.evaluate(element => element.remove())

  await page.getByRole('button', { name: 'Blueprint', exact: true }).click()
  await selectNode('Save calculation')
  await expect(page.getByRole('textbox', { name: 'Node title' })).toHaveValue('Save calculation')
  await page.getByTitle('Model settings').click()
  await page.getByRole('dialog').getByText('Model & agents').waitFor()
  await page.getByRole('dialog').getByText('Local models', { exact: true }).click()
  await page.getByRole('dialog').getByText(/server found/).waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'settings.png') })
  await page.getByLabel('Enable local MCP server').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(shots, 'mcp.png') })
  if (errors.length) throw new Error(`Renderer errors:\n${errors.join('\n')}`)
  console.log('Smoke test passed; screenshots in docs/screenshots')
} finally {
  await app.close()
  await mock.close()
  await rm(data, { recursive: true, force: true })
}
