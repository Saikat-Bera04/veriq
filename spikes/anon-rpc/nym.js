// S6 probe: is Nym's mixFetch usable for Veriq's private reads on mainnet?
// Public, keyless endpoints only; the token contract address is public (USDT), not a user.
const RPCS = {
  publicnode: 'https://ethereum-rpc.publicnode.com',
  drpc: 'https://eth.drpc.org',
  blastapi: 'https://eth-mainnet.public.blastapi.io',
}
const BEACONS = { lodestar: 'https://lodestar-mainnet.chainsafe.io', publicnode: 'https://ethereum-beacon-api.publicnode.com' }
const CHECKPOINTZ = 'https://sync-mainnet.beaconcha.in/checkpointz/v1/status'
const TARGET = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

const t0 = performance.now()
const now = () => Math.round(performance.now() - t0)
const state = { tunnel: 'idle', tunnelMs: null, loadMs: null, checks: [], error: null, done: false }
window.__s6 = state
const log = (...p) => { document.getElementById('log').textContent += `${String(now()).padStart(6)} ms  ${p.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n` }
const set = (s) => { state.tunnel = s; document.getElementById('tunnel').textContent = s; log('tunnel:', s) }

async function timed(name, fn) {
  const started = now()
  try {
    const detail = await fn()
    state.checks.push({ name, ok: true, ms: now() - started, ...detail })
  } catch (err) {
    state.checks.push({ name, ok: false, ms: now() - started, error: String(err?.message ?? err).slice(0, 200) })
  }
  log(state.checks.at(-1))
}

try {
  set('loading')
  const loadStart = now()
  const nym = await import('@nymproject/mix-fetch')
  state.loadMs = now() - loadStart
  set('connecting')
  const tStart = now()
  await nym.setupMixTunnel({ disableCoverTraffic: false })
  state.tunnelMs = now() - tStart
  set('ready')
  const rpc = async (url, method, params) => {
    const res = await nym.mixFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const body = await res.json()
    if (body.error) throw new Error(`${body.error.code} ${body.error.message}`)
    return { status: res.status, result: body.result }
  }
  let finalized = null
  for (const [label, url] of Object.entries(RPCS)) {
    await timed(`${label} eth_chainId`, async () => ({ chainId: (await rpc(url, 'eth_chainId', [])).result }))
    await timed(`${label} eth_getProof finalized`, async () => {
      const { result } = await rpc(url, 'eth_getProof', [TARGET, ['0x0'], 'finalized'])
      return { accountProofNodes: result.accountProof.length, storageProofs: result.storageProof.length }
    })
    if (!finalized) {
      await timed(`${label} finalized block`, async () => {
        finalized = (await rpc(url, 'eth_getBlockByNumber', ['finalized', false])).result
        return { number: Number(finalized.number) }
      })
    }
    if (finalized) {
      await timed(`${label} eth_getProof blockHash`, async () => {
        const { result } = await rpc(url, 'eth_getProof', [TARGET, ['0x0'], { blockHash: finalized.hash }])
        return { accountProofNodes: result.accountProof.length }
      })
    }
  }
  for (const [label, base] of Object.entries(BEACONS)) {
    await timed(`${label} beacon finality_update`, async () => {
      const res = await nym.mixFetch(`${base}/eth/v1/beacon/light_client/finality_update`, { headers: { accept: 'application/json' } })
      const body = await res.json()
      return { status: res.status, finalizedSlot: body?.data?.finalized_header?.beacon?.slot }
    })
  }
  await timed('checkpointz (beaconcha.in)', async () => {
    const res = await nym.mixFetch(CHECKPOINTZ, { headers: { accept: 'application/json' } })
    const body = await res.json()
    return { status: res.status, upstreams: Object.keys(body?.data?.upstreams ?? {}).length }
  })
  // Warm repeat: the cost of one private read once the tunnel is up.
  await timed('publicnode eth_getProof finalized (warm)', async () => {
    const { result } = await rpc(RPCS.publicnode, 'eth_getProof', [TARGET, ['0x0'], 'finalized'])
    return { accountProofNodes: result.accountProof.length }
  })
} catch (err) {
  state.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`
  set(`failed — ${state.error}`)
}
state.done = true
