// Minimal OpenAI-compatible server used by tests and the smoke script in place of a real local model.
import { createServer } from 'node:http'

const questions = [
  { question: 'Who are the main users of this part of the app?', why: 'Shapes permissions and copy.' },
  { question: 'Which platforms must it support first: web, iOS or Android?', why: 'Decides the stack.' },
  { question: 'What should happen when the network is unavailable?', why: 'Defines offline behaviour.' },
  { question: 'Which third-party services are already chosen?', why: 'Avoids rework on integrations.' }
]
const branches = [
  { kind: 'screen', title: 'Booking calendar', summary: 'Clients pick an open slot and confirm a session.' },
  { kind: 'feature', title: 'Reschedule sessions', summary: 'Clients move a booking within the cancellation window.' },
  { kind: 'data', title: 'Sessions and clients', summary: 'Stores trainers, clients and booked sessions.' },
  { kind: 'integration', title: 'Card payments', summary: 'Takes payment when a session is booked.' },
  { kind: 'rule', title: '24h cancellation', summary: 'Cancellations inside 24 hours are charged.' }
]
const criteria = ['A client can see available slots for the next two weeks.', 'Booking a slot removes it from the calendar for others.', 'Errors are shown inline with a retry action.']

const reply = message => ({ id: 'mock', object: 'chat.completion', choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: null, ...message } }] })
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

/**
 * @param {{ rejectTools?: boolean, thinking?: boolean }} [options]
 * rejectTools: answer 400 when a request includes `tools`, forcing the file-block fallback.
 * thinking: wrap answers with a <think> block like reasoning models do.
 */
export async function startMockServer(options = {}) {
  const requests = []
  let agentCount = 0
  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'mock-model' }, { id: 'mock-embed-text' }] })
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: 'not found' })
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const think = text => options.thinking ? `<think>Let me consider { the "schema" }...</think>${text}` : text
    const user = body.messages.find(item => item.role === 'user')?.content ?? ''
    const last = body.messages.at(-1)

    if (body.tools && options.rejectTools) return send(400, { error: { message: 'tools are not supported by this model' } })
    if (body.tools) {
      if (last.role === 'tool') return send(200, reply({ tool_calls: [call('c2', 'finish', { summary: 'Wrote implementation notes.' })] }))
      const name = `task-${++agentCount}`
      return send(200, reply({ tool_calls: [call('c1', 'write_file', { path: `${name}/NOTES.md`, content: `# ${name}\n\n${user.split('\n')[0]}\n` })] }))
    }
    if (body.messages[0]?.content?.includes('autonomous software engineer')) {
      const name = `block-${++agentCount}`
      return send(200, reply({ content: `Here are the files.\n\n### FILE: ${name}/index.ts\n\`\`\`ts\nexport const ok = true\n\`\`\`\n` }))
    }
    if (user.includes('"questions"')) return send(200, reply({ content: think(JSON.stringify({ questions })) }))
    if (user.includes('"branches"')) return send(200, reply({ content: think('```json\n' + JSON.stringify({ branches }) + '\n```') }))
    if (user.includes('"criteria"')) return send(200, reply({ content: think(JSON.stringify({ criteria })) }))
    if (user.includes('READY')) return send(200, reply({ content: think('READY') }))
    return send(200, reply({ content: 'I am not sure what you want.' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
