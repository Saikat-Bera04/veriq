// S4 probe: run the Helios browser build with every Helios request sent through Nox.
//
// Helios (wasm-bindgen) calls the global `fetch` for each request. It is given placeholder URLs on
// the reserved `.invalid` TLD, and a fetch wrapper turns only those into real requests through
// the Nox worker. Any other URL passes through untouched. If the wrapper were missing, Helios
// requests would fail to resolve: they can never silently go direct.
//
// Public, keyless endpoints only. No account addresses.
import { AnonRpcWorker } from '@anon-rpc/browser-harness'

const NOX_SEPOLIA = '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A'
const PUBLIC_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const params = new URLSearchParams(location.search)
const safeOrigin = (value, fallback) => (value && /^https:\/\/[A-Za-z0-9.-]+$/.test(value) ? value : fallback)
const BEACON = safeOrigin(params.get('beacon'), 'https://lodestar-sepolia.chainsafe.io')
const CHECKPOINT = params.get('checkpoint') ?? ''
const RECORD = params.get('record') === '1'

const ROUTES = {
  'consensus.helios.invalid': BEACON,
  'execution.helios.invalid': PUBLIC_RPC,
}

const logEl = document.getElementById('log')
const t0 = performance.now()
const now = () => Math.round(performance.now() - t0)
const state = { worker: 'idle', workerMs: null, helios: 'idle', syncMs: null, finalized: null, error: null, requests: [], recorded: [], done: false }
window.__s4 = state
const log = (...parts) => {
  logEl.textContent += `${String(now()).padStart(6)} ms  ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`
}
const set = (key, value) => {
  state[key] = value
  document.getElementById(key).textContent = value
  log(`${key}: ${value}`)
}

const rpcProvider = {
  async request({ method, params: p }) {
    const res = await fetch(PUBLIC_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: p ?? [] }),
    })
    const body = await res.json()
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code })
    return body.result
  },
}

set('worker', 'connecting')
const worker = new AnonRpcWorker({ address: NOX_SEPOLIA, preExisting: { rpcProvider } })

const directFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init)
  const url = new URL(request.url)
  const base = ROUTES[url.hostname]
  if (!base) return directFetch(input, init)
  const target = `${base}${url.pathname}${url.search}`
  const method = request.method
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text()
  const headers = {}
  request.headers.forEach((v, k) => { headers[k] = v })
  const started = now()
  const entry = { host: url.hostname.split('.')[0], method, path: url.pathname + url.search.slice(0, 40), started }
  state.requests.push(entry)
  try {
    const res = await worker.fetch(target, { method, headers, body })
    const text = await res.text()
    Object.assign(entry, { status: res.status, ms: now() - started, bytes: text.length })
    if (RECORD) state.recorded.push({ host: entry.host, method, path: url.pathname + url.search, body, status: res.status, response: text })
    const out = new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
    // reqwest (wasm) parses response.url and panics on the empty URL of a constructed Response.
    Object.defineProperty(out, 'url', { value: request.url })
    return out
  } catch (err) {
    Object.assign(entry, { error: String(err?.message ?? err).slice(0, 200), ms: now() - started })
    throw err
  }
}

try {
  await worker.ready
  state.workerMs = now()
  set('worker', 'ready')
  if (!/^0x[0-9a-fA-F]{64}$/.test(CHECKPOINT)) throw new Error('?checkpoint=0x… (32-byte beacon block root) is required')
  set('helios', 'loading')
  const loadStart = now()
  const { createHeliosProvider } = await import('@a16z/helios')
  state.loadMs = now() - loadStart
  set('helios', 'syncing')
  const syncStart = now()
  const helios = await createHeliosProvider(
    {
      consensusRpc: 'https://consensus.helios.invalid',
      executionRpc: 'https://execution.helios.invalid',
      network: 'sepolia',
      checkpoint: CHECKPOINT,
      dbType: 'config',
    },
    'ethereum',
  )
  await helios.waitSynced()
  state.syncMs = now() - syncStart
  set('helios', 'synced')
  const blockStart = now()
  const block = await helios.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })
  state.blockMs = now() - blockStart
  state.finalized = { number: Number(block.number), hash: block.hash, stateRoot: block.stateRoot, timestamp: Number(block.timestamp) }
  log('finalized', state.finalized)
} catch (err) {
  state.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`
  set('helios', `failed — ${state.error}`)
}
state.done = true
log('requests', state.requests.map(({ host, path, status, ms, error }) => ({ host, path, status, ms, error })))
