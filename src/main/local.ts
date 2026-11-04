import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ProviderSettings } from '../shared/types'

/** Common OpenAI-compatible servers, probed in order when no endpoint is configured. */
export const localPresets = [
  { name: 'LM Studio', url: 'http://127.0.0.1:1234/v1', hint: 'lms server start' },
  { name: 'Ollama', url: 'http://127.0.0.1:11434/v1', hint: 'ollama serve' },
  { name: 'vLLM', url: 'http://127.0.0.1:8000/v1', hint: 'vllm serve <model> (Linux or WSL)' },
  { name: 'llama.cpp', url: 'http://127.0.0.1:8080/v1', hint: 'llama-server -m <model.gguf>' }
] as const

export const localInstallHint = 'Start a local OpenAI-compatible server: LM Studio (lms server start), Ollama (ollama serve), llama.cpp (llama-server) or vLLM in WSL/Linux (vllm serve). Then click Re-detect.'

const trimUrl = (url: string) => url.replace(/\/+$/, '')

interface ServerInfo { endpoint: string; name: string; models: string[] }

async function listModels(endpoint: string, timeoutMs: number, signal?: AbortSignal) {
  const response = await fetch(`${trimUrl(endpoint)}/models`, { signal: anySignal(timeoutMs, signal) })
  if (!response.ok) throw new Error(`${endpoint} answered ${response.status}`)
  const body = await response.json() as { data?: { id?: unknown }[] }
  return (body.data ?? []).map(item => String(item.id ?? '')).filter(id => id && !/embed/i.test(id))
}

/** Finds a reachable server: the configured endpoint, or the first preset that answers. */
export async function findServer(settings: ProviderSettings, timeoutMs = 1500): Promise<ServerInfo | undefined> {
  const candidates = settings.localEndpoint ? [{ name: 'Custom server', url: settings.localEndpoint }] : localPresets
  const results = await Promise.all(candidates.map(async item => {
    try { return { endpoint: trimUrl(item.url), name: item.name, models: await listModels(item.url, timeoutMs) } } catch { return undefined }
  }))
  return results.find(Boolean)
}

async function requireServer(settings: ProviderSettings, signal?: AbortSignal) {
  const server = await findServer(settings, 4000)
  if (signal?.aborted) throw new Error('Cancelled.')
  if (!server) throw new Error(settings.localEndpoint ? `No OpenAI-compatible server answered at ${settings.localEndpoint}. Check it is running, then try again.` : `No local model server found. ${localInstallHint}`)
  const model = settings.selectedModel.local || server.models[0]
  if (!model) throw new Error(`${server.name} at ${server.endpoint} has no models loaded. Download or load a model, then try again.`)
  return { ...server, model }
}

function anySignal(timeoutMs: number, signal?: AbortSignal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
}

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

async function chat(endpoint: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
  let response: Response
  try {
    response = await fetch(`${endpoint}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: false, ...body }), signal: anySignal(timeoutMs, signal) })
  } catch (error) {
    if (signal?.aborted) throw new Error('Cancelled.')
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`Local model did not answer within ${Math.round(timeoutMs / 1000)}s.`)
    throw new Error(`Could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`Local model server answered ${response.status}: ${text.slice(0, 400)}`)
  const message = (JSON.parse(text) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] }).choices?.[0]?.message
  if (!message) throw new Error('Local model server returned no choices.')
  return { content: stripThinking(message.content ?? ''), toolCalls: message.tool_calls ?? [] }
}

/** Reasoning models often emit <think> blocks that can contain stray braces. */
export const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim()

export async function localAsk(settings: ProviderSettings, prompt: string, timeoutMs: number, signal?: AbortSignal) {
  const server = await requireServer(settings, signal)
  const result = await chat(server.endpoint, {
    model: server.model, temperature: 0.2,
    messages: [{ role: 'system', content: 'You are a precise product analyst. Follow the output format exactly.' }, { role: 'user', content: prompt }]
  }, timeoutMs, signal)
  return result.content
}

const tools = [
  { type: 'function', function: { name: 'list_files', description: 'List files and folders under a directory of the project (relative path, "." for the root).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file from the project (relative path).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a UTF-8 text file in the project (relative path). Parent folders are created.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'finish', description: 'Call once the task is complete, with a short summary of what you built.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } }
]

const agentSystem = [
  'You are an autonomous software engineer working inside a project folder.',
  'You can only use the tools list_files, read_file, write_file and finish. You cannot run shell commands, install packages or run tests, so write complete files and document any commands a human must run in README.md.',
  'All paths are relative to the project root. Write real, working code, not placeholders. Call finish when done.',
  'If you cannot call tools, reply with each file as a heading line "### FILE: relative/path" followed by a fenced code block containing the full file.'
].join('\n')

const maxSteps = 40
const maxFileBytes = 400_000
const maxRead = 24_000

