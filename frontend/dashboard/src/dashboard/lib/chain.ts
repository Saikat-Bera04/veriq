/**
 * S6: which chain the dashboard reads, and everything that follows from it. `VITE_CHAIN` picks
 * one; the private network, the providers and browser Helios all come from that choice, and
 * the engine at VITE_ENGINE_URL must be started for the same chain (VERIQ_NETWORK), or private
 * reads fail with ChainMismatchError.
 *
 * Sepolia → Nox. Mainnet → Nym (mixFetch in the browser). `VITE_ANON_NETWORK` may name another
 * network allowed for the chain (mainnet: `tor`), but a network the chain does not allow is
 * refused, and the browser has no Tor fetch: asking for it is a typed failure, never direct.
 */
import type { PrivateProvider } from 'veriq-client'

export type ChainName = 'sepolia' | 'mainnet'

export interface ChainConfig {
  name: ChainName
  chainId: number
  /** The anonymizing network used unless VITE_ANON_NETWORK says otherwise. */
  defaultNetwork: 'nox' | 'nym'
  /** Keyless providers that serve eth_getProof at the finalized block, tried in order. */
  providers: PrivateProvider[]
  helios: {
    network: ChainName
    /** Beacon API with light-client endpoints, reached through the anonymizing network. */
    consensus: string
    /** checkpointz instance (another operator than `consensus`) for the bootstrap checkpoint. */
    checkpointSource: string
  }
}

export const CHAINS: Record<ChainName, ChainConfig> = {
  sepolia: {
    name: 'sepolia',
    chainId: 11155111,
    defaultNetwork: 'nox',
    // ethpandaops first: on 2026-11-06 PublicNode refused every finalized-block proof (4444).
    providers: [
      { label: 'ethpandaops', url: 'https://rpc.sepolia.ethpandaops.io' },
      { label: 'publicnode', url: 'https://ethereum-sepolia-rpc.publicnode.com' },
    ],
    helios: {
      network: 'sepolia',
      consensus: 'https://lodestar-sepolia.chainsafe.io',
      checkpointSource: 'https://checkpoint-sync.sepolia.ethpandaops.io',
    },
  },
  mainnet: {
    name: 'mainnet',
    chainId: 1,
    defaultNetwork: 'nym',
    // All three answered finalized and block-hash eth_getProof through Nym on 2026-11-06.
    providers: [
      { label: 'publicnode', url: 'https://ethereum-rpc.publicnode.com' },
      { label: 'drpc', url: 'https://eth.drpc.org' },
      { label: 'blastapi', url: 'https://eth-mainnet.public.blastapi.io' },
    ],
    helios: {
      network: 'mainnet',
      consensus: 'https://lodestar-mainnet.chainsafe.io',
      checkpointSource: 'https://sync-mainnet.beaconcha.in',
    },
  },
}

/** Thrown for a VITE_CHAIN that is neither sepolia nor mainnet. */
export class UnknownChainError extends Error {
  override name = 'UnknownChainError'
}

/** `VITE_CHAIN` (default sepolia). Read at call time. */
export function currentChain(): ChainConfig {
  const raw = String(import.meta.env.VITE_CHAIN ?? '').trim().toLowerCase()
  if (!raw) return CHAINS.sepolia
  const chain = CHAINS[raw as ChainName]
  if (!chain) throw new UnknownChainError('VITE_CHAIN must be sepolia or mainnet')
  return chain
}

/** `VITE_ANON_NETWORK`, else the chain's default. Checked against the chain where it is used. */
export function anonNetwork(): string {
  const raw = String(import.meta.env.VITE_ANON_NETWORK ?? '').trim().toLowerCase()
  if (raw) return raw
  try {
    return currentChain().defaultNetwork
  } catch {
    return 'nox'
  }
}
