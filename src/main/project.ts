import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { extractJson, projectActionPrompt } from '../shared/prompts'
import { projectIsActive, type ProjectAction, type ProjectActivity, type ProviderSettings } from '../shared/types'
import { assertSafeArgs, resolveBinary, runCommand } from './process'
import { runAgent } from './providers'

const commandSchema = z.object({
  binary: z.string().min(1).max(300).regex(/^[a-zA-Z0-9._/-]+$/),
  args: z.array(z.string().min(1).max(1000)).max(80)
}).strict()
export const projectPlanSchema = z.object({
  commands: z.array(commandSchema).min(1).max(8),
  url: z.string().max(300).optional()
}).strict()
type Command = z.infer<typeof commandSchema>
const shells = /^(?:cmd|powershell|pwsh|bash|sh|zsh|fish|dash|csh|wscript|cscript)(?:\.exe)?$/i

function validateCommand(command: Command) {
  assertSafeArgs(command.args)
  const name = command.binary.split('/').at(-1)!
  if (shells.test(name)) throw new Error('Launch a project script or toolchain directly, not a command shell.')
  if (isAbsolute(command.binary) || command.binary.startsWith('/') || command.binary.includes('..'))
    throw new Error('Project executable paths must stay inside the output folder.')
}

export async function projectBinary(directory: string, command: Command) {
  validateCommand(command)
  if (command.binary.includes('/')) {
    const root = await realpath(directory)
    const file = await realpath(resolve(root, command.binary))
    const rel = relative(root, file)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(file)).isFile())
      throw new Error('Project executable escapes the output folder or is not a file.')
    return file
  }
  const binary = resolveBinary(command.binary.replace(/\.exe$/i, ''))
  if (!binary) throw new Error(`Required tool "${command.binary}" was not found on PATH. Install it and restart App Studio.`)
  return binary
}

async function availablePort() {
  const server = createServer()
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => {
        if (error) reject(error)
        else if (address && typeof address !== 'string') resolve(address.port)
        else reject(new Error('Could not allocate a local preview port.'))
      })
    })
  })
}

export function projectUrl(input: string, port: number) {
  const url = new URL(input)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(port) ||
      url.username || url.password || url.search || url.hash)
    throw new Error('The launch agent must use the assigned http://127.0.0.1 preview port without credentials or query parameters.')
  return url.href
}

async function waitForPreview(url: string, signal: AbortSignal) {
  const deadline = Date.now() + 60_000
  let detail = 'No HTTP response yet.'
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]), redirect: 'error' })
      await response.body?.cancel()
      if (response.ok) return
      detail = `HTTP ${response.status}`
    } catch (error) {
      if (signal.aborted) throw error
      detail = error instanceof Error ? error.message : String(error)
    }
    await delay(250, undefined, { signal })
  }
  throw new Error(`The app did not become ready at ${url} within 60 seconds. ${detail}`)
}

export class ProjectRunner {
  activity?: ProjectActivity
  private abort?: AbortController
  private completion?: Promise<void>
  onReady?: (url: string) => Promise<void>

  constructor(
    private readonly update: () => void,
    private readonly save: (activity: ProjectActivity) => Promise<void>,
    private readonly agent = runAgent
  ) {}

  get active() { return projectIsActive(this.activity) }

  restore(activity: ProjectActivity) {
    this.activity = { ...activity, url: undefined }
    if (projectIsActive(activity)) {
      this.activity.status = 'stopped'
      this.activity.finishedAt = new Date().toISOString()
      this.activity.error = 'App Studio closed during this action. Review its output and start it again.'
    }
  }

  start(blueprintId: string, outputDir: string, action: ProjectAction, settings: ProviderSettings) {
    if (this.active) throw new Error('Stop the current project action before starting another.')
    if (settings.provider === 'local') throw new Error('Build project and Run app need a CLI provider. Local-model agents cannot execute commands.')
    const activity: ProjectActivity = {
      id: randomUUID().replace(/-/g, '').slice(0, 16), blueprintId, outputDir, action,
      provider: settings.provider, model: settings.selectedModel[settings.provider],
      status: 'preparing', startedAt: new Date().toISOString(), log: ''
    }
    this.activity = activity
    this.abort = new AbortController()
    this.update()
    this.completion = this.execute(activity, settings, this.abort.signal)
    return activity
  }

