import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { ERROR_MEANINGS } from 'veriq-client'
import { PolicyPage } from './Policy'
import { renderPage, serve, verifiedRead } from '../test/services'

describe('Policy page', () => {
  it('shows POLICY_UNSATISFIABLE as a typed error, with no value', async () => {
    const calls = serve({
      engineRpc: (_method, params) => {
        const policy = params[1] as { blockPolicy: string }
        return policy.blockPolicy === 'latest'
          ? {
              error: {
                code: -32014,
                message: 'strict mode only serves finalized reads, got block tag latest',
                data: { code: 'POLICY_UNSATISFIABLE' },
              },
            }
          : verifiedRead()
      },
    })
    renderPage(<PolicyPage />)

    const blockPolicy = within(screen.getByRole('radiogroup', { name: 'Block policy' }))
    fireEvent.click(blockPolicy.getByRole('radio', { name: 'latest' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    const alert = within(await screen.findByRole('alert'))
    expect(alert.getByText('POLICY_UNSATISFIABLE')).toBeTruthy()
    expect(alert.getByText('-32014')).toBeTruthy()
    expect(alert.getByText(ERROR_MEANINGS.POLICY_UNSATISFIABLE)).toBeTruthy()
    expect(screen.queryByText(/ETH$/)).toBeNull()

    // The contradictory policy really went to the engine (no client-side guess).
    const sent = calls.find((c) => c.url === '/engine')?.body as { method: string; params: [string, { blockPolicy: string }] }
    expect(sent.method).toBe('veriq_readBalance')
    expect(sent.params[1].blockPolicy).toBe('latest')

    // Back to the preset: a verified receipt again.
    fireEvent.click(screen.getByRole('button', { name: 'verifiedFinalized' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(await screen.findByText('Verified')).toBeTruthy()
  })
})
