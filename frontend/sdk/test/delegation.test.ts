import { describe, expect, it } from 'vitest'
import {
  EIP7702_PREFIX,
  InvalidRequestError,
  classifyAccountCode,
  createVeriq,
  parseDelegationDesignator,
  verifiedFinalized,
} from 'veriq-client'
import { ADDRESS, mockEngine, receiptFixture } from './helpers'

const DELEGATE = '0x1242c562946c926a6d0012acb54d9413a54a1ca4'
const VALID_DESIGNATOR = `${EIP7702_PREFIX}${DELEGATE.slice(2)}`
const REVOKED_DESIGNATOR = `${EIP7702_PREFIX}${'0'.repeat(40)}`
const CONTRACT_CODE = '0x6001600055'

describe('EIP-7702 Delegation Parser & Classifier', () => {
  it('parses valid 23-byte delegation designator', () => {
    const res = parseDelegationDesignator(VALID_DESIGNATOR)
    expect(res.isDesignator).toBe(true)
    expect(res.delegate).toBe(DELEGATE)
    expect(res.isRevoked).toBe(false)
    expect(res.isMalformed).toBe(false)

    const classified = classifyAccountCode(VALID_DESIGNATOR)
    expect(classified.isDelegated).toBe(true)
    expect(classified.delegateAddress).toBe(DELEGATE)
    expect(classified.status).toEqual({ status: 'delegated', delegate: DELEGATE })
  })

  it('detects revoked / cleared delegation', () => {
    const res = parseDelegationDesignator(REVOKED_DESIGNATOR)
    expect(res.isDesignator).toBe(false)
    expect(res.delegate).toBe(null)
    expect(res.isRevoked).toBe(true)
    expect(res.isMalformed).toBe(false)

    const classified = classifyAccountCode(REVOKED_DESIGNATOR)
    expect(classified.isDelegated).toBe(false)
    expect(classified.delegateAddress).toBe(null)
    expect(classified.status).toEqual({ status: 'revoked' })
  })

  it('classifies normal EOA with empty code', () => {
    for (const code of ['', '0x']) {
      const res = parseDelegationDesignator(code)
      expect(res.isDesignator).toBe(false)
      expect(res.delegate).toBe(null)
      expect(res.isRevoked).toBe(false)
      expect(res.isMalformed).toBe(false)

      const classified = classifyAccountCode(code)
      expect(classified.isDelegated).toBe(false)
      expect(classified.delegateAddress).toBe(null)
      expect(classified.status).toEqual({ status: 'normal-eoa' })
    }
  })

  it('classifies standard smart contract code', () => {
    const res = parseDelegationDesignator(CONTRACT_CODE)
    expect(res.isDesignator).toBe(false)
    expect(res.delegate).toBe(null)
    expect(res.isRevoked).toBe(false)
    expect(res.isMalformed).toBe(false)

    const classified = classifyAccountCode(CONTRACT_CODE)
    expect(classified.isDelegated).toBe(false)
    expect(classified.delegateAddress).toBe(null)
    expect(classified.status).toEqual({ status: 'contract' })
  })

  it('rejects malformed designator (wrong lengths)', () => {
    // 22 bytes (44 hex chars + 0x)
    const tooShort = `${EIP7702_PREFIX}${'42'.repeat(19)}`
    // 24 bytes (48 hex chars + 0x)
    const tooLong = `${EIP7702_PREFIX}${'42'.repeat(21)}`

    for (const code of [tooShort, tooLong]) {
      const res = parseDelegationDesignator(code)
      expect(res.isDesignator).toBe(false)
      expect(res.isMalformed).toBe(true)

      const classified = classifyAccountCode(code)
      expect(classified.isDelegated).toBe(false)
      expect(classified.status).toEqual({ status: 'invalid-designator' })
    }
  })

  it('handles case-insensitivity in hex strings', () => {
    const upper = `${EIP7702_PREFIX.toUpperCase()}${DELEGATE.slice(2).toUpperCase()}`
    const res = parseDelegationDesignator(upper)
    expect(res.isDesignator).toBe(true)
    expect(res.delegate).toBe(DELEGATE)
  })
})

describe('veriq.getDelegation', () => {
  it('calls veriq_getDelegation and validates the result and receipt', async () => {
    const receipt = receiptFixture({
      warnings: [
        {
          code: 'EIP7702_DELEGATION_DETECTED',
          message: `EIP-7702 delegation active: calls execute code from ${DELEGATE}`,
        },
      ],
    })

    const delegationResult = {
      address: ADDRESS,
      status: { status: 'delegated', delegate: DELEGATE },
      isDelegated: true,
      delegateAddress: DELEGATE,
      codeHash: `0x${'5'.repeat(64)}`,
      delegateCodeHash: `0x${'6'.repeat(64)}`,
      securityClassification: 'delegation-detected',
      blockNumber: 7412903,
      verified: true,
      receipt,
    }

    const { fetch, calls } = mockEngine((method) => {
      if (method === 'veriq_getDelegation') {
        return { result: delegationResult }
      }
      return { error: { code: -32601, message: 'Method not found' } }
    })

    const veriq = createVeriq({ fetch })
    const res = await veriq.getDelegation({ address: ADDRESS })

    expect(calls[0]).toEqual({
      method: 'veriq_getDelegation',
      params: [ADDRESS, verifiedFinalized],
    })

    expect(res.address).toBe(ADDRESS)
    expect(res.isDelegated).toBe(true)
    expect(res.delegateAddress).toBe(DELEGATE)
    expect(res.securityClassification).toBe('delegation-detected')
    expect(res.verified).toBe(true)
    expect(res.receipt.warnings[0]?.code).toBe('EIP7702_DELEGATION_DETECTED')
  })

  it('rejects an invalid address before making a fetch', async () => {
    const { fetch, mock } = mockEngine(() => ({ result: {} }))
    const veriq = createVeriq({ fetch })
    await expect(veriq.getDelegation({ address: '0xinvalid' })).rejects.toBeInstanceOf(
      InvalidRequestError,
    )
    expect(mock).not.toHaveBeenCalled()
  })
})
