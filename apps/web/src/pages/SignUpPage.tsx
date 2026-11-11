import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabaseClient } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { Icon } from '../components/Icon'
import { SetupPage } from './SetupPage'
import { ThemeToggle } from '../components/ThemeToggle'

export function SignUpPage() {
  const { session } = useAuth()
  const { pathname } = useLocation()
  const driverSignup = pathname === '/criar-conta-entregador'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [createdWithSession, setCreatedWithSession] = useState(false)
  const [signupCompanyName, setSignupCompanyName] = useState('Arvelo')

  if (!supabaseClient) return <SetupPage />

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const client = supabaseClient
    if (!client) return
    if (password !== confirmPassword) {
      setError('As senhas não correspondem.')
      return
    }

    setSubmitting(true)
    setError(null)
    setSuccess(null)
    setCreatedWithSession(false)

    let signupOptions: { data: Record<string, string> }
    if (driverSignup) {
      signupOptions = { data: { account_type: 'delivery_driver' } }
    } else {
      const { data: businessData, error: businessError } = await client.rpc('get_signup_business')
      const signupBusiness = Array.isArray(businessData) ? businessData[0] : businessData
      if (businessError || !signupBusiness?.id) {
        setError('Não foi possível preparar o pedido de acesso. Tente novamente mais tarde.')
        setSubmitting(false)
        return
      }
      setSignupCompanyName(signupBusiness.name || 'Arvelo')
      signupOptions = { data: { requested_business_id: signupBusiness.id } }
    }

    const { data: signupData, error: signupError } = await client.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: { data: signupOptions.data },
    })

    if (signupError) {
      setError('Não foi possível criar a conta. Confira o e-mail e tente novamente.')
    } else if (signupData.session) {
      setCreatedWithSession(true)
    } else {
      setSuccess(driverSignup
        ? 'Conta criada. Se a confirmação por e-mail estiver ativa, confirme o endereço e depois entre pelo painel do entregador. A gestão também precisa vincular este e-mail ao seu cadastro de entregador.'
        : 'Conta criada. Se a confirmação por e-mail estiver ativa, confirme o endereço e depois entre para acompanhar seu pedido.')
    }
    setSubmitting(false)
  }

  if (createdWithSession) {
    return (
      <main className="auth-screen auth-screen-single">
        <section className="auth-panel recovery-card" aria-live="polite">
          <p className="auth-brand-wordmark">Arvelo</p>
          <p className="eyebrow">{driverSignup ? 'ACESSO DO ENTREGADOR' : 'PEDIDO ENVIADO'}</p>
          <h1>Conta criada</h1>
          <p className="auth-description">{driverSignup
            ? 'Peça à gestão para vincular seu e-mail ao cadastro de entregador. Depois, acesse somente as entregas atribuídas a você.'
            : `Seu pedido para acessar ${signupCompanyName} aguarda aprovação da gestão. Você ainda não consegue ver os dados da empresa.`}</p>
          <Link className="button button-primary" to={driverSignup ? '/entregador' : '/'}>{driverSignup ? 'Abrir painel do entregador' : 'Ver status do pedido'}</Link>
        </section>
      </main>
    )
  }

  if (session) {
    return (
      <main className="auth-screen auth-screen-single">
        <section className="auth-panel recovery-card" aria-labelledby="signup-active-title">
          <p className="auth-brand-wordmark">Arvelo</p>
          <p className="eyebrow">SESSÃO ATIVA</p>
          <h1 id="signup-active-title">Você já está conectado</h1>
          <p className="auth-description">Saia da conta atual antes de criar outro acesso.</p>
          <Link className="button button-primary" to="/">Ir para a operação</Link>
        </section>
      </main>
    )
  }

  return (
    <main className="auth-screen auth-screen-single">
      <section className="auth-panel recovery-card" aria-labelledby="signup-title">
        <div className="auth-theme-toggle-wrap"><ThemeToggle /></div>
        <div className="auth-form-wrap">
          <div className="brand-lockup signup-brand">
            <span><strong>Arvelo</strong><small>Operação</small></span>
          </div>
          <p className="eyebrow">{driverSignup ? 'ACESSO DA ENTREGA' : 'NOVO ACESSO'}</p>
          <h1 id="signup-title">{driverSignup ? 'Criar acesso de entregador' : 'Criar conta'}</h1>
          <p className="auth-description">{driverSignup
            ? 'Crie sua conta com seu próprio e-mail. A gestão precisa vincular esse e-mail ao seu cadastro antes de liberar o painel.'
            : 'Crie seu acesso e peça aprovação à gestão. Você verá os dados da empresa após a aprovação.'}</p>

          <form className="form-stack" onSubmit={handleSubmit}>
            <label className="field-label" htmlFor="signup-email">E-mail</label>
            <input
              autoComplete="email"
              autoCapitalize="none"
              className="text-input"
              id="signup-email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />

            <label className="field-label" htmlFor="signup-password">Senha</label>
            <input
              autoComplete="new-password"
              className="text-input"
              id="signup-password"
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />

            <label className="field-label" htmlFor="signup-confirm-password">Confirme a senha</label>
            <input
              autoComplete="new-password"
              className="text-input"
              id="signup-confirm-password"
              minLength={8}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              type="password"
              value={confirmPassword}
            />

            {error && <p className="form-message form-message-error" role="alert">{error}</p>}
            {success && <p className="form-message form-message-success" role="status">{success}</p>}

            <button className="button button-primary auth-submit" disabled={submitting} type="submit">
              {submitting ? 'Criando conta…' : driverSignup ? 'Criar conta' : 'Criar conta e pedir acesso'}
              {!submitting && <Icon name="arrow" />}
            </button>
          </form>

          <p className="auth-support">{driverSignup ? 'Depois de criar a conta, informe seu e-mail à gestão para conectar o painel.' : 'Após o pedido, entre em contato com a gestão para liberar seu acesso.'}</p>
          <Link className="auth-mode-toggle" to={driverSignup ? '/entrar?next=%2Fentregador' : '/entrar'}>Já tenho uma conta</Link>
        </div>
      </section>
    </main>
  )
}
