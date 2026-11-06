/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENGINE_URL?: string
  readonly VITE_ENGINE_ADMIN_URL?: string
  readonly VITE_ATTACKER_URL?: string
  /** `off` keeps reads on the direct engine path. Default: private reads through Nox. */
  readonly VITE_ANON?: string
  /** `label=https://url,label2=https://url2` for private reads. Default: PublicNode Sepolia. */
  readonly VITE_ANON_PROVIDERS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
