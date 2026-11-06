import { describe, expect, it } from 'vitest'
import { footerStatus } from './footerStatus'

const health = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  chainId: 11155111,
  rootSource: 'local-light-client',
  devMode: false,
  providers: [],
  lightClient: { synced: true, finalizedNumber: 1, headNumber: 2 },
  ...over,
})

describe('footer engine status', () => {
  it('is "Helios synced" for a synced light client', () => {
    expect(footerStatus(health())).toEqual({ label: 'Helios synced', tone: 'ok' })
  })

  it('says online but unverified in dev mode, never offline', () => {
    // A dev-untrusted engine has no light client, so `synced` is false.
    const dev = health({ rootSource: 'untrusted-rpc', devMode: true, lightClient: { synced: false } })
    expect(footerStatus(dev)).toEqual({ label: 'Engine online · unverified (dev)', tone: 'warn' })
    expect(footerStatus({ ...dev, devMode: undefined })).toEqual({ label: 'Engine online · unverified (dev)', tone: 'warn' })
  })

  it('says online while the light client is still syncing (a 503 body is still the engine)', () => {
    const syncing = health({ status: 'degraded', ok: false, rootSource: null, lightClient: { synced: false } })
    expect(footerStatus(syncing)).toEqual({ label: 'Engine online · light client syncing', tone: 'warn' })
    expect(footerStatus(health({ rootSource: 'fixture', lightClient: { synced: false } })).label).toBe('Engine online · fixture root')
  })

  it('is offline when nothing, or something other than the engine, answered', () => {
    for (const body of [null, undefined, 'not json', {}, { error: 'bad gateway' }]) {
      expect(footerStatus(body)).toEqual({ label: 'Engine offline', tone: 'off' })
    }
  })
})
