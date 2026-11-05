import { createServer } from 'node:http'
const port = Number(process.argv[2])
createServer((_request, response) => {
  response.setHeader('content-type', 'text/html')
  response.end('<!doctype html><title>Managed fixture app</title><h1>The generated app is running</h1>')
}).listen(port, '127.0.0.1', () => console.log(`Fixture app listening at http://127.0.0.1:${port}/`))
