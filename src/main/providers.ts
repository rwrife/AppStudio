import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveBinary, runCommand } from './process'
import { findServer, localAgent, localAsk, localInstallHint, localPresets } from './local'
import type { ProviderId, ProviderInfo, ProviderSettings } from '../shared/types'

interface ProviderDef {
  id: ProviderId
  label: string
  subscription: string
  binaryName: string
  knownPaths: () => string[]
  installHint: string
  loginHint: string
  suggestedModels: string[]
  /** Read-only question answering: no tools, no file edits. */
  askArgs: (model: string) => string[]
  /** Autonomous build: may edit files and run commands inside the output folder. */
  agentArgs: (model: string) => string[]
}

const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')

export const providerDefs: Record<ProviderId, ProviderDef> = {
  copilot: {
    id: 'copilot', label: 'GitHub Copilot', subscription: 'GitHub Copilot subscription via Copilot CLI', binaryName: 'copilot',
    knownPaths: () => [join(local, 'GitHubCopilotCLI', 'copilot.exe'), join(roaming, 'npm', 'copilot.cmd')],
    installHint: 'Install GitHub Copilot CLI (winget install GitHub.Copilot or npm install -g @github/copilot).',
    loginHint: 'Run "copilot login" once in a terminal to sign in with your GitHub account.',
    suggestedModels: ['auto', 'claude-sonnet-5.5', 'gpt-6.1-sol', 'claude-haiku-4.5'],
    askArgs: model => ['-s', ...(model ? ['--model', model] : [])],
    agentArgs: model => ['-s', '--allow-all-tools', '--trust-folder', ...(model ? ['--model', model] : [])]
  },
  codex: {
    id: 'codex', label: 'OpenAI Codex', subscription: 'ChatGPT Plus/Pro/Team subscription via Codex CLI', binaryName: 'codex',
    knownPaths: () => [join(roaming, 'npm', 'codex.cmd'), join(homedir(), '.local', 'bin', 'codex.exe')],
    installHint: 'Install the Codex CLI (npm install -g @openai/codex).',
    loginHint: 'Run "codex login" and choose "Sign in with ChatGPT" to use your subscription.',
    suggestedModels: ['gpt-5.3-codex', 'gpt-5.6-sol'],
    askArgs: model => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', ...(model ? ['-m', model] : []), '-'],
    agentArgs: model => ['exec', '--skip-git-repo-check', '--full-auto', ...(model ? ['-m', model] : []), '-']
  },
  claude: {
    id: 'claude', label: 'Claude', subscription: 'Claude Pro/Max subscription via Claude Code', binaryName: 'claude',
    knownPaths: () => [join(homedir(), '.local', 'bin', 'claude.exe'), join(roaming, 'npm', 'claude.cmd')],
    installHint: 'Install Claude Code (irm https://claude.ai/install.ps1 | iex, or npm install -g @anthropic-ai/claude-code).',
    loginHint: 'Run "claude" once and use /login to sign in with your Claude subscription.',
    suggestedModels: ['sonnet', 'opus', 'haiku'],
    askArgs: model => ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])],
    agentArgs: model => ['-p', '--output-format', 'text', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep', ...(model ? ['--model', model] : [])]
  },
  local: {
    id: 'local', label: 'Local models', subscription: 'Your own models via LM Studio, Ollama, llama.cpp or vLLM', binaryName: '',
    knownPaths: () => [], installHint: localInstallHint, loginHint: '', suggestedModels: [],
    askArgs: () => [], agentArgs: () => []
  }
}

export function binaryFor(id: ProviderId, settings: ProviderSettings) {
  const def = providerDefs[id]
  if (id === 'local') return ''
  return resolveBinary(def.binaryName, [settings.binaryPaths[id] ?? '', ...def.knownPaths()])
}

export async function detectProviders(settings: ProviderSettings): Promise<ProviderInfo[]> {
  return Promise.all(Object.values(providerDefs).map(async def => {
    const base = { id: def.id, label: def.label, subscription: def.subscription, installHint: def.installHint, loginHint: def.loginHint, suggestedModels: def.suggestedModels }
    if (def.id === 'local') {
      const server = await findServer(settings)
      if (!server) return { ...base, binary: '', installed: false, detail: settings.localEndpoint ? `Nothing answered at ${settings.localEndpoint}.` : `Checked ${localPresets.map(item => `${item.name} (${new URL(item.url).port})`).join(', ')}.` }
      return { ...base, binary: '', installed: true, version: `${server.name} · ${server.models.length} model${server.models.length === 1 ? '' : 's'}`, endpoint: server.endpoint, serverModels: server.models,
        detail: server.models.length ? `${server.name} is serving at ${server.endpoint}.` : `${server.name} is running at ${server.endpoint} but has no models loaded.` }
    }
    const binary = binaryFor(def.id, settings)
    if (!binary) return { ...base, binary: '', installed: false, detail: `"${def.binaryName}" was not found on PATH.` }
    try {
      const result = await runCommand(binary, { cwd: homedir(), args: ['--version'], stdin: '', timeoutMs: 20_000 })
      const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.slice(0, 80)
      return { ...base, binary, installed: result.code === 0, version, detail: result.code === 0 ? `Found at ${binary}` : `Found at ${binary} but "--version" failed.` }
    } catch (error) {
      return { ...base, binary, installed: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }))
}

export interface ProviderCall { settings: ProviderSettings; prompt: string; cwd: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (chunk: string) => void }

function selection(settings: ProviderSettings) {
  const id = settings.provider
  const binary = binaryFor(id, settings)
  if (!binary) throw new Error(`${providerDefs[id].label} CLI is not installed. ${providerDefs[id].installHint}`)
  return { id, binary, model: settings.selectedModel[id] ?? '' }
}

function failure(id: ProviderId, code: number | null, output: string) {
  const tail = output.trim().split(/\r?\n/).slice(-6).join('\n')
  const auth = /log ?in|auth|unauthori[sz]ed|credential|sign in/i.test(tail) ? `\n${providerDefs[id].loginHint}` : ''
  return new Error(`${providerDefs[id].label} exited with code ${code}.\n${tail}${auth}`)
}

/** Single-shot, read-only completion used for interview questions, branch ideas and acceptance criteria. */
export async function ask(call: ProviderCall) {
  if (call.settings.provider === 'local') return localAsk(call.settings, call.prompt, call.timeoutMs, call.signal)
  const { id, binary, model } = selection(call.settings)
  const result = await runCommand(binary, { cwd: call.cwd, args: providerDefs[id].askArgs(model), stdin: call.prompt, timeoutMs: call.timeoutMs, signal: call.signal })
  if (result.code !== 0) throw failure(id, result.code, result.stderr || result.stdout)
  return result.stdout
}

/** Autonomous agent run that edits files inside cwd. */
export async function runAgent(call: ProviderCall & { taskId: string }) {
  if (call.settings.provider === 'local') return localAgent(call.settings, call.prompt, call.cwd, call.timeoutMs, call.signal, call.onOutput)
  const { id, binary, model } = selection(call.settings)
  const result = await runCommand(binary, { cwd: call.cwd, args: providerDefs[id].agentArgs(model), stdin: call.prompt, timeoutMs: call.timeoutMs, signal: call.signal, onOutput: call.onOutput })
  if (result.code !== 0) throw failure(id, result.code, result.stderr || result.stdout)
  return result.stdout
}
