// @vitest-environment node
/**
 * S4.1 with the real Helios WebAssembly (@a16z/helios 0.12.0) and recorded light-client data.
 *
 * fixtures/browser-helios/*.json.gz holds every response Helios got while syncing Sepolia in
 * headless Chrome through Nox (spikes/anon-rpc/helios.html?record=1). Here the same Helios build
 * syncs from them through the dashboard's own fetch wrapper (createHeliosFetch), so the test covers
 * the placeholder routing too. No network: the "Nox" side replays the recording.
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createHeliosFetch } from './lightclient'

interface Recorded {
  host: 'consensus' | 'execution'
  method: string
  path: string
  body: string | null
  status: number
  response: string
}
interface Fixture {
  checkpoint: string
  consensus: string
  execution: string
  finalized: { number: number; hash: string; stateRoot: string }
  requests: Recorded[]
}

const FIXTURE = fileURLToPath(new URL('../../../../../fixtures/browser-helios/sepolia-12076786.json.gz', import.meta.url))
const fixture = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8')) as Fixture

const rpcKey = (body: string | null | undefined) => {
  if (!body) return ''
  const { method, params } = JSON.parse(body) as { method: string; params: unknown }
  return `${method}${JSON.stringify(params)}`
}

/** The recorded Nox answers; `tamper` may rewrite one before Helios sees it. */
function replay(tamper?: (path: string, body: string) => string) {
  const asked: string[] = []
  const viaNox = async (url: string, init?: RequestInit) => {
    const host = url.startsWith(fixture.consensus) ? 'consensus' : url.startsWith(fixture.execution) ? 'execution' : null
    const path = host === 'consensus' ? url.slice(fixture.consensus.length) : '/'
    const key = rpcKey(init?.body as string | undefined)
    asked.push(`${host} ${path} ${key}`)
    const hit = fixture.requests.find((r) => r.host === host && r.path === path && rpcKey(r.body) === key)
    if (!hit) return new Response('{"message":"not recorded"}', { status: 404 })
    return new Response(tamper ? tamper(path, hit.response) : hit.response, { status: hit.status, headers: { 'content-type': 'application/json' } })
  }
  return { viaNox, asked }
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

async function sync(viaNox: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = createHeliosFetch(
    { 'consensus.helios.invalid': fixture.consensus, 'execution.helios.invalid': fixture.execution },
    viaNox,
    realFetch, // only Helios's own wasm (a data: URL) goes here
  )
  const { createHeliosProvider } = await import('@a16z/helios')
  const helios = await createHeliosProvider(
    { consensusRpc: 'https://consensus.helios.invalid', executionRpc: 'https://execution.helios.invalid', network: 'sepolia', checkpoint: fixture.checkpoint, dbType: 'config' },
    'ethereum',
  )
  try {
    await helios.waitSynced()
    return (await helios.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })) as { number: string; hash: string; stateRoot: string }
  } finally {
    await helios.shutdown()
  }
}

describe('Helios wasm replaying a recorded Sepolia sync', () => {
  it('reaches the recorded finalized block and state root', async () => {
    const { viaNox, asked } = replay()
    const block = await sync(viaNox)
    const { number, hash, stateRoot } = fixture.finalized
    expect({ number: Number(block.number), hash: block.hash, stateRoot: block.stateRoot }).toEqual({ number, hash, stateRoot })
    // bootstrap, updates and finality update from the beacon API; blocks from the execution RPC.
    expect(asked.filter((a) => a.startsWith('consensus')).map((a) => a.split(' ')[1]?.split('?')[0])).toEqual([
      `/eth/v1/beacon/light_client/bootstrap/${fixture.checkpoint}`,
      '/eth/v1/beacon/light_client/updates',
      '/eth/v1/beacon/light_client/finality_update',
    ])
  }, 60_000)

  it('rejects a finality update with a forged sync committee signature', async () => {
    const { viaNox } = replay((path, body) => {
      if (!path.endsWith('/finality_update')) return body
      const update = JSON.parse(body) as { data: { sync_aggregate: { sync_committee_signature: string } } }
      const sig = update.data.sync_aggregate.sync_committee_signature
      update.data.sync_aggregate.sync_committee_signature = `${sig.slice(0, -2)}${sig.endsWith('00') ? '11' : '00'}`
      return JSON.stringify(update)
    })
    await expect(sync(viaNox)).rejects.toThrow(/invalid sync committee signature/)
  }, 60_000)

  it('rejects a bootstrap for another checkpoint than the one it was given', async () => {
    const { viaNox } = replay((path, body) => {
      if (!path.includes('/bootstrap/')) return body
      const boot = JSON.parse(body) as { data: { header: { beacon: { slot: string } } } }
      boot.data.header.beacon.slot = String(Number(boot.data.header.beacon.slot) + 1)
      return JSON.stringify(boot)
    })
    await expect(sync(viaNox)).rejects.toThrow()
  }, 60_000)
})
