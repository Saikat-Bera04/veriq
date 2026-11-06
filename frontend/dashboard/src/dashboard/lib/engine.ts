/**
 * Dashboard HTTP and JSON-RPC calls live here. Sample data is limited to the engine
 * overview/read experience and the development-only Attack Lab; contract storage
 * reads and production Attack Lab calls fail closed instead of substituting mock data.
 */
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { ZodError } from 'zod'
import {
  createVeriq,
  EngineUnreachableError,
  VeriqError,
  verifiedFinalized,
  type Hex,
  type EngineHealth,
  type Policy,
  type VerifiedResult,
  type ReceiptRecord,
} from 'veriq-client'
import {
  ATTACK_MODES,
  PlainRpcError,
  mockGetMode,
  mockHealth,
  mockPlainBalance,
  mockReadBalance,
  mockReceipts,
  mockSetMode,
  type AttackMode,
} from './mock'
import { getPrivateReader, isAnonEnabled, useAnonMode } from './anon'

// `||`, not `??`: an empty VITE_* value (an unfilled line in .env, exported by scripts/demo.sh) means "default".
export const ENGINE_BASE: string = import.meta.env.VITE_ENGINE_URL || '/engine'
export const ATTACKER_BASE: string = import.meta.env.VITE_ATTACKER_URL || '/attacker'
export const DEMO_CONTRACT_ADDRESS =
  (import.meta.env.VITE_DEMO_CONTRACT_ADDRESS as `0x${string}` | undefined) ||
  '0x1242C562946C926a6d0012Acb54D9413A54A1CA4'
export const DEMO_CONTRACT_SLOT = '0x0'

export function getEngineDisplayAddress(): string {
  const configured = import.meta.env.VITE_ENGINE_URL
  if (configured) {
    try {
      return configured.startsWith('http') ? new URL(configured).host : configured
    } catch {
      return configured
    }
  }
  if (typeof window !== 'undefined' && window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return 'veriq-cloud.onrender.com'
  }
  return '127.0.0.1:8547'
}

export const ENGINE_DISPLAY = getEngineDisplayAddress()
export const ATTACKER_DISPLAY = (() => {
  const configured = import.meta.env.VITE_ATTACKER_URL
  if (configured) {
    try {
      return configured.startsWith('http') ? new URL(configured).host : configured
    } catch {
      return configured
    }
  }
  return '127.0.0.1:9545'
})()
/** The engine's demo-only admin routes are never proxied (vite.config.ts): the browser calls the
 * engine on its own loopback, which only works on the machine running the demo. */
export const ENGINE_ADMIN_BASE: string = import.meta.env.VITE_ENGINE_ADMIN_URL || 'http://127.0.0.1:8547'

export const veriq = createVeriq({ url: ENGINE_BASE, policy: verifiedFinalized })

export type Source = 'live' | 'mock'
export interface Sourced<T> {
  source: Source
  data: T
}

/** Network failure, timeout, proxy error or an HTML fallback page => service is not there. */
function isUnreachable(err: unknown): boolean {
  if (err instanceof EngineUnreachableError) return true
  if (err instanceof ZodError || err instanceof VeriqError) return false
  if (err instanceof TypeError || err instanceof SyntaxError) return true
  if (err instanceof DOMException) return true
  return err instanceof Error && /HTTP (404|5\d\d)/.test(err.message)
}

// Remember the last health result so other queries skip straight to mock while offline.
let engineSource: Source | null = null

async function withFallback<T>(live: () => Promise<T>, mock: () => T | Promise<T>, knownSource: Source | null): Promise<Sourced<T>> {
  if (knownSource === 'mock') return { source: 'mock', data: await mock() }
  try {
    return { source: 'live', data: await live() }
  } catch (err) {
    if (isUnreachable(err)) return { source: 'mock', data: await mock() }
    throw err
  }
}

// ---------------------------------------------------------------- engine

export async function fetchHealth(): Promise<Sourced<EngineHealth>> {
  const res = await withFallback(() => veriq.health(), mockHealth, null)
  engineSource = res.source
  return res
}

export async function fetchReceipts(limit: number): Promise<Sourced<ReceiptRecord[]>> {
  if (engineSource === 'live') {
    // Never mix sample receipts into a live engine's pages. An engine without
    // GET /receipts yet simply has an empty feed.
    try {
      return { source: 'live', data: await veriq.listReceipts(limit) }
    } catch (err) {
      if (isUnreachable(err)) return { source: 'live', data: [] }
      throw err
    }
  }
  return withFallback(() => veriq.listReceipts(limit), () => mockReceipts(limit), engineSource)
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 5000 })
}

export function useReceipts(limit = 500) {
  return useQuery({ queryKey: ['receipts', limit], queryFn: () => fetchReceipts(limit), refetchInterval: 2000 })
}

export function useEngineSource(): Source | undefined {
  return useHealth().data?.source
}

export type ReadOutcome =
  | { ok: true; source: Source; result: VerifiedResult<bigint> }
  | { ok: false; source: Source; error: VeriqError | Error }

