/**
 * S4.1: a Helios light client running in this tab, with every request it makes sent through Nox.
 *
 * Helios (the @a16z/helios WebAssembly build, from the same Helios commit the engine pins) calls the
 * global `fetch`. It is given placeholder URLs on the reserved `.invalid` domain, and a fetch
 * wrapper sends only those through the Nox worker, to the real beacon API and execution RPC. A
 * request that escaped the wrapper could not resolve, so Helios traffic never goes direct.
 *
 * Trust anchor: Lodestar Sepolia serves light-client bootstraps only for the *current* finalized
 * checkpoint, so a pinned one goes stale within an epoch. Each start therefore reads the current
 * finalized checkpoint from checkpointz (ethpandaops, a different operator than the beacon API),
 * through Nox, and needs every healthy upstream to agree. The engine's own root (pinned checkpoint,
 * separate Helios) is the cross-check: on the same block the two must match (S4.2).
 *
 * Status: idle → waiting (for Nox) → syncing → synced | failed. The last checkpoint Helios
 * reached is kept in localStorage so a reload within a few minutes skips the checkpointz request.
 */
import { useSyncExternalStore } from 'react'
import type { BrowserLightClient, BrowserRoot } from 'veriq-client'
import { getAnonFetch, isAnonEnabled, parseProviders } from './anon'

/** Keyless Sepolia beacon API with light-client endpoints, reachable through Nox (TLS accepted). */
export const DEFAULT_CONSENSUS = 'https://lodestar-sepolia.chainsafe.io'
/** checkpointz: the current finalized checkpoint, from a different operator than the beacon API. */
export const DEFAULT_CHECKPOINT_SOURCE = 'https://checkpoint-sync.sepolia.ethpandaops.io'
const CONSENSUS_HOST = 'consensus.helios.invalid'
const EXECUTION_HOST = 'execution.helios.invalid'
const STORAGE_KEY = 'veriq.browserHelios.v1'
/** A stored checkpoint younger than this is tried before asking checkpointz (Lodestar serves only the current one). */
const STORED_CHECKPOINT_MAX_AGE_MS = 5 * 60_000
/** Same limit as the engine (crates/light-client MAX_FINALIZED_AGE_SECONDS): older is "not synced". */
export const MAX_FINALIZED_AGE_SECONDS = 30 * 60
const SYNC_TIMEOUT_MS = 120_000
const HASH_RE = /^0x[0-9a-fA-F]{64}$/

export type BrowserLightClientState = 'off' | 'idle' | 'waiting' | 'syncing' | 'synced' | 'failed'

export interface FinalizedBlock extends BrowserRoot {
  timestamp: number
}

export interface BrowserLightClientStatus {
  state: BrowserLightClientState
  finalized?: FinalizedBlock
  /** Bootstrap checkpoint (beacon block root) and where it came from. */
  checkpoint?: string
  checkpointSource?: string
  /** Milliseconds from starting Helios to synced (excludes waiting for Nox). */
  syncMs?: number
  error?: string
}

/** The part of the Helios provider this module uses (tests pass a fake). */
export interface HeliosLike {
  waitSynced(): Promise<void>
  request(req: { method: string; params: unknown[] }): Promise<unknown>
  shutdown?(): Promise<void>
}
export interface HeliosConfig {
  consensusRpc: string
  executionRpc: string
  network: 'sepolia'
  checkpoint: string
  dbType: 'config'
}
export type HeliosFactory = (config: HeliosConfig) => Promise<HeliosLike>
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const defaultFactory: HeliosFactory = async (config) => {
  // Lazy: the Helios bundle (~4 MB with its wasm) loads only once Nox is ready, never on the landing page.
  const { createHeliosProvider } = await import('@a16z/helios')
  return createHeliosProvider(config, 'ethereum') as unknown as HeliosLike
}

/** On unless `VITE_BROWSER_LIGHT_CLIENT=off`; needs Anon-RPC (Helios never syncs directly). */
export function isBrowserLightClientEnabled(): boolean {
  const value = String(import.meta.env.VITE_BROWSER_LIGHT_CLIENT ?? '').trim().toLowerCase()
  return isAnonEnabled() && !['off', '0', 'false', 'no'].includes(value)
}

const httpsOrigin = (value: string | undefined, fallback: string) => {
  const v = value?.trim().replace(/\/+$/, '')
  return v && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(v) ? v : fallback
}

/**
 * The fetch Helios sees. Requests to the placeholder hosts go through `viaNox` to the real
 * endpoint; anything else goes to `direct` unchanged. The response's `url` is set because
 * reqwest (wasm) parses it.
 */
