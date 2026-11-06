import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERIFIER_ABI_VERSION, VerifierUnavailableError, loadVerifier, type BrowserVerifier } from 'veriq-client'

/** The committed build (scripts/build-verifier-wasm.sh), exactly what the package ships. */
const WASM = fileURLToPath(new URL('../wasm/veriq_verifier.wasm', import.meta.url))
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), 'utf8')) as {
    address: string
    block: { stateRoot: string }
    proof: Record<string, unknown> & { accountProof: string[]; storageProof: { key: string; value: string; proof: string[] }[]; balance: string }
    code?: string
  }

let verifier: BrowserVerifier
const load = async () => (verifier ??= await loadVerifier(readFileSync(WASM)))
const read = (f: ReturnType<typeof fixture>, kind: 'balance' | 'nonce' | 'storage' | 'code', extra: { slot?: string; code?: unknown } = {}) =>
  verifier.verifyRead({ stateRoot: f.block.stateRoot, address: f.address, kind, proof: f.proof, ...extra })
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('loadVerifier with the shipped .wasm', () => {
  it('loads, speaks the ABI and stays small', async () => {
    const started = performance.now()
    await load()
    expect(verifier.abiVersion).toBe(VERIFIER_ABI_VERSION)
    expect(readFileSync(WASM).byteLength).toBeLessThan(300_000)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('valid proofs: EOA balance and nonce, storage slots, the demo contract slot, code, absent account, zero slot', async () => {
    await load()
    const eoa = fixture('eoa.json')
    expect(read(eoa, 'balance')).toEqual({ ok: true, value: eoa.proof.balance })
    expect(read(eoa, 'nonce')).toEqual({ ok: true, value: '0xd' })
    const slots = fixture('storage-slot.json')
    for (const p of slots.proof.storageProof) {
      const r = read(slots, 'storage', { slot: p.key })
      expect(r.ok && BigInt(r.value)).toBe(BigInt(p.value))
    }
    const demo = fixture('demo-storage.json')
    expect(read(demo, 'storage', { slot: '0x0' })).toEqual({ ok: true, value: '0x2a' })
    expect(read(demo, 'storage', { slot: '0x7' })).toEqual({ ok: true, value: '0x0' }) // exclusion proof
    expect(read(demo, 'code', { code: demo.code })).toEqual({ ok: true, value: demo.code })
    expect(read(fixture('absent-account.json'), 'balance')).toEqual({ ok: true, value: '0x0' })
  })

  it('tampered balance, tampered storage value, flipped proof byte, wrong root, uncovered slot: INVALID_PROOF', async () => {
    await load()
    const eoa = fixture('eoa.json')
    const balance = clone(eoa)
    balance.proof.balance = '0x1'
    expect(read(balance, 'balance')).toMatchObject({ ok: false, code: 'INVALID_PROOF' })

    const demo = fixture('demo-storage.json')
    const value = clone(demo)
    value.proof.storageProof[0]!.value = '0x2b'
    expect(read(value, 'storage', { slot: '0x0' })).toMatchObject({ ok: false, code: 'INVALID_PROOF' })

    const node = clone(eoa)
    const last = node.proof.accountProof.length - 1
    const leaf = node.proof.accountProof[last]!
    node.proof.accountProof[last] = leaf.slice(0, -2) + (leaf.endsWith('00') ? '01' : '00')
    expect(read(node, 'balance')).toMatchObject({ ok: false, code: 'INVALID_PROOF' })

    expect(read({ ...eoa, block: { stateRoot: `0x${'11'.repeat(32)}` } }, 'balance')).toMatchObject({ ok: false, code: 'INVALID_PROOF' })
    expect(read(fixture('storage-slot.json'), 'storage', { slot: '0x5' })).toMatchObject({ ok: false, code: 'INVALID_PROOF' })
    expect(read(demo, 'code', { code: '0x6080' })).toMatchObject({ ok: false, code: 'INVALID_PROOF' })
  })

  it('size bounds hold in WebAssembly: an oversized node is rejected', async () => {
    await load()
    const big = clone(fixture('eoa.json'))
    big.proof.accountProof[0] = `0x${'ab'.repeat(1025)}`
    expect(read(big, 'balance')).toMatchObject({ ok: false, code: 'INVALID_PROOF', error: expect.stringMatching(/limit is 1024/) })
  })

  it('bad requests are INVALID_REQUEST, never a value', async () => {
    await load()
    const eoa = fixture('eoa.json')
    expect(read(eoa, 'storage')).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(verifier.verifyRead({ stateRoot: '0x12', address: eoa.address, kind: 'balance', proof: eoa.proof })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })

  it('binding is the engine receipt binding (keccak256 hex)', async () => {
    await load()
    const b = verifier.binding('veriq_verifyProof', { a: 1 })
    expect(b).toMatch(/^[0-9a-f]{64}$/)
    expect(verifier.binding('veriq_verifyProof', { a: 1 })).toBe(b)
    expect(verifier.binding('veriq_verifyProof', { a: 2 })).not.toBe(b)
  })

  it('verifies a real proof in a few milliseconds', async () => {
    await load()
    const demo = fixture('demo-storage.json')
    const started = performance.now()
    for (let i = 0; i < 20; i++) read(demo, 'storage', { slot: '0x0' })
    expect((performance.now() - started) / 20).toBeLessThan(50)
  })

  it('a missing or wrong file is VerifierUnavailableError', async () => {
    await expect(loadVerifier(new Uint8Array([0, 1, 2, 3]))).rejects.toBeInstanceOf(VerifierUnavailableError)
    // A valid module without the verifier exports (the empty wasm module).
    await expect(loadVerifier(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).rejects.toThrow(/ABI/)
  })
})
