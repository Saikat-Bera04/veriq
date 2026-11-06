/** JSON-RPC error codes, mirroring `ErrorCode` in backend/crates/core/src/error.rs. */
export const ERROR_CODES = {
  INVALID_PROOF: -32010,
  ROOT_UNAVAILABLE: -32011,
  UNSUPPORTED_VERIFICATION: -32012,
  PRIVACY_UNAVAILABLE: -32013,
  POLICY_UNSATISFIABLE: -32014,
  PROVIDER_TIMEOUT: -32015,
  ALL_PROVIDERS_FAILED: -32016,
  ROOT_MISMATCH: -32017,
  INVALID_REQUEST: -32602,
  INTERNAL_ERROR: -32603,
} as const

/** Client-side codes (not sent by the engine). */
export const CLIENT_CODES = { ENGINE_UNREACHABLE: -1, SCHEMA_MISMATCH: -2 } as const

export type EngineErrorName = keyof typeof ERROR_CODES
export type VeriqErrorName = EngineErrorName | keyof typeof CLIENT_CODES | 'UNKNOWN'

const DEFAULT_URL = 'http://127.0.0.1:8547'

/** What each code means, in one line. */
export const ERROR_MEANINGS: Record<EngineErrorName, string> = {
  INVALID_PROOF: 'Every attempted proof failed verification against the pinned state root.',
  ROOT_UNAVAILABLE: 'No trusted root: the light client is not synced and dev mode is off.',
  UNSUPPORTED_VERIFICATION: 'This method or block tag cannot be proven under the chosen policy.',
  PRIVACY_UNAVAILABLE: 'Privacy is required but no private-transport provider is healthy. Nothing was sent.',
  POLICY_UNSATISFIABLE: 'The policy contradicts itself, e.g. "latest" blocks with verification required.',
  PROVIDER_TIMEOUT: 'The shared deadline ran out before any provider returned a valid proof.',
  ALL_PROVIDERS_FAILED: 'Every eligible provider failed or was cooling down.',
  ROOT_MISMATCH: 'Two trusted light clients (engine and browser) report different roots for the same finalized block.',
  INVALID_REQUEST: 'The request parameters are malformed (bad address, slot or policy).',
  INTERNAL_ERROR: 'The engine could not complete the request because an internal service is unavailable.',
}

/** What to do about it, in one line. */
export const ERROR_HINTS: Record<VeriqErrorName, string> = {
  INVALID_PROOF: 'Every provider sent a proof that does not match the finalized root. Add an honest provider or wait for cooldowns.',
  ROOT_UNAVAILABLE: "The light client hasn't synced a finalized root yet. Wait ~1 min or check /health.",
  UNSUPPORTED_VERIFICATION: "Veriq can't prove this method or block tag. Use blockTag 'finalized' or verification 'preferred'.",
  PRIVACY_UNAVAILABLE: "No private-transport provider is healthy. Use privacy 'preferred' or 'off'.",
  POLICY_UNSATISFIABLE: "latest + verification=required can't be proven. Use blockPolicy 'finalized'.",
  PROVIDER_TIMEOUT: 'No valid proof arrived before the deadline. Raise timeoutMs or check provider health.',
  ALL_PROVIDERS_FAILED: 'Every provider failed or is cooling down. Check veriq health for breaker states.',
  ROOT_MISMATCH: 'Nothing was verified. One light client follows a wrong chain or a bad checkpoint: check both checkpoints and consensus APIs.',
  INVALID_REQUEST: 'Check the address (0x + 40 hex), slot (0x + up to 64 hex) and policy fields.',
  INTERNAL_ERROR: 'Retry shortly; if the error persists, check the engine health endpoint.',
  ENGINE_UNREACHABLE: `No Veriq engine at ${DEFAULT_URL}. Start it with: cd backend && cargo run -p veriq-server`,
  SCHEMA_MISMATCH: 'The engine answered with a shape this SDK does not understand. Make sure SDK and engine versions match.',
  UNKNOWN: 'Unexpected engine error. Check the engine logs.',
}

export interface VeriqErrorOptions {
  data?: unknown
  receiptId?: string
  hint?: string
  cause?: unknown
}

/**
 * Base class for every error the SDK throws. Fail-closed: a failed guarantee is an error,
 * never a weaker answer.
 * @example
 * try { await veriq.readBalance({ address }) }
 * catch (e) { if (isVeriqError(e)) console.error(e.codeName, e.hint) }
 */
