import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { supabaseClient } from '../lib/supabase'
import { Icon } from '../components/Icon'
import { SetupPage } from './SetupPage'
import { ThemeToggle } from '../components/ThemeToggle'

export function SignInPage() {
  const [mode, setMode] = useState<'signin' | 'recovery'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!supabaseClient) return <SetupPage />

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const client = supabaseClient
    if (!client) return
    setSubmitting(true)
    setError(null)
    setMessage(null)

    if (mode === 'signin') {
      const { error: signInError } = await client.auth.signInWithPassword({
        email: email.trim(),
        password,
      })

      if (signInError) setError('Não foi possível entrar. Confira os dados e tente novamente.')
      setSubmitting(false)
      return
    }

    const redirectTo = new URL('/redefinir-senha', window.location.origin).toString()
    const { error: recoveryError } = await client.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    })

    if (recoveryError) {
      setError('Não foi possível solicitar a recuperação agora. Tente novamente mais tarde.')
    } else {
      setMessage('Se o e-mail estiver cadastrado, você receberá instruções para recuperar o acesso.')
    }
    setSubmitting(false)
  }

  const isRecovery = mode === 'recovery'

  return (
    <main className="auth-screen">
      <aside className="auth-intro">
        <div className="brand-lockup">
          <img className="brand-image" src="/shalom-adonai-logo.png" alt="" />
          <span>
            <strong>Shalom Adonai</strong>
            <small>Operação</small>
          </span>
        </div>
        <div className="auth-intro-copy">
          <p className="eyebrow">ACESSO DO PROPRIETÁRIO</p>
          <h1>Uma visão clara do que precisa de atenção.</h1>
          <p>Clientes, pedidos, estoque e compromissos da operação em um só lugar.</p>
        </div>
        <div className="auth-intro-footer"><Icon name="shield" /> Acesso protegido à operação</div>
      </aside>

      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-theme-toggle-wrap"><ThemeToggle /></div>
        <div className="auth-form-wrap">
          <div className="brand-lockup auth-mobile-brand">
            <img className="brand-image" src="/shalom-adonai-logo.png" alt="" />
            <span><strong>Shalom Adonai</strong><small>Operação</small></span>
          </div>
          <p className="eyebrow">BEM-VINDO</p>
          <h2 id="auth-title">{isRecovery ? 'Recuperar acesso' : 'Entrar no sistema'}</h2>
          <p className="auth-description">
            {isRecovery
              ? 'Informe o e-mail cadastrado para receber as instruções de recuperação.'
              : 'Use o e-mail e a senha fornecidos para acessar sua conta.'}
          </p>

          <form className="form-stack" onSubmit={handleSubmit}>
            <label className="field-label" htmlFor="auth-email">E-mail</label>
            <input
              autoComplete="username"
              autoCapitalize="none"
              className="text-input"
              id="auth-email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />

            {!isRecovery && (
              <>
                <label className="field-label" htmlFor="auth-password">Senha</label>
                <input
                  autoComplete="current-password"
                  className="text-input"
                  id="auth-password"
                  name="password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </>
            )}

            {error && <p className="form-message form-message-error" role="alert">{error}</p>}
            {message && <p className="form-message form-message-success" role="status">{message}</p>}

            <button className="button button-primary auth-submit" disabled={submitting} type="submit">
              {submitting ? 'Aguarde…' : isRecovery ? 'Enviar instruções' : 'Entrar'}
              {!submitting && !isRecovery && <Icon name="arrow" />}
            </button>
          </form>

          <div className="auth-mode-actions">
            <button
              className="text-button auth-mode-toggle"
              onClick={() => {
                setMode(isRecovery ? 'signin' : 'recovery')
                setError(null)
                setMessage(null)
              }}
              type="button"
            >
              {isRecovery ? 'Voltar para entrar' : 'Esqueci minha senha'}
            </button>

            {!isRecovery && <Link className="auth-mode-toggle" to="/criar-conta">Criar conta e pedir acesso</Link>}
          </div>
          <p className="auth-support">A gestão aprova novos pedidos antes de liberar os dados da empresa.</p>
        </div>
      </section>
    </main>
  )
}

export function PasswordRecoveryPage() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const { session, recovery, completeRecovery } = useAuth()

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    if (password !== confirmPassword) {
      setError('As senhas não correspondem.')
      return
    }
    setSubmitting(true)
    setError(null)

    const { error: updateError } = await supabaseClient.auth.updateUser({ password })
    setSubmitting(false)

    if (updateError) {
      setError('O link pode ter expirado. Solicite uma nova recuperação de senha.')
      return
    }

    completeRecovery()
    setSuccess(true)
  }

  if (success) {
    return (
      <main className="auth-screen auth-screen-single">
        <section className="auth-panel recovery-card" aria-live="polite">
          <img className="brand-image" src="/shalom-adonai-logo.png" alt="" />
          <p className="eyebrow">ACESSO ATUALIZADO</p>
          <h1>Senha alterada</h1>
          <p className="auth-description">Sua nova senha foi salva. Você já pode entrar no sistema.</p>
          <Link className="button button-primary" to="/">Ir para o sistema <Icon name="arrow" /></Link>
        </section>
      </main>
    )
  }

  if (!session || !recovery || !supabaseClient) {
    return (
      <main className="auth-screen auth-screen-single">
        <section className="auth-panel recovery-card" aria-labelledby="recovery-title">
          <img className="brand-image" src="/shalom-adonai-logo.png" alt="" />
          <p className="eyebrow">RECUPERAÇÃO DE ACESSO</p>
          <h1 id="recovery-title">Abra o link enviado por e-mail</h1>
          <p className="auth-description">Para definir uma nova senha, use o link mais recente enviado para o e-mail da sua conta.</p>
          <Link className="text-button" to="/entrar">Voltar para entrar</Link>
        </section>
      </main>
    )
  }

  return (
    <main className="auth-screen auth-screen-single">
      <section className="auth-panel recovery-card" aria-labelledby="recovery-title">
        <img className="brand-image" src="/shalom-adonai-logo.png" alt="" />
        <p className="eyebrow">RECUPERAÇÃO DE ACESSO</p>
        <h1 id="recovery-title">Defina uma nova senha</h1>
        <p className="auth-description">Escolha uma senha segura que você ainda não usa em outro serviço.</p>
        <form className="form-stack" onSubmit={handleSubmit}>
          <label className="field-label" htmlFor="new-password">Nova senha</label>
          <input
            autoComplete="new-password"
            className="text-input"
            id="new-password"
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <label className="field-label" htmlFor="confirm-password">Confirme a nova senha</label>
          <input
            autoComplete="new-password"
            className="text-input"
            id="confirm-password"
            minLength={8}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            type="password"
            value={confirmPassword}
          />
          {error && <p className="form-message form-message-error" role="alert">{error}</p>}
          <button className="button button-primary auth-submit" disabled={submitting} type="submit">
            {submitting ? 'Salvando…' : 'Salvar nova senha'}
          </button>
        </form>
      </section>
    </main>
  )
}
