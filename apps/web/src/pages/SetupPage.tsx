import { Icon } from '../components/Icon'
import { supabaseConfigurationError } from '../lib/supabase'

export function SetupPage() {
  return (
    <main className="setup-screen">
      <section className="setup-card" aria-labelledby="setup-title">
        <div className="brand-lockup setup-brand"><span><strong>Arvello</strong><small>Operação</small></span></div>
        <h1 id="setup-title">Este ambiente ainda não foi conectado</h1>
        <p className="setup-copy">
          A autenticação precisa ser configurada pela pessoa responsável pela implantação antes do acesso aos dados da empresa.
        </p>
        {supabaseConfigurationError && <p className="setup-footnote" role="status">{supabaseConfigurationError}</p>}
        <div className="setup-note">
          <Icon name="shield" />
          <span>O aplicativo não carregará dados de demonstração nem criará uma sessão sem conexão segura.</span>
        </div>
        <p className="setup-footnote">Entre em contato com o suporte para concluir a configuração.</p>
      </section>
    </main>
  )
}

export function LoadingScreen({ label = 'Verificando acesso' }: { label?: string }) {
  return (
    <main className="loading-screen" aria-live="polite" aria-busy="true">
      <span className="loading-dot" aria-hidden="true" />
      <span>{label}</span>
    </main>
  )
}
