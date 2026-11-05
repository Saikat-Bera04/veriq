/**
 * The footer's engine chip, from GET /health. Whether the engine answers and whether
 * its reads are verified are separate questions: a dev-mode engine (untrusted RPC root)
 * is online but unverified, and a Helios engine that is still syncing is online too.
 */
export type FooterTone = 'ok' | 'warn' | 'off'

export interface FooterStatus {
  label: string
  tone: FooterTone
}

export const ENGINE_OFFLINE: FooterStatus = { label: 'Engine offline', tone: 'off' }
/** Before the first /health answer: never claim "offline" for an engine not yet asked. */
export const ENGINE_CHECKING: FooterStatus = { label: 'Checking engine…', tone: 'off' }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** `health` is the parsed /health body, or null when nothing (or no JSON) answered. */
export function footerStatus(health: unknown): FooterStatus {
  // Anything that is not the engine's health object (an HTML fallback page, `{}`) is offline.
  if (!isObj(health) || !('chainId' in health || 'providers' in health || 'lightClient' in health)) {
    return ENGINE_OFFLINE
  }
  const rootSource = typeof health.rootSource === 'string' ? health.rootSource : null
  if (health.devMode === true || rootSource === 'untrusted-rpc') {
    return { label: 'Engine online · unverified (dev)', tone: 'warn' }
  }
  const lc = isObj(health.lightClient) ? health.lightClient : {}
  if (lc.synced === true) return { label: 'Helios synced', tone: 'ok' }
  if (rootSource === 'fixture') return { label: 'Engine online · fixture root', tone: 'warn' }
  return { label: 'Engine online · light client syncing', tone: 'warn' }
}
