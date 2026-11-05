// Static file server for the M0 page: no build step, no dependencies. Loopback only.
//   node serve.mjs            -> http://127.0.0.1:5180/
//   PORT=5190 node serve.mjs
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.PORT || 5180)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  const file = normalize(join(ROOT, path === '/' ? 'index.html' : path))
  // Serve only files inside this folder.
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file')
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(await readFile(file))
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  }
}).listen(PORT, '127.0.0.1', () => console.log(`M0 page: http://127.0.0.1:${PORT}/`))
