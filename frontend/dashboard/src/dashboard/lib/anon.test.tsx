import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVeriq } from 'veriq-client'
import {
  AnonUnavailableError,
  START_TIMEOUT_MS,
  getAnonStatus,
  getPrivateReader,
  parseProviders,
  resetAnonForTests,
  startAnon,
  subscribeAnon,
  type AnonState,
  type AnonWorker,
} from './anon'
import { Shell } from '../components/Shell'
import { healthBody, renderPage, serve } from '../test/services'

/** A fake Nox worker whose `ready` the test settles by hand. */
function fakeWorker() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const ready = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  const worker: AnonWorker & { closed: number } = {
    ready,
    fetch: vi.fn(async () => new Response('{}')),
    close: vi.fn(() => {
      worker.closed++
    }),
    closed: 0,
  }
  return { worker, resolve, reject }
}

function useFactory(make = fakeWorker) {
  const made: ReturnType<typeof fakeWorker>[] = []
  const factory = vi.fn(() => {
    const w = make()
    made.push(w)
    return w.worker
  })
  resetAnonForTests(factory)
  return { factory, made }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startAnon', () => {
  it('starts one worker however often it is called', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    const { factory, made } = useFactory()
    const first = startAnon()
    const second = startAnon()
    expect(second).toBe(first)
    expect(factory).toHaveBeenCalledTimes(1)
    made[0]!.resolve()
    await first
    await startAnon()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('goes idle -> connecting -> ready and records how long it took', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    const { made } = useFactory()
    const seen: AnonState[] = [getAnonStatus().state]
    const unsubscribe = subscribeAnon(() => seen.push(getAnonStatus().state))
    const started = startAnon()
    made[0]!.resolve()
    await started
    unsubscribe()
    expect(seen).toEqual(['idle', 'connecting', 'ready'])
    expect(getAnonStatus().readyMs).toBeGreaterThanOrEqual(0)
  })

  it('a failed start is a typed error, kept in the status, and the worker is closed', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    const { made } = useFactory()
    const started = startAnon()
    made[0]!.reject(new Error('specifier has no worker'))
    await expect(started).rejects.toBeInstanceOf(AnonUnavailableError)
    const status = getAnonStatus()
    expect(status.state).toBe('failed')
    expect(status.error).toBeInstanceOf(AnonUnavailableError)
    expect(status.error?.message).toMatch(/specifier has no worker/)
    expect(made[0]!.worker.closed).toBe(1)
    // The failure is captured: asking again does not start a second worker.
    await expect(startAnon()).rejects.toBeInstanceOf(AnonUnavailableError)
    expect(made).toHaveLength(1)
  })

  it('a worker that never becomes ready fails after the timeout instead of hanging', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_ANON', 'on')
    useFactory() // ready never settles
    const started = startAnon()
    const outcome = started.then(() => 'ready', (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS - 1)
    expect(getAnonStatus().state).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBeInstanceOf(AnonUnavailableError)
    expect(getAnonStatus().state).toBe('failed')
  })

  it('a worker constructor that throws is a failed start too', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    resetAnonForTests(() => {
      throw new TypeError('no iframe support')
    })
    await expect(startAnon()).rejects.toBeInstanceOf(AnonUnavailableError)
    expect(getAnonStatus().state).toBe('failed')
  })

  it('does nothing when switched off', async () => {
    const { factory } = useFactory() // VITE_ANON=off from setup.ts
    await expect(startAnon()).rejects.toBeInstanceOf(AnonUnavailableError)
    expect(factory).not.toHaveBeenCalled()
    expect(getAnonStatus().state).toBe('idle')
  })

  it('Shell starts Nox on /app load, once, even under StrictMode', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    serve({ health: () => healthBody })
    const { factory } = useFactory()
    renderPage(
      <StrictMode>
        <Shell />
      </StrictMode>,
    )
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1))
    expect(getAnonStatus().state).toBe('connecting')
  })
})

describe('getPrivateReader', () => {
  it('is created once per client, over the running worker', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    const { made } = useFactory()
    const client = createVeriq({ fetch: vi.fn() as unknown as typeof fetch })
    const pending = getPrivateReader(client)
    made[0]!.resolve()
    const reader = await pending
    expect(await getPrivateReader(client)).toBe(reader)
  })
})

describe('parseProviders', () => {
  it('defaults to PublicNode and parses label=url lists', () => {
    expect(parseProviders(undefined)).toEqual([{ label: 'publicnode', url: 'https://ethereum-sepolia-rpc.publicnode.com' }])
    expect(parseProviders('  ')).toHaveLength(1)
    expect(parseProviders('a=https://a.example, b = https://b.example/rpc')).toEqual([
      { label: 'a', url: 'https://a.example' },
      { label: 'b', url: 'https://b.example/rpc' },
    ])
  })
})
