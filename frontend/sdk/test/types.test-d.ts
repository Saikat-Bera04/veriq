import { describe, expectTypeOf, it } from 'vitest'
import { createVeriq, type TrustReceipt, type VerifiedResult } from 'veriq-client'

describe('public types', () => {
  const veriq = createVeriq()

  it('readBalance returns a bigint value', () => {
    expectTypeOf(veriq.readBalance).returns.resolves.toEqualTypeOf<VerifiedResult<bigint>>()
    expectTypeOf<Awaited<ReturnType<typeof veriq.readBalance>>['value']>().toEqualTypeOf<bigint>()
  })

  it('readStorage returns a 0x-string value', () => {
    expectTypeOf<Awaited<ReturnType<typeof veriq.readStorage>>['value']>().toEqualTypeOf<`0x${string}`>()
  })

  it('getReceipt returns a TrustReceipt', () => {
    expectTypeOf(veriq.getReceipt).returns.resolves.toEqualTypeOf<TrustReceipt>()
    expectTypeOf<TrustReceipt['verification']['status']>().toEqualTypeOf<'verified' | 'unverified' | 'unsupported'>()
  })
})
