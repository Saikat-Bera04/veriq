import type { Policy } from './types'

/**
 * Only proven answers, pinned to finalized blocks. The default.
 * @example createVeriq({ policy: verifiedFinalized })
 */
export const verifiedFinalized: Policy = Object.freeze({
  verification: 'required',
  privacy: 'off',
  consistency: 'single',
  blockPolicy: 'finalized',
  timeoutMs: 8000,
})

/**
 * Like verifiedFinalized, and also asks a second provider at the same block (recorded as agree / divergent).
 * @example veriq.withPolicy(verifiedCompare)
 */
export const verifiedCompare: Policy = Object.freeze({ ...verifiedFinalized, consistency: 'compare' })

/**
 * Verified and private: only private-transport providers. Fails with PRIVACY_UNAVAILABLE rather than sending direct.
 * @example veriq.readBalance({ address, policy: privateVerified })
 */
export const privateVerified: Policy = Object.freeze({ ...verifiedFinalized, privacy: 'required' })

/**
 * For local development without a synced light client: returns `unverified` receipts instead of failing.
 * @example createVeriq({ policy: devUnverified })
 */
export const devUnverified: Policy = Object.freeze({
  verification: 'preferred',
  privacy: 'off',
  consistency: 'single',
  blockPolicy: 'finalized',
  timeoutMs: 8000,
})

/**
 * All presets by name.
 * @example presets.verifiedFinalized
 */
export const presets = { verifiedFinalized, verifiedCompare, privateVerified, devUnverified } as const
export type PresetName = keyof typeof presets
