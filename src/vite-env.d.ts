/// <reference types="vite/client" />

/** Build id of this app version (vite.config.ts); /version.json has the live one. */
declare const __MP_BUILD__: string

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_ARC_CHAIN_ID: string
  readonly VITE_USDC_CONTRACT: string
  readonly VITE_ARC_EXPLORER: string
  readonly VITE_REGISTRY_BIN_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