export function createHeliosFetch(routes: Record<string, string>, viaNox: Fetch, direct: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const base = routes[url.hostname]
    if (!base) return direct(input, init)
    const method = request.method
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text()
    // JSON-RPC posts to "/" mean the configured URL itself (it may carry a path, e.g. a key).
    const target = url.pathname === '/' ? `${base}${url.search}` : `${base}${url.pathname}${url.search}`
    const res = await viaNox(target, { method, headers, body })
    const out = new Response(await res.arrayBuffer(), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    })
    Object.defineProperty(out, 'url', { value: request.url })
    return out
  }
}

/** checkpointz status → the finalized root every healthy upstream agrees on. */
export function agreedCheckpoint(status: unknown): string {
  const upstreams = (status as { data?: { upstreams?: Record<string, unknown> } })?.data?.upstreams
  const roots = new Set<string>()
  let healthy = 0
  for (const upstream of Object.values(upstreams ?? {})) {
    const u = upstream as { healthy?: boolean; finality?: { finalized?: { root?: unknown } } }
    if (!u?.healthy) continue
    healthy++
    const root = u.finality?.finalized?.root
    if (typeof root !== 'string' || !HASH_RE.test(root)) throw new Error('checkpointz: a healthy upstream has no finalized root')
    roots.add(root.toLowerCase())
  }
  if (healthy === 0) throw new Error('checkpointz: no healthy upstream')
  if (roots.size !== 1) throw new Error(`checkpointz: healthy upstreams disagree (${roots.size} different finalized roots)`)
  return [...roots][0]!
}

interface Stored {
  checkpoint: string
  savedAt: number
}

function readStored(): Stored | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Stored | null
    return raw && HASH_RE.test(raw.checkpoint) && typeof raw.savedAt === 'number' ? raw : null
  } catch {
    return null
  }
}

function writeStored(checkpoint: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ checkpoint, savedAt: Date.now() } satisfies Stored))
  } catch {
    // storage full or blocked: the next start asks checkpointz
  }
}

interface Singleton {
  status: BrowserLightClientStatus
  helios: HeliosLike | null
  starting: Promise<void> | null
  listeners: Set<() => void>
  factory: HeliosFactory
  /** The global fetch before the Helios wrapper was installed (restored in tests). */
  previousFetch: typeof fetch | null
  timer: ReturnType<typeof setInterval> | null
}

const KEY = Symbol.for('veriq.dashboard.browserHelios')
const holder = globalThis as unknown as { [KEY]?: Singleton }

function lc(): Singleton {
  holder[KEY] ??= {
    status: { state: isBrowserLightClientEnabled() ? 'idle' : 'off' },
    helios: null,
    starting: null,
    listeners: new Set(),
    factory: defaultFactory,
    previousFetch: null,
    timer: null,
  }
  return holder[KEY]
}

function setStatus(next: BrowserLightClientStatus) {
  const s = lc()
  s.status = next
  for (const listener of s.listeners) listener()
}

export function getBrowserLightClientStatus(): BrowserLightClientStatus {
  return lc().status
}

export function subscribeBrowserLightClient(listener: () => void): () => void {
  lc().listeners.add(listener)
  return () => lc().listeners.delete(listener)
}

export function useBrowserLightClient(): BrowserLightClientStatus {
  return useSyncExternalStore(subscribeBrowserLightClient, getBrowserLightClientStatus, getBrowserLightClientStatus)
}

function installFetch(routes: Record<string, string>, viaNox: Fetch) {
  const s = lc()
  if (s.previousFetch) return // already installed
  s.previousFetch = globalThis.fetch
  globalThis.fetch = createHeliosFetch(routes, viaNox, s.previousFetch.bind(globalThis))
}

async function readFinalized(helios: HeliosLike): Promise<FinalizedBlock> {
  const block = (await helios.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })) as {
    number?: unknown
    hash?: unknown
    stateRoot?: unknown
    timestamp?: unknown
  } | null
  const number = Number(block?.number)
  const timestamp = Number(block?.timestamp)
  const { hash, stateRoot } = block ?? {}
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp) || typeof hash !== 'string' || !HASH_RE.test(hash) || typeof stateRoot !== 'string' || !HASH_RE.test(stateRoot)) {
    throw new Error('Helios returned no usable finalized block')
  }
  return { number, hash, stateRoot, timestamp }
}

/**
 * Starts Helios once per page, after Nox is ready. Safe to call any number of times. Resolves when
 * synced; on failure the status is `failed` with the reason (reads then use the engine root alone).
 */
