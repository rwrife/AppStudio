import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

export interface RunOptions {
  cwd: string
  args: string[]
  stdin: string
  timeoutMs: number
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

const safeArg = /^[a-zA-Z0-9._:/@=,-]+$/
const maxCapture = 2_000_000

export function assertSafeArgs(args: string[]) {
  for (const arg of args) if (!safeArg.test(arg)) throw new Error(`Refusing unsafe CLI argument: ${JSON.stringify(arg)}`)
}

/** Resolves a command name the way a shell would (PATH + PATHEXT), plus any known install locations. */
export function resolveBinary(name: string, extraCandidates: string[] = []) {
  const isFile = (file: string) => { try { return existsSync(file) && statSync(file).isFile() } catch { return false } }
  for (const candidate of extraCandidates) if (candidate && isAbsolute(candidate) && isFile(candidate)) return candidate
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ...(process.env.PATHEXT ?? '').toLowerCase().split(';').filter(Boolean)] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of new Set(extensions)) {
      const file = join(dir, name + ext)
      if (isFile(file)) return file
    }
  }
  return undefined
}

/**
 * Runs a provider CLI. Prompts are always delivered on stdin so user text never reaches a command line;
 * arguments are restricted to a conservative character set so Windows .cmd shims can be invoked safely.
 */
export function runCommand(binary: string, options: RunOptions): Promise<RunResult> {
  assertSafeArgs(options.args)
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('Cancelled.'))
    const shim = process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(binary).toLowerCase())
    if (shim && /["%^&|<>]/.test(binary)) return reject(new Error('Unsupported characters in CLI path.'))
    const child = shim
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[`"${binary}"`, ...options.args].join(' ')}"`], { cwd: options.cwd, windowsVerbatimArguments: true, windowsHide: true })
      : spawn(binary, options.args, { cwd: options.cwd, windowsHide: true })
    let stdout = '', stderr = '', settled = false
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve({ code, stdout, stderr })
    }
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGTERM')
    }
    const abort = () => { kill(); finish(new Error('Cancelled.')) }
    const timer = setTimeout(() => { kill(); finish(new Error(`Timed out after ${Math.round(options.timeoutMs / 1000)}s.`)) }, options.timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (stdout.length < maxCapture) stdout += chunk; options.onOutput?.(chunk) })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { if (stderr.length < maxCapture) stderr += chunk; options.onOutput?.(chunk) })
    child.on('error', error => finish(error))
    child.on('close', code => finish(undefined, code))
    child.stdin.on('error', () => { /* process may exit before reading stdin; reported via exit code */ })
    child.stdin.end(options.stdin, 'utf8')
  })
}
