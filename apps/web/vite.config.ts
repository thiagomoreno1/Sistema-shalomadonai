import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { getSupabaseConfigurationError, isPublishableKey, isValidSupabaseUrl } from './src/lib/supabaseConfig.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const supabaseUrl = env.VITE_SUPABASE_URL?.trim() ?? ''
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
  const chatwootDashboardUrl = env.VITE_CHATWOOT_DASHBOARD_URL?.trim() ?? ''
  const validUrl = isValidSupabaseUrl(supabaseUrl)
  const validKey = isPublishableKey(publishableKey)
  const configError = getSupabaseConfigurationError(supabaseUrl, publishableKey) ?? ''
  let validChatwootDashboardUrl = ''
  let chatwootDashboardConfigError = ''

  if (chatwootDashboardUrl) {
    try {
      const parsedUrl = new URL(chatwootDashboardUrl)
      const secureProtocol = parsedUrl.protocol === 'https:'
      const localHttp = parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname)
      const isAppPath = /^\/app(?:\/|$)/.test(parsedUrl.pathname)
      const hasCredentialsOrQuery = Boolean(parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash)

      if ((!secureProtocol && !localHttp) || !isAppPath || hasCredentialsOrQuery) {
        chatwootDashboardConfigError = 'VITE_CHATWOOT_DASHBOARD_URL precisa ser HTTPS (ou HTTP local em localhost), apontar para /app e não conter credenciais, consulta ou fragmento.'
      } else {
        validChatwootDashboardUrl = parsedUrl.toString().replace(/\/+$/, '')
      }
    } catch {
      chatwootDashboardConfigError = 'VITE_CHATWOOT_DASHBOARD_URL precisa ser uma URL válida do painel Chatwoot.'
    }
  }

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 3000,
      strictPort: true,
    },
    // Do not expose arbitrary VITE_ values. Inject only validated public configuration.
    envPrefix: [],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(validUrl ? supabaseUrl : ''),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(validKey ? publishableKey : ''),
      'import.meta.env.VITE_SUPABASE_CONFIG_ERROR': JSON.stringify(configError),
      'import.meta.env.VITE_CHATWOOT_DASHBOARD_URL': JSON.stringify(validChatwootDashboardUrl),
      'import.meta.env.VITE_CHATWOOT_DASHBOARD_CONFIG_ERROR': JSON.stringify(chatwootDashboardConfigError),
    },
  }
})