export function startBrowserLightClient(): Promise<void> {
  const s = lc()
  if (s.starting) return s.starting
  if (!isBrowserLightClientEnabled()) {
    setStatus({ state: 'off' })
    s.starting = Promise.resolve()
    return s.starting
  }
  s.starting = run().catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err)
    setStatus({ ...lc().status, state: 'failed', error: reason })
  })
  return s.starting

  async function run() {
    setStatus({ state: 'waiting' })
    const viaNox = await getAnonFetch() // Nox failed → this throws, Helios never starts
    const env = import.meta.env
    const consensus = httpsOrigin(env.VITE_HELIOS_CONSENSUS_RPC, DEFAULT_CONSENSUS)
    const checkpointSource = httpsOrigin(env.VITE_HELIOS_CHECKPOINT_SOURCE, DEFAULT_CHECKPOINT_SOURCE)
    const execution = parseProviders(env.VITE_ANON_PROVIDERS)[0]?.url
    if (!execution) throw new Error('no execution provider configured for Helios (VITE_ANON_PROVIDERS)')
    installFetch({ [CONSENSUS_HOST]: consensus, [EXECUTION_HOST]: execution }, viaNox)

    const fresh = async () => {
      const res = await viaNox(`${checkpointSource}/checkpointz/v1/status`, { method: 'GET', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`checkpointz answered HTTP ${res.status}`)
      return agreedCheckpoint(await res.json())
    }
    const sourceName = new URL(checkpointSource).hostname
    const stored = readStored()
    const candidates: Array<() => Promise<{ checkpoint: string; source: string }>> = []
    if (stored && Date.now() - stored.savedAt < STORED_CHECKPOINT_MAX_AGE_MS) {
      candidates.push(async () => ({ checkpoint: stored.checkpoint, source: `${sourceName} (saved in this browser)` }))
    }
    // Twice from checkpointz: right at an epoch boundary the beacon API can be a moment behind it.
    candidates.push(async () => ({ checkpoint: await fresh(), source: sourceName }))
    candidates.push(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000))
      return { checkpoint: await fresh(), source: sourceName }
    })

    let lastError: unknown
    for (const candidate of candidates) {
      let helios: HeliosLike | null = null
      try {
        const { checkpoint, source } = await candidate()
        setStatus({ state: 'syncing', checkpoint, checkpointSource: source })
        const started = Date.now()
        helios = await s.factory({
          consensusRpc: `https://${CONSENSUS_HOST}`,
          executionRpc: `https://${EXECUTION_HOST}`,
          network: 'sepolia',
          checkpoint,
          dbType: 'config',
        })
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          helios.waitSynced(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Helios did not sync within ${SYNC_TIMEOUT_MS / 1000} s`)), SYNC_TIMEOUT_MS)
          }),
        ]).finally(() => clearTimeout(timer))
        const finalized = await readFinalized(helios)
        s.helios = helios
        setStatus({ state: 'synced', finalized, checkpoint, checkpointSource: source, syncMs: Date.now() - started })
        await saveCurrentCheckpoint(helios)
        s.timer ??= setInterval(() => void browserLightClient.finalized(), 12_000)
        return
      } catch (err) {
        lastError = err
        void helios?.shutdown?.().catch(() => {})
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

async function saveCurrentCheckpoint(helios: HeliosLike) {
  try {
    const checkpoint = await helios.request({ method: 'helios_getCurrentCheckpoint', params: [] })
    if (typeof checkpoint === 'string' && HASH_RE.test(checkpoint)) writeStored(checkpoint)
  } catch {
    // optional
  }
}

/**
 * For the private reader (SDK `lightClient` option): the finalized block from Helios in this tab,
 * or `null` while it is not synced, failed, or its finalized block is older than 30 min.
 */
export const browserLightClient: BrowserLightClient = {
  async finalized() {
    const s = lc()
    if (s.status.state !== 'synced' || !s.helios) return null
    let block: FinalizedBlock
    try {
      block = await readFinalized(s.helios)
    } catch {
      return null
    }
    if (block.number !== s.status.finalized?.number || block.hash !== s.status.finalized?.hash) {
      setStatus({ ...s.status, finalized: block })
      void saveCurrentCheckpoint(s.helios)
    }
    if (Date.now() / 1000 - block.timestamp > MAX_FINALIZED_AGE_SECONDS) return null
    return { number: block.number, hash: block.hash, stateRoot: block.stateRoot }
  },
}

/** Tests only: a fake Helios factory, a fresh singleton, and the original global fetch back. */
export function resetBrowserLightClientForTests(factory: HeliosFactory = defaultFactory) {
  const s = lc()
  if (s.previousFetch) globalThis.fetch = s.previousFetch
  if (s.timer) clearInterval(s.timer)
  delete holder[KEY]
  lc().factory = factory
  for (const listener of s.listeners) lc().listeners.add(listener)
}
