import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { rootSourceLabel } from 'veriq-client'
import { ReceiptDrawer } from './ReceiptDrawer'
import { ANON_RECEIPT, RECEIPT, healthBody, receiptRow, renderPage, serve } from '../test/services'

describe('Receipt drawer', () => {
  it('renders the real Helios-verified receipt from the store', async () => {
    serve({ health: () => healthBody, receipts: () => ({ receipts: [receiptRow] }) })
    renderPage(<ReceiptDrawer id={receiptRow.id} onClose={() => {}} />)

    const dialog = await screen.findByRole('dialog', { name: 'Trust Receipt' })
    const drawer = within(dialog)
    expect(await drawer.findByText('Verified')).toBeTruthy()
    expect(drawer.getByText(`#${RECEIPT.block.number.toLocaleString('en-US')}`, { exact: false })).toBeTruthy()
    expect(drawer.getByText('finalized')).toBeTruthy()
    // The full block hash and state root of the real receipt, as copy buttons.
    expect(drawer.getByRole('button', { name: `Copy ${RECEIPT.block.stateRoot}` })).toBeTruthy()
    expect(drawer.getByRole('button', { name: `Copy ${RECEIPT.block.hash}` })).toBeTruthy()
    expect(drawer.getByText(rootSourceLabel('local-light-client'))).toBeTruthy()
    expect(drawer.getAllByText('alchemy').length).toBeGreaterThan(0)
    // Live engine: no sample-data tag on a real receipt.
    expect(drawer.queryByText('Sample data')).toBeNull()
  })

  it('shows "anon-rpc (nox)" for a private read and "direct" for a direct one', async () => {
    const anonRow = { ...receiptRow, receipt: ANON_RECEIPT, attempts: ANON_RECEIPT.routing.attempts }
    serve({ health: () => healthBody, receipts: () => ({ receipts: [anonRow] }) })
    const { unmount } = renderPage(<ReceiptDrawer id={anonRow.id} onClose={() => {}} />)
    const drawer = within(await screen.findByRole('dialog', { name: 'Trust Receipt' }))
    expect(await drawer.findByText('anon-rpc (nox)')).toBeTruthy()
    expect(drawer.getAllByText('publicnode@anon-rpc:nox').length).toBeGreaterThan(0)
    unmount()

    serve({ health: () => healthBody, receipts: () => ({ receipts: [receiptRow] }) })
    renderPage(<ReceiptDrawer id={receiptRow.id} onClose={() => {}} />)
    const direct = within(await screen.findByRole('dialog', { name: 'Trust Receipt' }))
    expect(await direct.findByText('direct')).toBeTruthy()
    expect(direct.queryByText(/anon-rpc/)).toBeNull()
  })

  it('closes on Escape', async () => {
    serve({ health: () => healthBody, receipts: () => ({ receipts: [receiptRow] }) })
    const onClose = vi.fn()
    renderPage(<ReceiptDrawer id={receiptRow.id} onClose={onClose} />)
    await screen.findByRole('dialog', { name: 'Trust Receipt' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
