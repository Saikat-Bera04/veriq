/**
 * veriq-client — verified Ethereum reads, with a receipt for every answer.
 *
 * Veriq is a local engine (http://127.0.0.1:8547) that answers Ethereum JSON-RPC on Sepolia.
 * For balance and storage reads it checks a Merkle proof against a finalized state root
 * from its own Helios light client. This SDK never verifies proofs itself: it talks to the
 * engine, validates every receipt's shape, and makes the result pleasant to use.
 *
 * @example
 * import { createVeriq } from 'veriq-client'
 * const veriq = createVeriq()
 * const { value, verified } = await veriq.readBalance({ address: '0x…' })
 */
export { createVeriq, DEFAULT_ENGINE_URL, assertAddress, assertSlot, assertPolicy, attemptsFromReceipt } from './client'
export type { VeriqClient, VeriqOptions, ReadOptions, RawResult, RootInfo, ClientProofInput, BrowserRoot } from './client'
export { createPrivateReader, PRIVATE_NETWORKS, assertNetworkForChain } from './private'
export type { PrivateReader, PrivateReaderOptions, PrivateProvider, BrowserLightClient } from './private'
export { loadVerifier, VerifierUnavailableError, VERIFIER_ABI_VERSION } from './wasm'
export type { BrowserVerifier, VerifierSource, VerifyReadInput, VerifyReadOutcome } from './wasm'
export { createTransport } from './transport'
export type { VeriqTransport, VeriqTransportOptions } from './transport'
export * from './delegation'
export * from './errors'
export * from './presets'
export * from './schema'
export type * from './types'
export { formatEth, shortHash, formatNumber, formatReceipt, receiptRows, rootSourceLabel, healthRows, statusTone } from './format'
export type { ReceiptInput, ReceiptRow, RowTone } from './format'
export { prettyReceipt, prettyHealth, prettyError, supportsColor } from './pretty'
export type { PrettyOptions } from './pretty'