  async stop() {
    if (!this.active) return
    this.activity!.status = 'stopping'
    this.update()
    this.abort?.abort()
    await this.completion
  }

  private async execute(activity: ProjectActivity, settings: ProviderSettings, signal: AbortSignal) {
    const append = (text: string) => { activity.log = (activity.log + text).slice(-120_000); this.update() }
    let outcome: ProjectActivity['status'] = 'done'
    let stopRuntime: AbortController | undefined
    let runtime: ReturnType<typeof runCommand> | undefined
    try {
      await this.save(activity)
      if (!(await stat(activity.outputDir)).isDirectory()) throw new Error('Generate the project before building or running it.')
      const port = await availablePort()
      append(`Asking ${activity.provider} to inspect the project and choose ${activity.action} commands...\n`)
      const answer = await this.agent({
        settings, taskId: `project-${activity.action}`, cwd: activity.outputDir,
        prompt: projectActionPrompt(activity.action, process.platform, port),
        timeoutMs: 10 * 60_000, signal, onOutput: append
      })
      signal.throwIfAborted()
      const json = extractJson(answer)
      const failure = z.object({ error: z.string().min(1).max(4000) }).safeParse(json)
      if (failure.success) throw new Error(failure.data.error)
      const plan = projectPlanSchema.parse(json)
      const url = plan.url ? projectUrl(plan.url, port) : undefined
      if (activity.action === 'build' && url) throw new Error('A project build must finish, not launch a server.')
      // Validate every command before executing any of the agent's plan.
      plan.commands.forEach(validateCommand)
      for (let index = 0; index < plan.commands.length; index++) {
        signal.throwIfAborted()
        const command = plan.commands[index]
        const binary = await projectBinary(activity.outputDir, command)
        const launch = activity.action === 'run' && index === plan.commands.length - 1
        append(`\n$ ${command.binary} ${command.args.join(' ')}\n`)
        if (!launch) {
          if (activity.action === 'build') activity.status = 'running'
          const result = await runCommand(binary, {
            cwd: activity.outputDir, args: command.args, stdin: '', timeoutMs: 30 * 60_000, signal, onOutput: append
          })
          if (result.code !== 0) throw new Error(`Command "${command.binary}" exited with code ${result.code}. See project output.`)
          continue
        }
        stopRuntime = new AbortController()
        const runtimeSignal = AbortSignal.any([signal, stopRuntime.signal])
        runtime = runCommand(binary, {
          cwd: activity.outputDir, args: command.args, stdin: '', timeoutMs: 0, signal: runtimeSignal, onOutput: append,
          onSpawn: () => { if (!url && !signal.aborted) { activity.status = 'running'; this.update() } }
        })
        if (url) {
          await Promise.race([
            waitForPreview(url, runtimeSignal),
            runtime.then(result => { throw new Error(`The app exited before its preview was ready (code ${result.code}). See project output.`) })
          ])
          signal.throwIfAborted()
          activity.url = url
          activity.status = 'running'
          append(`\nPreview ready: ${url}\n`)
          await this.onReady?.(url)
        }
        const result = await runtime
        if (result.code !== 0) throw new Error(`The app exited with code ${result.code}. See project output.`)
      }
      append(activity.action === 'build' ? '\nProject build completed successfully.\n' : '\nApplication process exited successfully.\n')
    } catch (error) {
      const cancelled = signal.aborted && error instanceof Error && (error.message === 'Cancelled.' || error.name === 'AbortError')
      outcome = cancelled ? 'stopped' : 'failed'
      activity.error = (cancelled ? 'Stopped by user.' : error instanceof Error ? error.message : String(error)).slice(0, 4000)
      append(`\n${activity.error}\n`)
    } finally {
      stopRuntime?.abort()
      if (runtime) {
        try { await runtime } catch (error) {
          if (!(error instanceof Error && error.message === 'Cancelled.')) {
            outcome = 'failed'
            activity.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000)
          }
        }
      }
      const finished: ProjectActivity = { ...activity, status: outcome, url: undefined, finishedAt: new Date().toISOString() }
      try { await this.save(finished) } catch (error) {
        finished.status = 'failed'
        finished.error = `Could not save project action: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000)
      }
      Object.assign(activity, finished)
      this.update()
    }
  }
}
