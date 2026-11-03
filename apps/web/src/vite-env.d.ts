/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_SUPABASE_CONFIG_ERROR?: string
  readonly VITE_CHATWOOT_DASHBOARD_URL?: string
  readonly VITE_CHATWOOT_DASHBOARD_CONFIG_ERROR?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
