#!/usr/bin/env node
// Zero-dependency static server for the built Vite app (dist/), with SPA
// fallback. Port via `--port <n>` or PORT env, else the default below.
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'

const DEFAULT_PORT = 4173
const LABEL = '@av-controls/controller'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

function resolvePort() {
  const i = process.argv.indexOf('--port')
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1])
    if (Number.isFinite(n)) return n
  }
  const env = Number(process.env.PORT)
  return Number.isFinite(env) ? env : DEFAULT_PORT
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.map': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

const handler = async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost')
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
    if (rel.includes('..')) { res.writeHead(403); res.end('forbidden'); return }
    let filePath = join(root, rel)
    let s = await stat(filePath).catch(() => null)
    if (s?.isDirectory()) { filePath = join(filePath, 'index.html'); s = await stat(filePath).catch(() => null) }
    if (!s) { filePath = join(root, 'index.html') } // SPA fallback
    const body = await readFile(filePath)
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream' })
    res.end(body)
  } catch (err) {
    res.writeHead(500)
    res.end(String(err))
  }
}

// HTTPS when CERT_FILE + KEY_FILE are set (exhibit — a password page over plain
// http is meaningless). Plain http otherwise (dev). The same cert must be used
// by the av-controls broker so the page can open wss:// without mixed-content.
const certFile = process.env.CERT_FILE
const keyFile = process.env.KEY_FILE
const useHttps = Boolean(certFile && keyFile)
const server = useHttps
  ? createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, handler)
  : createHttpServer(handler)

server.listen(resolvePort(), () => {
  const scheme = useHttps ? 'https' : 'http'
  console.log(`[${LABEL}] serving ${root} on ${scheme}://localhost:${server.address().port}`)
})
