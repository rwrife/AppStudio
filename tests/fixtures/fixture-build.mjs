import { existsSync, writeFileSync } from 'node:fs'
console.log('Compiling the fixture application')
await new Promise(resolve => setTimeout(resolve, 400))
if (existsSync('build-failure')) {
  console.error('Fixture compiler error')
  process.exitCode = 7
} else {
  writeFileSync('compiled.txt', 'Built by a real project process')
  console.log('Compiled fixture application')
}
