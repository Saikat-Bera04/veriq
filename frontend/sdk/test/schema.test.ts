import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, TrustReceiptSchema, VeriqSchemaError, createVeriq, formatIssues } from 'veriq-client'
import { mockEngine, receiptFixture } from './helpers'

describe('TrustReceipt schema', () => {
  it('accepts a receipt shaped exactly like receipt.rs', () => {
    expect(TrustReceiptSchema.parse(receiptFixture())).toEqual(receiptFixture())
  })

  it('has exactly the receipt.rs fields, in every group', () => {
    const keys = (o: object) => Object.keys(o).sort()
    const shape = TrustReceiptSchema.shape
    expect(keys(shape)).toEqual(['block', 'freshness', 'identity', 'privacy', 'routing', 'verification', 'warnings'])
    expect(keys(shape.identity.shape)).toEqual(['method', 'requestBinding', 'requestId', 'resultBinding'])
    expect(keys(shape.block.shape)).toEqual(['chainId', 'finalized', 'hash', 'number', 'stateRoot'])
    expect(keys(shape.verification.shape)).toEqual(['bootstrap', 'mechanisms', 'rootSource', 'status', 'verifierLocation'])
    expect(keys(shape.privacy.shape)).toEqual(['mechanism', 'transport'])
    expect(keys(shape.routing.shape)).toEqual(['attempts', 'comparison', 'providerLabel', 'providersTried'])
    expect(keys(shape.freshness.shape)).toEqual(['ageSeconds', 'observedAt', 'pinned'])
  })

  it('accepts an anon-rpc receipt with the network as the privacy mechanism', () => {
    const base = receiptFixture() as unknown as Record<string, Record<string, unknown>>
    const anon = {
      ...base,
      privacy: { transport: 'anon-rpc', mechanism: 'nox' },
      routing: { ...base.routing, providerLabel: 'publicnode@anon-rpc:nox' },
    }
    const parsed = TrustReceiptSchema.parse(anon)
    expect(parsed.privacy).toEqual({ transport: 'anon-rpc', mechanism: 'nox' })
    expect(parsed.routing.providerLabel).toBe('publicnode@anon-rpc:nox')
  })

  it('reports a missing stateRoot with a readable path', () => {
    const bad = receiptFixture() as unknown as { block: Record<string, unknown> }
    delete bad.block.stateRoot
    const res = TrustReceiptSchema.safeParse(bad)
    expect(res.success).toBe(false)
    if (!res.success) expect(formatIssues(res.error, bad, 'receipt')).toEqual(['receipt.block.stateRoot: expected 0x-hex, got undefined'])
  })

  it('throws VeriqSchemaError from the client on a bad engine answer', async () => {
    const bad = receiptFixture() as unknown as { block: Record<string, unknown> }
    delete bad.block.stateRoot
    const { fetch } = mockEngine(() => ({ result: { value: '0x1', receipt: bad } }))
    const err = await createVeriq({ fetch }).readBalance({ address: `0x${'1'.repeat(40)}` }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VeriqSchemaError)
    expect((err as VeriqSchemaError).issues).toEqual(['result.receipt.block.stateRoot: expected 0x-hex, got undefined'])
  })

  // fixtures/*.json are captured eth_getProof answers pinned to a Helios-finalized block.
  // Their block must fit the receipt's block fields (u64 number, B256 hash + stateRoot).
  const dir = fileURLToPath(new URL('../../../fixtures/', import.meta.url))
  const names = ['eoa.json', 'contract.json', 'absent-account.json', 'storage-slot.json']
  const present = names.filter((n) => existsSync(dir + n) && statSync(dir + n).size > 0)
  it.runIf(present.length > 0).each(present)('fixtures/%s block fits the receipt schema', (name) => {
    const data = JSON.parse(readFileSync(dir + name, 'utf8')) as { block?: unknown }
    const res = TrustReceiptSchema.shape.block.omit({ finalized: true }).safeParse(data.block)
    expect(res.success, res.success ? '' : formatIssues(res.error, data.block, 'block').join('; ')).toBe(true)
  })
})

describe('receipt.rs <-> schema.ts', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))

  it('parses the real engine receipt (fixtures/receipt-sample.json) without dropping or adding fields', () => {
    const sample = JSON.parse(readFileSync(`${root}fixtures/receipt-sample.json`, 'utf8')) as unknown
    // toEqual after parsing fails if Rust emits a field the schema doesn't know (zod strips it).
    expect(TrustReceiptSchema.parse(sample)).toEqual(sample)
  })

  it('error codes and names match backend/crates/core/src/error.rs', () => {
    const rs = readFileSync(`${root}backend/crates/core/src/error.rs`, 'utf8')
    const numbers = Object.fromEntries([...rs.matchAll(/Self::(\w+) => (-\d+),/g)].map((m) => [m[1], Number(m[2])]))
    const names = Object.fromEntries([...rs.matchAll(/Self::(\w+) => "([A-Z_]+)",/g)].map((m) => [m[1], m[2]]))
    const fromRust = Object.fromEntries(Object.keys(numbers).map((variant) => [names[variant], numbers[variant]]))
    expect(Object.keys(fromRust)).toHaveLength(10)
    expect(fromRust).toEqual(ERROR_CODES)
  })
})
