// M0 feasibility page (skeleton, M0.0). Starts one Nox worker and reports its state.
// Probe bodies are filled in by M0.1-M0.4; until then each button logs "not implemented".
//
// Privacy rules for this page: public, keyless endpoints only; no API keys, no wallet or account
// addresses, nothing from .env. The worker's own log lines (node ids, timings) are shown as-is.
import { AnonRpcWorker } from '@anon-rpc/browser-harness'

/** Nox specifier on Sepolia (https://ethereum.github.io/anon-rpc/adopters/). */
export const NOX_SEPOLIA = '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A'
/** Keyless Sepolia RPC. Also the bootstrap provider for reading the specifier (direct, once). */
export const PUBLIC_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
/** Keyless Sepolia beacon API (the HELIOS_CONSENSUS_RPC default in .env.example). */
export const BEACON_API = 'https://unstable.sepolia.beacon-api.nimbus.team'

const logEl = document.getElementById('log')
const statusEl = document.getElementById('status')
const detailEl = document.getElementById('status-detail')
const t0 = performance.now()

/** Machine-readable state for the browser smoke (window.__m0). */
const state = { worker: 'idle', readyMs: null, error: null, probes: {}, done: false }
window.__m0 = state

export function log(...parts) {
  const ms = String(Math.round(performance.now() - t0)).padStart(6, ' ')
  logEl.textContent += `${ms} ms  ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`
}

function setWorker(next, detail = '') {
  state.worker = next
  statusEl.dataset.state = next
  statusEl.textContent = next
  detailEl.textContent = detail
  log(`worker: ${next}${detail ? ` (${detail})` : ''}`)
}

// Bootstrap provider: used once, directly (not anonymized), to read the specifier contract.
const rpcProvider = {
  async request({ method, params }) {
    const res = await fetch(PUBLIC_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
    })
    const body = await res.json()
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code })
    return body.result
  },
}

// `?fail=1` points the worker at an address with no specifier contract, to check the failed state.
const FORCE_FAIL = new URLSearchParams(location.search).get('fail') === '1'
const SPECIFIER = FORCE_FAIL ? '0x000000000000000000000000000000000000dEaD' : NOX_SEPOLIA

// One worker per page (the dashboard will hold it as a singleton).
setWorker('connecting', FORCE_FAIL ? 'forced failure test (?fail=1)' : 'joining the Nox mixnet')
export const worker = new AnonRpcWorker({ address: SPECIFIER, preExisting: { rpcProvider } })