/** veriq_readBalance through the SDK. Attempts come from the result, or from /receipts/:id if omitted. */
async function readMock(address: string, policy: Policy): Promise<ReadOutcome> {
  try {
    return { ok: true, source: 'mock', result: await mockReadBalance(address, policy) }
  } catch (err) {
    return { ok: false, source: 'mock', error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/**
 * Balance read. With Anon-RPC on (the default) the proof is fetched through Nox and verified by the
 * engine; if Nox is not available the read fails. It never quietly goes direct instead. Sample data
 * is used only when the engine itself is unreachable.
 */
export async function readBalance(
  address: string,
  policy: Policy = verifiedFinalized,
  /** `direct`: always the engine's own provider routing (the Attack Lab needs its attacker in it). */
  opts: { path?: 'auto' | 'direct' } = {},
): Promise<ReadOutcome> {
  if (engineSource === 'mock') return readMock(address, policy)
  const source: Source = 'live'
  try {
    const result = opts.path !== 'direct' && isAnonEnabled()
      ? await (await getPrivateReader(veriq)).readBalance({ address, policy })
      : await veriq.readBalance({ address, policy })
    if (result.attempts.length === 0) {
      try {
        const record = await veriq.getReceiptRecord(result.receipt.identity.requestId)
        result.attempts = record.attempts
      } catch {
        // receipt store lookup is best-effort
      }
    }
    return { ok: true, source, result }
  } catch (err) {
    if (isUnreachable(err)) return readMock(address, policy)
    return { ok: false, source, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

export type StorageReadOutcome =
  | { ok: true; result: VerifiedResult<Hex> }
  | { ok: false; error: Error }

/** Contract storage: through Nox when Anon-RPC is on, else veriq_readStorage. Never sample state. */
export async function readStorage(
  address: string = DEMO_CONTRACT_ADDRESS,
  slot: string = DEMO_CONTRACT_SLOT,
): Promise<StorageReadOutcome> {
  try {
    const result = isAnonEnabled()
      ? await (await getPrivateReader(veriq)).readStorage({ address, slot })
      : await veriq.readStorage({ address, slot })
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

export function useDemoContractStorage() {
  // The read path is part of the key: switching private <-> direct reads again on the new path.
  const mode = useAnonMode()
  return useQuery({
    queryKey: ['demo-contract-storage', DEMO_CONTRACT_ADDRESS, DEMO_CONTRACT_SLOT, mode],
    queryFn: () => readStorage(),
    refetchInterval: 30_000,
    retry: false,
  })
}

// ---------------------------------------------------------------- attacker

let attackerSource: Source | null = null

export async function fetchAttackerMode(): Promise<Sourced<AttackMode>> {
  try {
    const r = await fetch(`${ATTACKER_BASE}/mode`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error(`GET /mode failed: HTTP ${r.status}`)
    // backend/crates/malicious-rpc: GET /mode -> { "mode": "value", "available": [...] }
    const body: unknown = await r.json()
    const name = typeof body === 'object' && body !== null && 'mode' in body ? body.mode : undefined
    const mode = ATTACK_MODES.find((m) => m === name)
    if (!mode) throw new SyntaxError(`unexpected attacker mode ${JSON.stringify(name)}`)
    attackerSource = 'live'
    return { source: 'live', data: mode }
  } catch (err) {
    if (import.meta.env.DEV && isUnreachable(err)) {
      attackerSource = 'mock'
      return { source: 'mock', data: mockGetMode() }
    }
    attackerSource = null
    throw new Error(
      `Attack Lab service unavailable. The hosted app needs a protected attacker service configured with VITE_ATTACKER_URL.`,
      { cause: err },
    )
  }
}

/** `reset`: every circuit breaker cleared. `unavailable`: the engine has no reset route
 * (not a demo build) or cannot be reached from this browser. */
export type ResetOutcome = 'reset' | 'unavailable'

/** Demo builds only (POST /admin/reset-breakers, loopback): after an INVALID_PROOF the attacker is
 * benched for 5 minutes, so without a reset the next mode would never reach it. */
export async function resetBreakers(): Promise<ResetOutcome> {
  // This endpoint is loopback-only; from a hosted browser it would target the visitor's machine.
  if (!import.meta.env.DEV) return 'unavailable'
  if (attackerSource === 'mock') return 'reset' // the simulated attacker has no breaker
  try {
    const r = await fetch(`${ENGINE_ADMIN_BASE}/admin/reset-breakers`, { method: 'POST', signal: AbortSignal.timeout(3000) })
    return r.ok ? 'reset' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** Switch the attacker's mode, then reset the breakers so the new mode is tried at once. */
export async function setAttackerMode(mode: AttackMode): Promise<ResetOutcome> {
  if (attackerSource === 'mock' && import.meta.env.DEV) {
    mockSetMode(mode)
    return 'reset'
  }
  if (attackerSource !== 'live') throw new Error('Attacker service is unavailable.')
  // backend/crates/malicious-rpc: POST /mode takes { "mode": "value" }
  const r = await fetch(`${ATTACKER_BASE}/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
    signal: AbortSignal.timeout(3000),
  })
  if (!r.ok) throw new Error(`POST /mode failed: HTTP ${r.status}`)
  return resetBreakers()
}

export function useAttackerMode() {
  return useQuery({ queryKey: ['attacker-mode'], queryFn: fetchAttackerMode, refetchInterval: 5000 })
}

export function useSetAttackerMode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: setAttackerMode,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attacker-mode'] }),
  })
}

export type PlainOutcome = { ok: true; value: bigint } | { ok: false; error: string }

/** eth_getBalance straight to the attacker. No proof, no checks: whatever it claims. */
export async function plainGetBalance(address: string): Promise<PlainOutcome> {
  try {
    if (attackerSource === 'mock' && import.meta.env.DEV) return { ok: true, value: await mockPlainBalance(address) }
    const r = await fetch(ATTACKER_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'finalized'] }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${r.statusText}`.trim() }
    const body: unknown = await r.json()
    if (typeof body === 'object' && body !== null && 'result' in body && typeof body.result === 'string') {
      return { ok: true, value: BigInt(body.result) }
    }
    if (typeof body === 'object' && body !== null && 'error' in body) {
      return { ok: false, error: JSON.stringify(body.error) }
    }
    return { ok: false, error: 'unexpected response' }
  } catch (err) {
    if (err instanceof PlainRpcError) return { ok: false, error: err.message }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
