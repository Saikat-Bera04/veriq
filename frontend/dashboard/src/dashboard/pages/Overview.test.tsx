import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { OverviewPage } from './Overview'
import { anonEngine, fakeNox, healthBody, RECEIPT, renderPage, serve } from '../test/services'

const storageReceipt = {
  ...RECEIPT,
  identity: { ...RECEIPT.identity, method: 'veriq_readStorage' },
  verification: { ...RECEIPT.verification, mechanisms: ['account-proof', 'storage-proof'] },
}

describe('Overview deployed contract read', () => {
  it('shows the live contract slot only after the SDK returns a verified proof', async () => {
    const calls = serve({
      health: () => healthBody,
      receipts: () => ({ receipts: [] }),
      engineRpc: (method) =>
        method === 'veriq_readStorage'
          ? { result: { value: '0x2a', receipt: storageReceipt, attempts: [] } }
          : { error: { code: -32601, message: 'method not found' } },
    })
    renderPage(<OverviewPage />)

    expect(await screen.findByText('42')).toBeTruthy()
    expect(screen.getByText(/Verified storage value/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open proof receipt/ })).toBeTruthy()

    await waitFor(() => {
      const request = calls.find((call) => {
        const body = call.body as { method?: string } | undefined
        return body?.method === 'veriq_readStorage'
      })
      expect(request).toBeTruthy()
    })
    const read = calls.find((call) => (call.body as { method?: string } | undefined)?.method === 'veriq_readStorage')
    const body = read?.body as { method: string; params: unknown[] }
    expect(body.method).toBe('veriq_readStorage')
    expect(body.params.slice(0, 2)).toEqual(['0x1242C562946C926a6d0012Acb54D9413A54A1CA4', '0x0'])
    expect(body.params[2]).toMatchObject({ verification: 'required', blockPolicy: 'finalized' })
  })

  it('withholds the value when the storage proof request fails', async () => {
    serve({
      health: () => healthBody,
      receipts: () => ({ receipts: [] }),
      engineRpc: () => ({ error: { code: -32000, message: 'provider unavailable' } }),
    })
    renderPage(<OverviewPage />)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/No contract value shown/)).toBeTruthy()
    expect(screen.queryByText('42')).toBeNull()
  })

  it('withholds an unverified storage value even if the RPC returned one', async () => {
    serve({
      health: () => healthBody,
      receipts: () => ({ receipts: [] }),
      engineRpc: () => ({
        result: {
          value: '0x2a',
          receipt: {
            ...storageReceipt,
            verification: { ...storageReceipt.verification, status: 'unverified' },
          },
          attempts: [],
        },
      }),
    })
    renderPage(<OverviewPage />)

    expect(await screen.findByText(/The engine did not verify this storage proof/)).toBeTruthy()
    expect(screen.queryByText('42')).toBeNull()
  })
})

describe('Overview deployed contract read through Anon-RPC', () => {
  it('reads the slot through Nox and says so; veriq_readStorage is not called', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    const calls = serve({ health: () => healthBody, receipts: () => ({ receipts: [] }), engineRpc: anonEngine() })
    const { providerCalls } = fakeNox()
    renderPage(<OverviewPage />)

    expect(await screen.findByText('42')).toBeTruthy()
    expect(screen.getByTestId('storage-transport').textContent).toBe('Fetched via anon-rpc · nox')
    const methods = calls.filter((c) => c.url === '/engine').map((c) => (c.body as { method: string }).method)
    expect(methods).toContain('veriq_verifyProof')
    expect(methods).not.toContain('veriq_readStorage')
    expect(providerCalls.map((c) => c.method)).toEqual(['eth_getProof'])
  })
})
