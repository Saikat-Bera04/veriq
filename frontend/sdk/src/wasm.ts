/**
 * The Veriq proof verifier compiled to WebAssembly (backend/crates/verifier-wasm), for checking
 * proofs in the browser (S5). It runs the same Rust code as the engine's own reads.
 *
 * The .wasm ships with this package as `veriq-client/verifier.wasm` (~205 KB, ~78 KB gzip).
 * Load it once, lazily:
 *
 * @example
 * import wasmUrl from 'veriq-client/verifier.wasm?url' // Vite; any URL or bytes work
 * const verifier = await loadVerifier(wasmUrl)
 * verifier.verifyRead({ stateRoot, address, kind: 'balance', proof }) // { ok: true, value: '0x…' }
 */
import { ERROR_CODES, VeriqError } from './errors'

/** The ABI this SDK speaks (crates/verifier-wasm `ABI_VERSION`). */
export const VERIFIER_ABI_VERSION = 2

export interface VerifyReadInput {
  /** The trusted state root the proof must chain to. */
  stateRoot: string
  address: string
  kind: 'balance' | 'nonce' | 'storage' | 'code'
  slot?: string
  /** The raw `eth_getProof` result. */
  proof: unknown
  /** The raw `eth_getCode` result (kind `code`). */
  code?: unknown
}

/** `value`: a `0x` quantity (balance, nonce, storage) or the bytecode (code). */
export type VerifyReadOutcome =
  | { ok: true; value: string }
  | { ok: false; code: 'INVALID_PROOF' | 'INVALID_REQUEST' | 'INTERNAL_ERROR' | string; error: string }

export interface BrowserVerifier {
  /** Check one read exactly as the engine does. Never throws for a bad proof: see `ok`. */
  verifyRead(input: VerifyReadInput): VerifyReadOutcome
  /** The engine's receipt binding: keccak256(method || canonical JSON), lowercase hex. */
  binding(method: string, value: unknown): string
  readonly abiVersion: number
}

/** Something the verifier can be loaded from. */
export type VerifierSource = string | URL | Response | ArrayBuffer | ArrayBufferView | WebAssembly.Module

interface Exports {
  memory: WebAssembly.Memory
  veriq_alloc(len: number): number
  veriq_free(ptr: number, len: number): void
  veriq_abi_version(): number
  veriq_verify_read(ptr: number, len: number): bigint
  veriq_binding(ptr: number, len: number): bigint
}

/** The WebAssembly verifier could not be loaded or does not speak this SDK's ABI. */
export class VerifierUnavailableError extends VeriqError {
  constructor(message: string, cause?: unknown) {
    super(ERROR_CODES.INTERNAL_ERROR, message, {
      cause,
      hint: 'The browser verifier did not load; the engine still verifies every proof.',
    })
  }
}

async function bytesOf(source: VerifierSource): Promise<ArrayBuffer | ArrayBufferView | WebAssembly.Module> {
  if (typeof source === 'string' || source instanceof URL) {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.arrayBuffer()
  }
  if (typeof Response !== 'undefined' && source instanceof Response) return source.arrayBuffer()
  return source as ArrayBuffer | ArrayBufferView | WebAssembly.Module
}

/** Load and check the verifier. Rejects with {@link VerifierUnavailableError}. */
export async function loadVerifier(source: VerifierSource): Promise<BrowserVerifier> {
  let exports: Exports
  try {
    const bytes = await bytesOf(source)
    const instance =
      bytes instanceof WebAssembly.Module
        ? await WebAssembly.instantiate(bytes, {})
        : (await WebAssembly.instantiate(bytes as BufferSource, {})).instance
    exports = instance.exports as unknown as Exports
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new VerifierUnavailableError(`the browser verifier could not be loaded: ${reason}`, err)
  }
  const abiVersion = typeof exports.veriq_abi_version === 'function' ? exports.veriq_abi_version() : 1
  if (abiVersion !== VERIFIER_ABI_VERSION || typeof exports.veriq_verify_read !== 'function') {
    throw new VerifierUnavailableError(`the browser verifier speaks ABI ${abiVersion}, this SDK needs ${VERIFIER_ABI_VERSION}`)
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  function call(fn: (ptr: number, len: number) => bigint, request: unknown): Record<string, unknown> {
    const input = encoder.encode(JSON.stringify(request))
    const ptr = exports.veriq_alloc(input.length)
    new Uint8Array(exports.memory.buffer, ptr, input.length).set(input)
    let packed: bigint
    try {
      packed = fn(ptr, input.length)
    } finally {
      exports.veriq_free(ptr, input.length)
    }
    const outPtr = Number(packed >> 32n)
    const outLen = Number(packed & 0xffffffffn)
    // Copy before freeing; memory.buffer may be replaced if the module grows its memory.
    const text = decoder.decode(new Uint8Array(exports.memory.buffer, outPtr, outLen).slice())
    exports.veriq_free(outPtr, outLen)
    return JSON.parse(text) as Record<string, unknown>
  }

  return {
    abiVersion,
    verifyRead(input) {
      const { stateRoot, address, kind, slot, proof, code } = input
      const out = call(exports.veriq_verify_read, { stateRoot, address, kind, slot, proof, code })
      if (out.ok === true && typeof out.value === 'string') return { ok: true, value: out.value }
      return { ok: false, code: String(out.code ?? 'INTERNAL_ERROR'), error: String(out.error ?? 'verification failed') }
    },
    binding(method, value) {
      const out = call(exports.veriq_binding, { method, value })
      if (out.ok !== true || typeof out.binding !== 'string') throw new VerifierUnavailableError(`binding failed: ${String(out.error)}`)
      return out.binding
    },
  }
}
