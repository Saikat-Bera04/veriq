import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { VeriqError, type EngineHealth, type Hex, type Policy, type TrustReceipt, type VeriqClient, type VerifiedResult } from 'veriq-client'
import { useVeriqClient } from './provider'

export interface QueryState<T> {
  data?: T
  error?: VeriqError
  isLoading: boolean
  /** Re-fetch now (deduplicated with any request already in flight). */
  refresh: () => Promise<void>
}

export interface HookOptions {
  /** Poll every N ms. Default: no polling. */
  refreshInterval?: number
  /** Set false to skip fetching. Default true. */
  enabled?: boolean
}

interface Snapshot {
  data?: unknown
  error?: VeriqError
  isLoading: boolean
}

interface Entry {
  snap: Snapshot
  inflight?: Promise<void>
  listeners: Set<() => void>
}

// Tiny cache: one Map per client, keyed by method + params. No external data library.
const caches = new WeakMap<VeriqClient, Map<string, Entry>>()
const IDLE: Snapshot = { isLoading: false }

function entryFor(client: VeriqClient, key: string): Entry {
  let map = caches.get(client)
  if (!map) caches.set(client, (map = new Map()))
  let e = map.get(key)
  if (!e) map.set(key, (e = { snap: { isLoading: true }, listeners: new Set() }))
  return e
}

function toVeriqError(err: unknown): VeriqError {
  return err instanceof VeriqError ? err : new VeriqError(0, err instanceof Error ? err.message : String(err), { cause: err })
}

function run(e: Entry, fetcher: () => Promise<unknown>): Promise<void> {
  if (e.inflight) return e.inflight
  const set = (snap: Snapshot) => {
    e.snap = snap
    e.listeners.forEach((l) => l())
  }
  if (e.snap.data === undefined && !e.snap.isLoading) set({ ...e.snap, isLoading: true })
  e.inflight = fetcher()
    .then((data) => set({ data, isLoading: false }))
    .catch((err: unknown) => set({ ...(e.snap.data !== undefined ? { data: e.snap.data } : {}), error: toVeriqError(err), isLoading: false }))
    .finally(() => {
      e.inflight = undefined
    })
  return e.inflight
}

function useVeriqQuery<T>(key: string | null, fetcher: (c: VeriqClient) => Promise<T>, opts: HookOptions = {}): QueryState<T> {
  const client = useVeriqClient()
  const active = client !== null && key !== null && opts.enabled !== false
  const entry = active ? entryFor(client, key) : null

  const subscribe = useCallback((cb: () => void) => {
    if (!entry) return () => {}
    entry.listeners.add(cb)
    return () => entry.listeners.delete(cb)
  }, [entry])
  const snap = useSyncExternalStore(subscribe, () => entry?.snap ?? IDLE, () => entry?.snap ?? IDLE)

  const refresh = useCallback(() => (entry && client ? run(entry, () => fetcher(client)) : Promise.resolve()), [entry, client, fetcher])

  useEffect(() => {
    if (!entry) return
    if (entry.snap.data === undefined && !entry.snap.error) void refresh()
    // Revalidate when the tab regains focus.
    const onFocus = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const timer = opts.refreshInterval ? setInterval(() => void refresh(), opts.refreshInterval) : undefined
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      if (timer) clearInterval(timer)
    }
  }, [entry, refresh, opts.refreshInterval])

  return {
    ...(snap.data !== undefined ? { data: snap.data as T } : {}),
    ...(snap.error ? { error: snap.error } : {}),
    isLoading: active ? snap.isLoading : false,
    refresh,
  }
}

export interface ReadHookOptions extends HookOptions {
  policy?: Policy
}

/**
 * Proven balance for an address, cached and shared across components.
 * @example const { data, error, isLoading } = useVerifiedBalance('0x…')
 */
export function useVerifiedBalance(address: string | null | undefined, opts: ReadHookOptions = {}): QueryState<VerifiedResult<bigint>> {
  const key = address ? `readBalance:${address.toLowerCase()}:${JSON.stringify(opts.policy ?? null)}` : null
  const fetcher = useCallback((c: VeriqClient) => c.readBalance({ address: address ?? '', ...(opts.policy ? { policy: opts.policy } : {}) }), [address, opts.policy])
  return useVeriqQuery(key, fetcher, opts)
}

/**
 * Proven storage slot value.
 * @example const { data } = useVerifiedStorage(contract, '0x0')
 */
export function useVerifiedStorage(address: string | null | undefined, slot: string | null | undefined, opts: ReadHookOptions = {}): QueryState<VerifiedResult<Hex>> {
  const key = address && slot ? `readStorage:${address.toLowerCase()}:${slot}:${JSON.stringify(opts.policy ?? null)}` : null
  const fetcher = useCallback(
    (c: VeriqClient) => c.readStorage({ address: address ?? '', slot: slot ?? '', ...(opts.policy ? { policy: opts.policy } : {}) }),
    [address, slot, opts.policy],
  )
  return useVeriqQuery(key, fetcher, opts)
}

/**
 * Engine health, polled every 5 s by default.
 * @example const { data, error } = useVeriqHealth()
 */
export function useVeriqHealth(opts: HookOptions = {}): QueryState<EngineHealth> {
  const fetcher = useCallback((c: VeriqClient) => c.health(), [])
  return useVeriqQuery('health', fetcher, { refreshInterval: 5000, ...opts })
}

/**
 * A stored Trust Receipt by request id.
 * @example const { data: receipt } = useReceipt(id)
 */
export function useReceipt(id: string | null | undefined, opts: HookOptions = {}): QueryState<TrustReceipt> {
  const fetcher = useCallback((c: VeriqClient) => c.getReceipt(id ?? ''), [id])
  return useVeriqQuery(id ? `receipt:${id}` : null, fetcher, opts)
}