export class VeriqError extends Error {
  /** JSON-RPC engine code or a negative client code. */
  readonly code: number
  /** Stable name such as "POLICY_UNSATISFIABLE". */
  readonly codeName: VeriqErrorName
  /** One-line advice on what to do next. */
  readonly hint: string
  readonly data?: unknown
  /** Request id of the receipt, when the engine stored one. */
  readonly receiptId?: string

  constructor(code: number, message: string, opts: VeriqErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = new.target.name
    this.code = code
    this.codeName = nameForCode(code)
    this.hint = opts.hint ?? ERROR_HINTS[this.codeName]
    if (opts.data !== undefined) this.data = opts.data
    const rid = opts.receiptId ?? receiptIdFrom(opts.data)
    if (rid !== undefined) this.receiptId = rid
  }

  /** What the code means (for engine codes). */
  get meaning(): string {
    return this.codeName in ERROR_MEANINGS ? ERROR_MEANINGS[this.codeName as EngineErrorName] : this.message
  }

  /** `VeriqError[-32014 POLICY_UNSATISFIABLE]: message — hint` */
  override toString(): string {
    return `VeriqError[${this.code} ${this.codeName}]: ${this.message} — ${this.hint}`
  }
}

export class InvalidProofError extends VeriqError {}
export class RootUnavailableError extends VeriqError {}
export class UnsupportedVerificationError extends VeriqError {}
export class PrivacyUnavailableError extends VeriqError {}
export class PolicyUnsatisfiableError extends VeriqError {}
export class ProviderTimeoutError extends VeriqError {}
export class AllProvidersFailedError extends VeriqError {}
/** The browser light client and the engine disagree about the same finalized block. */
export class RootMismatchError extends VeriqError {}
export class InvalidRequestError extends VeriqError {}
export class InternalError extends VeriqError {}
/** The engine could not be reached (network failure, nothing listening). */
export class EngineUnreachableError extends VeriqError {}
/** The engine's answer did not match the receipt schema. `issues` lists readable paths. */
export class VeriqSchemaError extends VeriqError {
  readonly issues: string[]
  constructor(issues: string[], opts: VeriqErrorOptions = {}) {
    super(CLIENT_CODES.SCHEMA_MISMATCH, issues.join('; '), opts)
    this.issues = issues
  }
}

type ErrorClass = new (code: number, message: string, opts?: VeriqErrorOptions) => VeriqError

/** Code -> error class. */
export const ERROR_CLASSES: Record<number, ErrorClass> = {
  [ERROR_CODES.INVALID_PROOF]: InvalidProofError,
  [ERROR_CODES.ROOT_UNAVAILABLE]: RootUnavailableError,
  [ERROR_CODES.UNSUPPORTED_VERIFICATION]: UnsupportedVerificationError,
  [ERROR_CODES.PRIVACY_UNAVAILABLE]: PrivacyUnavailableError,
  [ERROR_CODES.POLICY_UNSATISFIABLE]: PolicyUnsatisfiableError,
  [ERROR_CODES.PROVIDER_TIMEOUT]: ProviderTimeoutError,
  [ERROR_CODES.ALL_PROVIDERS_FAILED]: AllProvidersFailedError,
  [ERROR_CODES.ROOT_MISMATCH]: RootMismatchError,
  [ERROR_CODES.INVALID_REQUEST]: InvalidRequestError,
  [ERROR_CODES.INTERNAL_ERROR]: InternalError,
  [CLIENT_CODES.ENGINE_UNREACHABLE]: EngineUnreachableError,
}

const ALL_CODES: Record<string, number> = { ...ERROR_CODES, ...CLIENT_CODES }

function nameForCode(code: number): VeriqErrorName {
  for (const [name, c] of Object.entries(ALL_CODES)) if (c === code) return name as VeriqErrorName
  return 'UNKNOWN'
}

/** "POLICY_UNSATISFIABLE" for -32014, undefined for unknown codes. */
export function errorNameForCode(code: number): EngineErrorName | undefined {
  const n = nameForCode(code)
  return n in ERROR_CODES ? (n as EngineErrorName) : undefined
}

function receiptIdFrom(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'receiptId' in data && typeof data.receiptId === 'string') return data.receiptId
  return undefined
}

/** Build the right subclass from a JSON-RPC error object. */
export function errorFromRpc(err: { code: number; message: string; data?: unknown }): VeriqError {
  const Cls = ERROR_CLASSES[err.code] ?? VeriqError
  return new Cls(err.code, err.message, { data: err.data })
}

/**
 * Type guard for any SDK error.
 * @example
 * if (isVeriqError(e) && e instanceof PolicyUnsatisfiableError) showFinalizedHint()
 */
export function isVeriqError(e: unknown): e is VeriqError {
  return e instanceof VeriqError
}
