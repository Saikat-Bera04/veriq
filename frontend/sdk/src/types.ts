import type { z } from 'zod'
import type {
  AttemptOutcomeSchema,
  AttemptSchema,
  BreakerStateSchema,
  CapabilitiesSchema,
  ComparisonSchema,
  EngineHealthSchema,
  LightClientStatusSchema,
  MechanismSchema,
  PolicySchema,
  ProviderHealthSchema,
  ReceiptRecordSchema,
  RootSourceSchema,
  RoutingAttemptSchema,
  RpcErrorSchema,
  TransportKindSchema,
  TrustReceiptSchema,
  VerificationStatusSchema,
  VerifierLocationSchema,
} from './schema'

/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`
/** A 20-byte address, 0x + 40 hex characters (checked at runtime). */
export type Address = `0x${string}`

/** The Trust Receipt attached to every engine answer. Mirrors `Receipt` in receipt.rs. */
export type TrustReceipt = z.infer<typeof TrustReceiptSchema>
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>
export type RootSource = z.infer<typeof RootSourceSchema>
export type VerifierLocation = z.infer<typeof VerifierLocationSchema>
export type Mechanism = z.infer<typeof MechanismSchema>
export type TransportKind = z.infer<typeof TransportKindSchema>
export type Comparison = z.infer<typeof ComparisonSchema>

/** Request policy. See `presets` for ready-made ones. */
export type Policy = z.infer<typeof PolicySchema>
/** `RoutingAttempt` from receipt.rs (inside `receipt.routing.attempts`). */
export type RoutingAttempt = z.infer<typeof RoutingAttemptSchema>
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>
/** One provider attempt inside a read, in display form (`outcome` is "ok" or an error name). */
export type Attempt = z.infer<typeof AttemptSchema>
/** A stored receipt row from the engine's receipt store. */
export type ReceiptRecord = z.infer<typeof ReceiptRecordSchema>
export type RpcErrorObject = z.infer<typeof RpcErrorSchema>
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>
export type BreakerState = z.infer<typeof BreakerStateSchema>
export type LightClientStatus = z.infer<typeof LightClientStatusSchema>
/** GET /health */
export type EngineHealth = z.infer<typeof EngineHealthSchema>
/** veriq_getCapabilities */
export type Capabilities = z.infer<typeof CapabilitiesSchema>

/** A proven value plus its receipt. */
export interface VerifiedResult<T> {
  /** The value the proof proves (never the value a provider claimed). */
  value: T
  receipt: TrustReceipt
  /** `receipt.verification.status === "verified"` */
  verified: boolean
  /** Every provider attempt, including rejected ones. Empty if the engine didn't report them. */
  attempts: Attempt[]
}