worker.ready.then(
  () => {
    state.readyMs = Math.round(performance.now() - t0)
    setWorker('ready', `${state.readyMs} ms after page load`)
  },
  (err) => {
    state.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`
    setWorker('failed', state.error)
  },
)

// Forward the worker's own log lines (info and above) so failures explain themselves.
;(async () => {
  for (;;) {
    try {
      const { level, args } = await worker.acceptLog()
      if (level === 'debug') continue
      log(`[nox ${level}]`, ...args)
    } catch {
      return // worker closed or failed, and its log is drained
    }
  }
})()

// ------------------------------------------------------------------------------- probes
//
// M0.1 and M0.2 are real now. Everything goes through `worker.fetch` (Nox), except the
// specifier read in the harness bootstrap above, which happens once and directly.

/** All-zero address: not a real account, so the page never logs a user address. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const textEncoder = new TextEncoder()

/** Only the headers a feasibility report needs; never cookies or auth headers. */
function responseHeaders(res) {
  const out = {}
  for (const name of [
    'content-type',
    'content-length',
    'content-encoding',
    'cache-control',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'vary',
  ]) {
    const value = res.headers.get(name)
    if (value !== null) out[name] = value
  }
  return out
}

/** One request through Nox. The body is returned as text and never logged whole. */
async function throughNox(url, init = {}) {
  const started = performance.now()
  try {
    const res = await worker.fetch(url, init)
    const text = await res.text()
    return {
      ok: res.ok,
      status: res.status,
      ms: Math.round(performance.now() - started),
      headers: responseHeaders(res),
      bytes: textEncoder.encode(text).byteLength,
      text,
      error: null,
    }
  } catch (err) {
    return {
      ok: false,
      status: null,
      ms: Math.round(performance.now() - started),
      headers: {},
      bytes: 0,
      text: '',
      error: `${err?.name ?? 'Error'}: ${err?.message ?? err}`,
    }
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The fields of a Response that go into `window.__m0` (never the body). */
function summaryOf(run) {
  return {
    ok: run.ok,
    status: run.status,
    ms: run.ms,
    bytes: run.bytes,
    headers: run.headers,
    error: run.error,
  }
}

function proofShape(result) {
  if (!result || typeof result !== 'object') return null
  return {
    keys: Object.keys(result).sort(),
    accountProof: Array.isArray(result.accountProof) ? result.accountProof.length : null,
    storageProof: Array.isArray(result.storageProof) ? result.storageProof.length : null,
    balance: result.balance,
    nonce: result.nonce,
    storageHash: result.storageHash,
    codeHash: result.codeHash,
  }
}

/** One JSON-RPC call through Nox; `value`/`error` come from the JSON-RPC envelope. */
async function rpcThroughNox(url, method, params) {
  const run = await throughNox(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = parseJson(run.text)
  const value = body && typeof body === 'object' ? body.result : undefined
  const rpcError = body && typeof body === 'object' ? body.error : null
  return { run, body, value, rpcError }
}

function rpcSummary(call, pick = () => null) {
  return {
    ...summaryOf(call.run),
    rpcError: call.rpcError,
    result: call.rpcError ? null : pick(call.value),
  }
}

/** Compact per-attempt record for a retried proof call (never the proof bytes). */
function attemptSummary(call) {
  const accountProof = Array.isArray(call.value?.accountProof) ? call.value.accountProof.length : null
  return {
    ok: call.run.ok && !call.rpcError && accountProof != null,
    ms: call.run.ms,
    rpcError: call.rpcError,
    accountProof,
    storageProof: Array.isArray(call.value?.storageProof) ? call.value.storageProof.length : null,
  }
}

/**
 * PublicNode is a load-balanced pool whose backends keep different proof windows, so the
 * same finalized proof can fail on one request and answer on the next. Retry a few times
 * and record every attempt, instead of calling the transport broken after one `-32602`.
 */
async function proofWithRetry(url, params, attempts = 4) {
  const tries = []
  let last
  for (let i = 0; i < attempts; i++) {
    last = await rpcThroughNox(url, 'eth_getProof', params)
    tries.push({ attempt: i + 1, ...attemptSummary(last) })
    if (tries[tries.length - 1].ok && tries[tries.length - 1].accountProof != null) break
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const okAny = tries.some((t) => t.ok && t.accountProof != null)
  return {
    ...rpcSummary(last, proofShape),
    okAny,
    attempts: tries.length,
    tries,
  }
}

// ------------------------------------------------------------------------------- M0.1

/** Beacon endpoints Helios actually calls (backend/.../helios http_rpc.rs). */
const BEACON_TARGETS = [
  {
    id: 'headers/head',
    path: '/eth/v1/beacon/headers/head',
    pick: (body) => ({ slot: body?.data?.header?.message?.slot }),
  },
  {
    id: 'finality_update',
    path: '/eth/v1/beacon/light_client/finality_update',
    pick: (body) => ({
      finalizedSlot: body?.data?.finalized_header?.beacon?.slot,
      signatureSlot: body?.data?.signature_slot,
    }),
  },
  {
    id: 'optimistic_update',
    path: '/eth/v1/beacon/light_client/optimistic_update',
    pick: (body) => ({ signatureSlot: body?.data?.signature_slot }),
  },
  {
    id: 'config/spec',
    path: '/eth/v1/config/spec',
    pick: (body) => ({
      networkId: body?.data?.DEPOSIT_NETWORK_ID,
      configName: body?.data?.CONFIG_NAME,
    }),
  },
]

async function probeM01() {
  const checks = {}
  const bodies = {}

  for (const target of BEACON_TARGETS) {
    const url = `${BEACON_API}${target.path}`
    const cold = await throughNox(url)
    const warm = await throughNox(url)
    bodies[target.id] = parseJson(cold.text)
    checks[target.id] = {
      path: target.path,
      coldMs: cold.ms,
      warmMs: warm.ms,
      ...summaryOf(cold),
      warmOk: warm.ok,
      warmStatus: warm.status,
      warmError: warm.error,
      parsed: bodies[target.id] ? target.pick(bodies[target.id]) : null,
    }
  }

  // Bootstrap by the head block root, exactly the path Helios uses.
  const head = bodies['headers/head']
  const headRoot = head?.data?.root
  if (headRoot) {
    const run = await throughNox(
      `${BEACON_API}/eth/v1/beacon/light_client/bootstrap/0x${String(headRoot).replace(/^0x/, '')}`,
    )
    const body = parseJson(run.text)
    checks.bootstrap = {
      path: `/eth/v1/beacon/light_client/bootstrap/0x${String(headRoot).slice(0, 10)}…`,
      ...summaryOf(run),
      parsed: body?.data
        ? {
            headerSlot: body.data.header?.beacon?.slot,
            currentSyncCommittee: Boolean(body.data.current_sync_committee),
          }
        : null,
    }
  } else {
    checks.bootstrap = { skipped: 'no head root in headers/head' }
  }

  // Updates for the current sync committee period (Helios get_updates).
  const headSlot = Number(head?.data?.header?.message?.slot)
  if (Number.isFinite(headSlot)) {
    const period = Math.floor(headSlot / (32 * 256))
    const run = await throughNox(
      `${BEACON_API}/eth/v1/beacon/light_client/updates?start_period=${period}&count=1`,
    )
    const body = parseJson(run.text)
    checks.updates = {
      path: `/eth/v1/beacon/light_client/updates?start_period=${period}&count=1`,
      ...summaryOf(run),
      parsed: Array.isArray(body)
        ? { count: body.length, firstFinalizedSlot: body[0]?.data?.finalized_header?.beacon?.slot }
        : null,
    }
  } else {
    checks.updates = { skipped: 'no head slot' }
  }

  // CORS: an explicit OPTIONS, and a GET with a custom header (forces a preflight).
  const preflight = await throughNox(`${BEACON_API}/eth/v1/beacon/headers/head`, {
    method: 'OPTIONS',
    headers: {
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-m0-probe',
    },
  })
  checks.preflight = { method: 'OPTIONS', ...summaryOf(preflight) }

  const forced = await throughNox(`${BEACON_API}/eth/v1/beacon/headers/head`, {
    headers: { 'x-m0-probe': '1' },
  })
  checks.preflightGet = { method: 'GET + x-m0-probe', ...summaryOf(forced) }

  const headOk = checks['headers/head'].ok && checks['headers/head'].parsed?.slot != null
  const heliosOk =
    checks.finality_update.ok &&
    checks['config/spec']?.ok !== false &&
    checks.bootstrap.ok !== false &&
    checks.updates.ok !== false
  return {
    status: headOk ? (heliosOk ? 'pass' : 'partial') : 'fail',
    endpoint: BEACON_API,
    at: new Date().toISOString(),
    userAgent: navigator.userAgent,
    checks,
  }
}

// ------------------------------------------------------------------------------- M0.2

async function probeM02() {
  const checks = {}

  const chain = await rpcThroughNox(PUBLIC_RPC, 'eth_chainId', [])
  checks.eth_chainId = rpcSummary(chain, (value) => ({ chainId: value }))

  const block = await rpcThroughNox(PUBLIC_RPC, 'eth_getBlockByNumber', ['finalized', false])
  const blockValue = block.value ?? null
  checks.eth_getBlockByNumber = rpcSummary(block, (value) => ({
    number: value?.number,
    hash: value?.hash,
  }))

  checks.eth_getProof_finalized = await proofWithRetry(PUBLIC_RPC, [
    ZERO_ADDRESS,
    [],
    'finalized',
  ])

  const hash = blockValue?.hash
  const number = blockValue?.number
  checks.eth_getProof_blockHash = hash
    ? await proofWithRetry(PUBLIC_RPC, [ZERO_ADDRESS, [], { blockHash: hash }])
    : { skipped: 'no finalized block hash' }

  checks.eth_getProof_blockNumber = number
    ? await proofWithRetry(PUBLIC_RPC, [ZERO_ADDRESS, [], number])
    : { skipped: 'no finalized block number' }

  // Optional: the same probes against a hosted demo attacker (S1.1), if one is given.
  const attacker = new URLSearchParams(location.search).get('attacker')
  if (attacker) {
    const aChain = await rpcThroughNox(attacker, 'eth_chainId', [])
    const aProof = await rpcThroughNox(attacker, 'eth_getProof', [ZERO_ADDRESS, [], 'finalized'])
    checks.attacker = {
      url: attacker,
      eth_chainId: rpcSummary(aChain, (value) => ({ chainId: value })),
      eth_getProof: rpcSummary(aProof, proofShape),
    }
  }

  const chainOk = chain.value === '0xaa36a7'
  // Any of the three encodings of the same finalized block is a valid proof; PublicNode's
  // load-balanced backends sometimes reject one form and answer another on the next request.
  const proofOk =
    checks.eth_getProof_finalized.okAny === true ||
    checks.eth_getProof_blockHash?.okAny === true ||
    checks.eth_getProof_blockNumber?.okAny === true
  const exactOk =
    checks.eth_getProof_blockHash?.okAny === true ||
    checks.eth_getProof_blockNumber?.okAny === true
  const transportOk = chain.run.ok && block.run.ok
  return {
    status: chainOk && proofOk ? 'pass' : transportOk ? 'partial' : 'fail',
    endpoint: PUBLIC_RPC,
    address: ZERO_ADDRESS,
    at: new Date().toISOString(),
    userAgent: navigator.userAgent,
    chainOk,
    proofOk,
    exactBlockForm: exactOk ? 'at least one form answered' : 'neither exact-block form answered',
    checks,
  }
}

// ------------------------------------------------------------------------------- M0.3

/** Accept-Encoding cases. Browsers treat it as forbidden, so record what actually survives. */
const ENCODING_CASES = [
  { id: 'default', headers: {} },
  { id: 'identity', headers: { 'accept-encoding': 'identity' } },
  { id: 'gzip', headers: { 'accept-encoding': 'gzip' } },
]

/** One proof call with retries, recording compressed vs decoded size for each attempt. */
async function proofWithEncoding(headers, blockNumber, attempts = 4) {
  const tries = []
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getProof',
    params: [ZERO_ADDRESS, [], blockNumber],
  })
  for (let i = 0; i < attempts; i++) {
    const run = await throughNox(PUBLIC_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    })
    const parsed = parseJson(run.text)
    const rpcError = parsed && typeof parsed === 'object' ? parsed.error : null
    const accountProof = Array.isArray(parsed?.result?.accountProof)
      ? parsed.result.accountProof.length
      : null
    const contentLength = run.headers['content-length']
      ? Number(run.headers['content-length'])
      : null
    tries.push({
      attempt: i + 1,
      ok: run.ok && !rpcError && accountProof != null,
      status: run.status,
      ms: run.ms,
      error: run.error,
      rpcError,
      contentEncoding: run.headers['content-encoding'] ?? null,
      contentLength,
      decodedBytes: run.bytes,
      compressed: contentLength != null && run.bytes > contentLength ? contentLength : null,
      ratio:
        contentLength != null && contentLength > 0
          ? Number((run.bytes / contentLength).toFixed(2))
          : null,
      accountProof,
    })
    const last = tries[tries.length - 1]
    if (last.ok) break
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const final = tries[tries.length - 1]
  return {
    ok: final.ok,
    sentAcceptEncoding: headers['accept-encoding'] ?? '(browser default)',
    tries,
    final,
  }
}

async function probeM03() {
  // Use the latest block for the compression comparison: M0.3 is about gzip, and the proof window
  // that makes finalized proofs flaky (M0.2) would otherwise dominate the result.
  const block = await rpcThroughNox(PUBLIC_RPC, 'eth_getBlockByNumber', ['latest', false])
  const blockNumber = block.value?.number ?? 'latest'
  const checks = {}
  for (const test of ENCODING_CASES) {
    checks[test.id] = await proofWithEncoding(test.headers, blockNumber)
  }

  // PublicNode sends the proof with chunked transfer (no content-length) in this run, so also ask
  // an echo endpoint what request headers the origin sees and a /gzip endpoint whether a compressed
  // response survives Nox + the browser.
  const echo = await throughNox('https://httpbingo.org/anything', {
    headers: { 'x-m0-probe': '1', 'accept-encoding': 'gzip' },
  })
  const echoBody = parseJson(echo.text)
  const echoHeaders = echoBody?.headers && typeof echoBody.headers === 'object' ? echoBody.headers : {}
  const originAcceptEncoding =
    Object.entries(echoHeaders).find(([key]) => key.toLowerCase() === 'accept-encoding')?.[1] ?? null
  checks.echoRequest = {
    ...summaryOf(echo),
    originAcceptEncoding,
    forwardedCustomHeader:
      Object.entries(echoHeaders).find(([key]) => key.toLowerCase() === 'x-m0-probe')?.[1] ?? null,
  }

  const gz = await throughNox('https://httpbingo.org/gzip')
  const gzBody = parseJson(gz.text)
  const gzLength = gz.headers['content-length'] ? Number(gz.headers['content-length']) : null
  checks.gzipEndpoint = {
    ...summaryOf(gz),
    contentEncoding: gz.headers['content-encoding'] ?? null,
    contentLength: gzLength,
    decodedBytes: gz.bytes,
    parsedGzipped: gzBody?.gzipped ?? null,
    ratio: gzLength ? Number((gz.bytes / gzLength).toFixed(2)) : null,
  }

  const proofOk =
    checks.default?.ok === true && checks.identity?.ok === true && checks.gzip?.ok === true
  const originSeesGzip =
    originAcceptEncoding != null && String(originAcceptEncoding).toLowerCase().includes('gzip')
  // httpbingo /gzip always sends a gzip body (it ignores identity). If fetch can parse its JSON,
  // the browser decompressed it before app code. content-encoding itself is hidden by fetch.
  const gzipEndpointDecompressed = checks.gzipEndpoint.parsedGzipped === true
  const gzipEndToEnd = originSeesGzip && gzipEndpointDecompressed
  const encodingVisible =
    checks.echoRequest.originAcceptEncoding != null || checks.gzipEndpoint.parsedGzipped === true
  return {
    status: !proofOk ? 'fail' : gzipEndToEnd ? 'pass' : encodingVisible ? 'partial' : 'unknown',
    endpoint: PUBLIC_RPC,
    blockNumber,
    blockTag: 'latest',
    address: ZERO_ADDRESS,
    at: new Date().toISOString(),
    userAgent: navigator.userAgent,
    gzipEndToEnd,
    encodingVisible,
    originSeesGzip,
    proofResponsesChunked: checks.default?.final?.contentLength == null,
    customAcceptEncodingAccepted: originSeesGzip,
    note: gzipEndToEnd
      ? 'origin sees accept-encoding: gzip; /gzip parsed as JSON after the browser decompressed it. Proof responses are chunked, so their compressed size is not observable'
      : encodingVisible
        ? 'request or response compression headers are visible, but the body did not prove gzip end to end'
        : 'neither request nor response compression headers were visible through Nox',
    checks,
  }
}

// ------------------------------------------------------------------------------- M0.4

/** Call the raw wasm ABI: allocate, copy JSON in, read packed pointer/length out, free both. */
function callWasmVerifier(instance, request) {
  const bytes = new TextEncoder().encode(JSON.stringify(request))
  const { memory, veriq_alloc, veriq_free, veriq_verify_account } = instance.exports
  const inputPtr = veriq_alloc(bytes.length)
  new Uint8Array(memory.buffer, inputPtr, bytes.length).set(bytes)
  const packed = veriq_verify_account(inputPtr, bytes.length)
  veriq_free(inputPtr, bytes.length)

  const outputPtr = Number(packed >> 32n)
  const outputLen = Number(packed & 0xffffffffn)
  const output = new Uint8Array(memory.buffer, outputPtr, outputLen).slice()
  veriq_free(outputPtr, outputLen)
  return JSON.parse(new TextDecoder().decode(output))
}

function flipLastByte(value) {
  const clean = String(value).replace(/^0x/, '')
  const last = (parseInt(clean.slice(-2), 16) ^ 1).toString(16).padStart(2, '0')
  return `0x${clean.slice(0, -2)}${last}`
}

async function probeM04() {
  const [wasmResponse, fixtureResponse] = await Promise.all([
    fetch('./verifier_wasm.wasm'),
    fetch('./fixtures/eoa.json'),
  ])
  if (!wasmResponse.ok) throw new Error(`verifier wasm: HTTP ${wasmResponse.status}`)
  if (!fixtureResponse.ok) throw new Error(`fixture: HTTP ${fixtureResponse.status}`)
  const wasmBytes = await wasmResponse.arrayBuffer()
  const fixture = await fixtureResponse.json()

  const instantiateStarted = performance.now()
  const { instance } = await WebAssembly.instantiate(wasmBytes, {})
  const instantiateMs = Math.round(performance.now() - instantiateStarted)
  const exports = Object.keys(instance.exports).sort()

  const result = fixture.proof
  const request = {
    root: fixture.block.stateRoot,
    address: fixture.address,
    proof: result.accountProof,
    claimed: {
      nonce: Number(BigInt(result.nonce)),
      balance: result.balance,
      storageHash: result.storageHash,
      codeHash: result.codeHash,
    },
  }

  const verifyStarted = performance.now()
  const output = callWasmVerifier(instance, request)
  const verifyMs = Math.round((performance.now() - verifyStarted) * 100) / 100

  const expected = {
    nonce: Number(BigInt(result.nonce)),
    balance: BigInt(result.balance).toString(),
    storageRoot: String(result.storageHash).toLowerCase(),
    codeHash: String(result.codeHash).toLowerCase(),
  }
  const account = output.account
  const matches =
    output.ok === true &&
    output.exists === true &&
    account != null &&
    account.nonce === expected.nonce &&
    BigInt(account.balance).toString() === expected.balance &&
    String(account.storage_root).toLowerCase() === expected.storageRoot &&
    String(account.code_hash).toLowerCase() === expected.codeHash

  const tampered = {
    ...request,
    proof: [...request.proof.slice(0, -1), flipLastByte(request.proof[request.proof.length - 1])],
  }
  const tamperedOutput = callWasmVerifier(instance, tampered)
  const tamperedRejected = tamperedOutput.ok === false && /proof|invalid|mismatch/i.test(tamperedOutput.error ?? '')

  return {
    status: matches && tamperedRejected ? 'pass' : matches ? 'partial' : 'fail',
    wasm: 'verifier_wasm.wasm',
    wasmBytes: wasmBytes.byteLength,
    instantiateMs,
    verifyMs,
    exports,
    fixture: 'eoa.json',
    expected,
    result: output,
    matches,
    tampered: {
      rejected: tamperedRejected,
      error: tamperedOutput.error ?? null,
    },
    at: new Date().toISOString(),
    userAgent: navigator.userAgent,
  }
}

/** Probe registry. M0.3/M0.4 stay stubs until their sections in the build plan. */
export const probes = {
  m01: { title: 'M0.1 beacon API through Nox', run: probeM01 },
  m02: { title: 'M0.2 public RPC eth_getProof through Nox', run: probeM02 },
  m03: { title: 'M0.3 gzip through Nox', run: probeM03 },
  m04: { title: 'M0.4 WASM verifier in the browser', run: probeM04 },
}

async function runProbe(id) {
  const probe = probes[id]
  log(`--- ${probe.title}`)
  const started = performance.now()
  try {
    const result = await probe.run()
    state.probes[id] = { ...result, ms: Math.round(performance.now() - started) }
  } catch (err) {
    state.probes[id] = {
      status: 'error',
      error: `${err?.name ?? 'Error'}: ${err?.message ?? err}`,
      ms: Math.round(performance.now() - started),
    }
  }
  log(`${id}:`, state.probes[id])
}

const buttons = [...document.querySelectorAll('button')]
async function guarded(fn) {
  buttons.forEach((b) => (b.disabled = true))
  try {
    await fn()
  } finally {
    buttons.forEach((b) => (b.disabled = false))
  }
}

for (const button of document.querySelectorAll('button[data-probe]')) {
  button.addEventListener('click', () => guarded(() => runProbe(button.dataset.probe)))
}

async function runAll(ids = Object.keys(probes)) {
  state.done = false
  log('=== run all', ids.join(','))
  for (const id of ids) await runProbe(id)
  state.done = true
  log('=== done')
}

document.getElementById('run-all').addEventListener('click', () => guarded(() => runAll()))

// ?autorun=1 runs everything; ?autorun=m03 runs only that probe on a fresh worker.
const autorun = new URLSearchParams(location.search).get('autorun')
if (autorun) {
  const ids =
    autorun === '1' ? Object.keys(probes) : autorun.split(',').filter((id) => probes[id])
  worker.ready.then(
    () => (ids.length ? guarded(() => runAll(ids)) : undefined),
    () => {
      // The failed state is already shown; nothing to run.
    },
  )
}
