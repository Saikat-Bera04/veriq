/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENGINE_URL?: string
  readonly VITE_ENGINE_ADMIN_URL?: string
  readonly VITE_ATTACKER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
