import { describe, expect, it, vi } from 'vitest'
import {
  AllProvidersFailedError,
  ERROR_CLASSES,
  ERROR_CODES,
  ERROR_HINTS,
  EngineUnreachableError,
  InvalidProofError,
  InvalidRequestError,
  InternalError,
  PolicyUnsatisfiableError,
  PrivacyUnavailableError,
  ProviderTimeoutError,
  RootUnavailableError,
  UnsupportedVerificationError,
  VeriqError,
  createVeriq,
  errorFromRpc,
  isVeriqError,
} from 'veriq-client'
import { ADDRESS, mockEngine } from './helpers'

const CASES = [
  [-32010, 'INVALID_PROOF', InvalidProofError],
  [-32011, 'ROOT_UNAVAILABLE', RootUnavailableError],
  [-32012, 'UNSUPPORTED_VERIFICATION', UnsupportedVerificationError],
  [-32013, 'PRIVACY_UNAVAILABLE', PrivacyUnavailableError],
  [-32014, 'POLICY_UNSATISFIABLE', PolicyUnsatisfiableError],
  [-32015, 'PROVIDER_TIMEOUT', ProviderTimeoutError],
  [-32016, 'ALL_PROVIDERS_FAILED', AllProvidersFailedError],
  [-32602, 'INVALID_REQUEST', InvalidRequestError],
  [-32603, 'INTERNAL_ERROR', InternalError],
] as const

describe('errors', () => {
  it('matches backend/crates/core/src/error.rs codes', () => {
    expect(Object.fromEntries(CASES.map(([c, n]) => [n, c]))).toEqual(ERROR_CODES)
  })

  it.each(CASES)('%i maps to %s', async (code, name, Cls) => {
    const { fetch } = mockEngine(() => ({ error: { code, message: `engine says ${name}`, data: { receiptId: 'r-9' } } }))
    const err = await createVeriq({ fetch }).readBalance({ address: ADDRESS }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Cls)
    expect(err).toBeInstanceOf(VeriqError)
    const e = err as VeriqError
    expect(e.code).toBe(code)
    expect(e.codeName).toBe(name)
    expect(e.name).toBe(Cls.name)
    expect(e.message).toBe(`engine says ${name}`)
    expect(e.hint).toBe(ERROR_HINTS[name])
    expect(e.receiptId).toBe('r-9')
    expect(ERROR_CLASSES[code]).toBe(Cls)
    expect(isVeriqError(e)).toBe(true)
  })

  it('has the documented hints and toString format', () => {
    expect(ERROR_HINTS.ROOT_UNAVAILABLE).toBe("The light client hasn't synced a finalized root yet. Wait ~1 min or check /health.")
    expect(ERROR_HINTS.POLICY_UNSATISFIABLE).toBe("latest + verification=required can't be proven. Use blockPolicy 'finalized'.")
    expect(ERROR_HINTS.ENGINE_UNREACHABLE).toBe('No Veriq engine at http://127.0.0.1:8547. Start it with: cd backend && cargo run -p veriq-server')
    const e = errorFromRpc({ code: -32014, message: 'latest + required' })
    expect(e.toString()).toBe(`VeriqError[-32014 POLICY_UNSATISFIABLE]: latest + required — ${ERROR_HINTS.POLICY_UNSATISFIABLE}`)
  })

  it('unknown codes become a plain VeriqError', () => {
    const e = errorFromRpc({ code: -31999, message: 'weird' })
    expect(e.constructor).toBe(VeriqError)
    expect(e.codeName).toBe('UNKNOWN')
  })

  it('fetch rejection -> EngineUnreachableError with the start hint', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch
    const err = await createVeriq({ fetch }).health().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineUnreachableError)
    expect((err as VeriqError).hint).toBe('No Veriq engine at http://127.0.0.1:8547. Start it with: cd backend && cargo run -p veriq-server')
    expect(String((err as Error).message)).toContain('fetch failed')
  })

  it('never leaks query strings from the engine URL', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('nope'))) as unknown as typeof globalThis.fetch
    const err = (await createVeriq({ fetch, url: 'http://127.0.0.1:8547?key=secret' }).health().catch((e: unknown) => e)) as VeriqError
    expect(err.message + err.hint).not.toContain('secret')
  })

  it('client-side timeout -> ProviderTimeoutError with a clear message', async () => {
    const fetch = vi.fn(
      (_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
    ) as unknown as typeof globalThis.fetch
    const err = await createVeriq({ fetch, timeoutMs: 20 }).readBalance({ address: ADDRESS }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderTimeoutError)
    expect((err as Error).message).toBe('No answer from the engine within 20 ms (client-side timeout)')
  })
})