/** Resolves a model-supplied path inside root and rejects traversal, absolute paths and symlink escapes. */
export async function safePath(root: string, input: unknown) {
  const raw = String(input ?? '').trim().replace(/\\/g, '/')
  if (!raw || raw.includes('\0') || isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new Error(`Path "${raw}" must be relative to the project root.`)
  const target = resolve(root, raw)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path "${raw}" is outside the project.`)
  if (rel.split(sep).some(part => part === '.git' || part === '.app-studio')) throw new Error(`Path "${raw}" is reserved.`)
  // Walk up to the nearest existing ancestor and make sure symlinks don't lead out of the project.
  const realRoot = await realpath(root)
  let probe = target
  for (;;) {
    try { await lstat(probe); break } catch { const parent = dirname(probe); if (parent === probe) break; probe = parent }
  }
  const realProbe = await realpath(probe)
  const realRel = relative(realRoot, realProbe)
  if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error(`Path "${raw}" resolves outside the project.`)
  return { path: target, rel: rel.split(sep).join('/') || '.' }
}

async function runTool(root: string, call: ToolCall, written: Set<string>) {
  let args: Record<string, unknown>
  try { args = JSON.parse(call.function.arguments || '{}') } catch { return 'Error: arguments were not valid JSON.' }
  try {
    switch (call.function.name) {
      case 'list_files': {
        const { path, rel } = await safePath(root, args.path || '.')
        const entries = await readdir(path, { withFileTypes: true })
        return entries.filter(entry => entry.name !== '.git' && entry.name !== 'node_modules').slice(0, 300).map(entry => `${rel === '.' ? '' : `${rel}/`}${entry.name}${entry.isDirectory() ? '/' : ''}`).join('\n') || '(empty)'
      }
      case 'read_file': {
        const { path } = await safePath(root, args.path)
        const content = await readFile(path, 'utf8')
        return content.length > maxRead ? `${content.slice(0, maxRead)}\n…(truncated, ${content.length} chars total)` : content
      }
      case 'write_file': {
        const content = String(args.content ?? '')
        if (Buffer.byteLength(content) > maxFileBytes) return `Error: file is larger than ${maxFileBytes} bytes.`
        const { path, rel } = await safePath(root, args.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
        written.add(rel)
        return `Wrote ${rel} (${content.length} chars).`
      }
      case 'finish': return 'Finished.'
      default: return `Error: unknown tool "${call.function.name}".`
    }
  } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}` }
}

/** Fallback for models without tool calling: "### FILE: path" followed by a fenced block. */
export function parseFileBlocks(text: string) {
  const files: { path: string; content: string }[] = []
  const pattern = /^#{2,4}\s*FILE:\s*`?([^\n`]+?)`?\s*\n```[^\n]*\n([\s\S]*?)\n```/gim
  for (const match of text.matchAll(pattern)) files.push({ path: match[1].trim(), content: `${match[2]}\n` })
  return files
}

export async function localAgent(settings: ProviderSettings, prompt: string, cwd: string, timeoutMs: number, signal?: AbortSignal, onOutput?: (chunk: string) => void) {
  const server = await requireServer(settings, signal)
  onOutput?.(`[local] ${server.name} · ${server.model}\n`)
  const deadline = Date.now() + timeoutMs
  const messages: Message[] = [{ role: 'system', content: agentSystem }, { role: 'user', content: prompt }]
  const written = new Set<string>()
  let toolsSupported = true
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw new Error('Cancelled.')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Local agent ran out of time.')
    let reply: Awaited<ReturnType<typeof chat>>
    try {
      reply = await chat(server.endpoint, { model: server.model, temperature: 0.2, messages, ...(toolsSupported ? { tools, tool_choice: 'auto' } : {}) }, remaining, signal)
    } catch (error) {
      // Some servers reject the tools parameter outright; fall back to file blocks.
      if (toolsSupported && step === 0 && /\b(400|422)\b/.test(String(error))) { toolsSupported = false; onOutput?.('[local] Server rejected tool calling; using file-block mode.\n'); step--; continue }
      throw error
    }
    if (reply.content) onOutput?.(`${reply.content.slice(0, 2000)}\n`)
    if (!reply.toolCalls.length) {
      for (const file of parseFileBlocks(reply.content)) {
        onOutput?.(`[local] ${await runTool(cwd, { id: 'block', type: 'function', function: { name: 'write_file', arguments: JSON.stringify(file) } }, written)}\n`)
      }
      if (!written.size) throw new Error('The local model replied without writing any files. Try a model that supports tool calling (for example Qwen3, Llama 3.1+ or Gemma 4).')
      return reply.content || `Wrote ${written.size} files.`
    }
    messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls })
    let finished: string | undefined
    for (const call of reply.toolCalls) {
      const result = await runTool(cwd, call, written)
      onOutput?.(`[tool] ${call.function.name}(${describeArgs(call)}) → ${result.split('\n')[0].slice(0, 160)}\n`)
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      if (call.function.name === 'finish') finished = String(safeJson(call.function.arguments).summary ?? 'Done.')
    }
    if (finished !== undefined) {
      if (!written.size) throw new Error('The local model called finish without writing any files.')
      return finished
    }
  }
  throw new Error(`Local agent stopped after ${maxSteps} steps without calling finish (${written.size} files written).`)
}

const safeJson = (text: string): Record<string, unknown> => { try { return JSON.parse(text) } catch { return {} } }
const describeArgs = (call: ToolCall) => { const args = safeJson(call.function.arguments); return typeof args.path === 'string' ? args.path : '' }
