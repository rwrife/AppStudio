import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['fixture-server.mjs', process.argv[2]], { stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
