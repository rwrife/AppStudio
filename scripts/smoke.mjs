// End-to-end smoke test: launches the built app against a mock OpenAI-compatible server (Local models),
// drives idea → branches → interview → build, and saves screenshots to docs/screenshots.
import { _electron as electron } from '@playwright/test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockServer } from '../tests/fixtures/mock-openai.mjs'

const root = join(import.meta.dirname, '..')
const shots = join(root, 'docs', 'screenshots')
const data = await mkdtemp(join(tmpdir(), 'app-studio-smoke-'))
await mkdir(shots, { recursive: true })
const mock = await startMockServer()
await writeFile(join(data, 'settings.json'), JSON.stringify({ provider: 'local', localEndpoint: mock.url, maxParallelAgents: 3 }))

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, APP_STUDIO_DATA_DIR: data, APP_STUDIO_HIDDEN: '1' } })
const errors = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  // Hidden windows throttle rendering, which freezes CSS transitions mid-way in screenshots.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }' })
  await page.locator('#idea').fill('A booking app for personal trainers where clients book, reschedule and pay for sessions')
  await page.getByRole('button', { name: /Start blueprint/ }).click()
  await page.getByRole('button', { name: 'Suggest branches' }).click()
  await page.getByRole('dialog', { name: 'Suggested branches' }).getByRole('button', { name: /Add \d+ to map/ }).click()
  await page.getByRole('button', { name: /Ask AI questions/ }).click()
  const answers = page.getByRole('textbox', { name: /^Answer:/ })
  await answers.first().waitFor()
  const count = await answers.count()
  for (let i = 0; i < count; i++) await answers.nth(i).fill(['Personal trainers and their clients', 'Web first, mobile friendly', 'Stripe for payments', 'Cancel up to 24h before'][i % 4])
  await page.getByRole('button', { name: 'Tidy' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(shots, 'blueprint.png') })

  await page.getByRole('button', { name: 'Build', exact: true }).click()
  await page.getByLabel('Build anyway').check()
  await page.getByRole('button', { name: 'Start build' }).click()
  await page.getByText(/All \d+ tasks finished/).waitFor({ timeout: 60_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(shots, 'build.png') })

  await page.getByRole('button', { name: 'Blueprint', exact: true }).click()
  await page.getByTitle('Model settings').click()
  await page.getByRole('dialog').getByText('Model & agents').waitFor()
  await page.getByRole('dialog').getByText('Local models', { exact: true }).click()
  await page.getByRole('dialog').getByText(/server found/).waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'settings.png') })
  if (errors.length) throw new Error(`Renderer errors:\n${errors.join('\n')}`)
  console.log('Smoke test passed; screenshots in docs/screenshots')
} finally {
  await app.close()
  await mock.close()
  await rm(data, { recursive: true, force: true })
}
