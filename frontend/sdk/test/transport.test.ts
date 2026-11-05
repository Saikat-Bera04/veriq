import { describe, expect, it, vi } from 'vitest'
import { createPublicClient } from 'viem'
import { sepolia } from 'viem/chains'
import { UnsupportedVerificationError, VeriqSchemaError, createVeriq } from 'veriq-client'
import { ADDRESS, happyEngine, mockEngine } from './helpers'

describe('viem transport', () => {
  it('eth_getBalance goes through the verified path and records lastReceipt', async () => {
    const { fetch, calls } = mockEngine(happyEngine)
    const onReceipt = vi.fn()
    const transport = createVeriq({ fetch }).transport({ onReceipt })
    const raw = await transport({}).request({ method: 'eth_getBalance', params: [ADDRESS, 'finalized'] })
    expect(raw).toBe('0x1bc16d674ec80000')
    expect(calls[0]?.method).toBe('veriq_readBalance')
    expect(transport.lastReceipt?.verification.status).toBe('verified')
    expect(onReceipt).toHaveBeenCalledOnce()
  })

  it('works inside createPublicClient', async () => {
    const { fetch } = mockEngine(happyEngine)
    const transport = createVeriq({ fetch }).transport()
    const client = createPublicClient({ chain: sepolia, transport })
    expect(await client.getBalance({ address: ADDRESS, blockTag: 'finalized' })).toBe(2_000_000_000_000_000_000n)
    expect(await client.getStorageAt({ address: ADDRESS, slot: '0x0', blockTag: 'finalized' })).toBe(`0x${'0'.repeat(62)}2a`)
    expect(transport.lastReceipt?.identity.method).toBe('veriq_readStorage')
  })

  it('strict mode rejects non-finalized tags before sending', async () => {
    const { fetch, mock } = mockEngine(happyEngine)
    const t = createVeriq({ fetch }).transport()
    for (const method of ['eth_getBalance', 'eth_getTransactionCount', 'eth_getCode']) {
      await expect(t({}).request({ method, params: [ADDRESS, 'latest'] })).rejects.toBeInstanceOf(UnsupportedVerificationError)
    }
    // viem's default tag is "latest": also refused before sending.
    await expect(createPublicClient({ chain: sepolia, transport: t }).getTransactionCount({ address: ADDRESS })).rejects.toThrow(/finalized/)
    expect(mock).not.toHaveBeenCalled()
  })

  it('keeps the top-level veriq receipt of eth_getTransactionCount and eth_getCode', async () => {
    const { fetch } = mockEngine(happyEngine)
    const onReceipt = vi.fn()
    const transport = createVeriq({ fetch }).transport({ onReceipt })
    const client = createPublicClient({ chain: sepolia, transport })
    expect(await client.getTransactionCount({ address: ADDRESS, blockTag: 'finalized' })).toBe(7)
    expect(transport.lastReceipt?.identity.method).toBe('eth_getTransactionCount')
    expect(await client.getCode({ address: ADDRESS, blockTag: 'finalized' })).toBe('0x6001')
    expect(transport.lastReceipt?.identity.method).toBe('eth_getCode')
    expect(onReceipt).toHaveBeenCalledTimes(2)
  })

  it('requestWithReceipt returns result and receipt; plain request still returns only the result', async () => {
    const { fetch } = mockEngine(happyEngine)
    const veriq = createVeriq({ fetch })
    const got = await veriq.requestWithReceipt('eth_getTransactionCount', [ADDRESS, 'finalized'])
    expect(got.result).toBe('0x7')
    expect(got.receipt?.verification.status).toBe('verified')
    expect(await veriq.request('eth_getTransactionCount', [ADDRESS, 'finalized'])).toBe('0x7')
    expect((await veriq.requestWithReceipt('eth_chainId')).receipt).toBeUndefined()
  })

  it('a malformed veriq receipt is a schema error, never silently dropped', async () => {
    const { fetch } = mockEngine(() => ({ result: '0x7', veriq: { identity: 'nope' } }))
    await expect(createVeriq({ fetch }).requestWithReceipt('eth_getTransactionCount', [ADDRESS, 'finalized'])).rejects.toBeInstanceOf(VeriqSchemaError)
  })

  it('forwards other methods and surfaces engine errors as typed errors', async () => {
    const { fetch, calls } = mockEngine(happyEngine)
    const t = createVeriq({ fetch }).transport()({})
    expect(await t.request({ method: 'eth_chainId' })).toBe('0xaa36a7')
    await expect(t.request({ method: 'eth_blockNumber' })).rejects.toBeInstanceOf(UnsupportedVerificationError)
    expect(calls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_blockNumber'])
  })
})
