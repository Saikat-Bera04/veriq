/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENGINE_URL?: string
  readonly VITE_ENGINE_ADMIN_URL?: string
  readonly VITE_ATTACKER_URL?: string
  /** `off` keeps reads on the direct engine path. Default: private reads through Nox. */
  readonly VITE_ANON?: string
  /** `label=https://url,label2=https://url2` for private reads. Default: PublicNode Sepolia. */
  readonly VITE_ANON_PROVIDERS?: string
  /** `off` skips Helios in the browser; reads then use the engine's root alone. Default: on (needs Anon-RPC). */
  readonly VITE_BROWSER_LIGHT_CLIENT?: string
  /** Beacon API for browser Helios, reached through Nox. Default: Lodestar Sepolia. */
  readonly VITE_HELIOS_CONSENSUS_RPC?: string
  /** checkpointz instance for the bootstrap checkpoint (another operator than the beacon API). */
  readonly VITE_HELIOS_CHECKPOINT_SOURCE?: string
  /** `off`: proofs are checked by the engine only. Default: also in the browser (WebAssembly). */
  readonly VITE_BROWSER_VERIFIER?: string
  /** `sepolia` (default) or `mainnet` (S6). The engine must be started with the same VERIQ_NETWORK. */
  readonly VITE_CHAIN?: string
  /** Override the chain's private network: Sepolia `nox`; mainnet `nym` (default) or `tor` (no browser fetch). */
  readonly VITE_ANON_NETWORK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
