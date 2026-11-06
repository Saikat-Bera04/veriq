import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { AttackLabPage } from './AttackLab'
import { INFLATED_WEI, RECEIPT, renderPage, serve, verifiedRead } from '../test/services'

const modes = () => within(screen.getByRole('radiogroup', { name: 'Attacker mode' }))

/** A live attacker whose mode the page can switch. */
function liveAttacker(extra: Parameters<typeof serve>[0] = {}) {
  let mode = 'off'
  const calls = serve({
    attackerMode: () => mode,
    setAttackerMode: (next) => {
      mode = next
      return 200
    },
    engineRpc: () => verifiedRead(),
    ...extra,
  })
  return { calls, mode: () => mode }
}

describe('Attack lab', () => {
  it('switches the attacker mode and shows what the mode does', async () => {
    const { calls, mode } = liveAttacker()
    renderPage(<AttackLabPage />)

    await waitFor(() => expect(modes().getByRole('radio', { name: 'off' }).getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(modes().getByRole('radio', { name: 'value' }))

    await waitFor(() => expect(modes().getByRole('radio', { name: 'value' }).getAttribute('aria-checked')).toBe('true'))
    expect(mode()).toBe('value')
    expect(calls.find((c) => c.method === 'POST' && c.url === '/attacker/mode')?.body).toEqual({ mode: 'value' })
    expect(screen.getByText(/Claims \+1000 ETH but sends the honest proof/)).toBeTruthy()
    expect(screen.queryByText(/Attacker not running/)).toBeNull()
  })

  it('resets the engine breakers on every mode switch, so each mode reaches the attacker', async () => {
    const { calls } = liveAttacker()
    renderPage(<AttackLabPage />)
    await waitFor(() => expect(modes().getByRole('radio', { name: 'off' }).getAttribute('aria-checked')).toBe('true'))

    for (const next of ['value', 'outage', 'proof', 'wrongblock']) {
      fireEvent.click(modes().getByRole('radio', { name: next }))
      await waitFor(() => expect(modes().getByRole('radio', { name: next }).getAttribute('aria-checked')).toBe('true'))
    }
    const order = calls.filter((c) => c.method === 'POST' && (c.url === '/attacker/mode' || c.url === '/admin/reset-breakers')).map((c) => c.url)
    // Each switch: set the mode, then reset the breakers.
    expect(order).toEqual(Array(4).fill(['/attacker/mode', '/admin/reset-breakers']).flat())
    expect(screen.getByText('Breakers reset: the next read tries the attacker again.')).toBeTruthy()
  })

  it('warns when the engine has no demo reset, and the button retries it', async () => {
    let resetStatus = 404
    liveAttacker({ resetBreakers: () => resetStatus })
    renderPage(<AttackLabPage />)
    await waitFor(() => expect(modes().getByRole('radio', { name: 'off' }).getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(modes().getByRole('radio', { name: 'value' }))
    expect(await screen.findByText(/Breakers not reset: this engine has no demo reset/)).toBeTruthy()

    resetStatus = 200
    fireEvent.click(screen.getByRole('button', { name: 'Reset breakers' }))
    expect(await screen.findByText('Breakers reset: the next read tries the attacker again.')).toBeTruthy()
  })

  it('reports a failed mode switch and keeps the current mode', async () => {
    serve({ attackerMode: () => 'off', setAttackerMode: () => 500, engineRpc: () => verifiedRead() })
    renderPage(<AttackLabPage />)

    await waitFor(() => expect(modes().getByRole('radio', { name: 'off' }).getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(modes().getByRole('radio', { name: 'proof' }))

    expect(await screen.findByText("Couldn't switch mode: POST /mode failed: HTTP 500")).toBeTruthy()
    expect(modes().getByRole('radio', { name: 'off' }).getAttribute('aria-checked')).toBe('true')
    expect(modes().getByRole('radio', { name: 'proof' }).getAttribute('aria-checked')).toBe('false')
  })

  it('shows the lie next to the proven value, with the attacker rejected', async () => {
    liveAttacker({ attackerMode: () => 'value', attackerBalance: () => ({ result: `0x${INFLATED_WEI.toString(16)}` }) })
    renderPage(<AttackLabPage />)
    await waitFor(() => expect(modes().getByRole('radio', { name: 'value' }).getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(screen.getByRole('button', { name: 'Read balance' }))

    expect(await screen.findByText('The provider proposes; the proof decides.')).toBeTruthy()
    expect(screen.getByText(/ETH that the proof does not back/)).toBeTruthy()
    expect(screen.getByText(new RegExp(`Proven at block #${RECEIPT.block.number.toLocaleString('en-US')}`))).toBeTruthy()
    expect(screen.getByText('attacker')).toBeTruthy()
    expect(screen.getByText('INVALID_PROOF')).toBeTruthy()
  })

  it('handles an attacker outage: plain RPC fails, Veriq still answers', async () => {
    liveAttacker({ attackerMode: () => 'outage', attackerBalance: () => ({ status: 503 }) })
    renderPage(<AttackLabPage />)
    await waitFor(() => expect(modes().getByRole('radio', { name: 'outage' }).getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(screen.getByRole('button', { name: 'Read balance' }))

    expect(await screen.findByText('Request failed')).toBeTruthy()
    expect(screen.getByText('HTTP 503 Service Unavailable')).toBeTruthy()
    expect(screen.getByText(new RegExp(`Proven at block #${RECEIPT.block.number.toLocaleString('en-US')}`))).toBeTruthy()
  })

  it('falls back to a simulated attacker, tagged as sample data, when it is not running', async () => {
    serve({ engineRpc: () => verifiedRead() }) // attacker unreachable
    renderPage(<AttackLabPage />)

    expect(await screen.findByText('Attacker not running: simulated in the browser.')).toBeTruthy()
    expect(screen.getByText('Sample data')).toBeTruthy()
  })
})
