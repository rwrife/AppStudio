import { existsSync } from 'node:fs'
if (process.argv.includes('--version')) {
  console.log('Mock project CLI 1.0')
} else {
  let prompt = ''
  for await (const chunk of process.stdin) prompt += chunk
  if (existsSync('agent-failure')) console.log(JSON.stringify({ error: 'Project agent could not determine a launch command.' }))
  else if (existsSync('agent-malformed')) console.log('No valid plan.')
  else if (prompt.includes('application build agent')) console.log(JSON.stringify({ commands: [{ binary: 'node', args: ['fixture-build.mjs'] }] }))
  else {
    const port = prompt.match(/on port (\d+)/)?.[1]
    if (!port) throw new Error('No assigned preview port in prompt.')
    console.log(JSON.stringify({ commands: [{ binary: 'node', args: ['fixture-launch.mjs', port] }], url: `http://127.0.0.1:${port}/` }))
  }
}
