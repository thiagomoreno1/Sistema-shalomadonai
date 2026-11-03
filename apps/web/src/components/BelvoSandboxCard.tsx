import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useBusiness } from '../business/BusinessContext'
import { supabaseClient } from '../lib/supabase'

const BELVO_SANDBOX_GUIDE = 'https://developers.belvo.com/pt-br/developer_resources/resources-sandbox'

type SandboxStatus = {
  ready?: boolean
  configured?: boolean
  missing_config?: string[]
  missing_configuration?: string[]
  missing_secrets?: string[]
  message?: string
}

type WidgetResponse = {
  widget_url?: string
}

type VerifiedLink = {
  verified?: boolean
  institution?: string
  status?: string
}

function getMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return 'Não foi possível concluir a etapa da Belvo Sandbox. Tente novamente.'
}

function formatMissingKey(key: string) {
  const labels: Record<string, string> = {
    BELVO_SANDBOX_SECRET_ID: 'ID secreto da Belvo Sandbox',
    BELVO_SANDBOX_SECRET_PASSWORD: 'senha secreta da Belvo Sandbox',
    BELVO_SANDBOX_TERMS_URL: 'URL pública dos termos de uso',
    BELVO_SANDBOX_APP_ORIGIN: 'origem HTTPS pública do aplicativo',
    BELVO_SANDBOX_WEBHOOK_TOKEN: 'token de autenticação do webhook',
  }
  return labels[key] ?? key
}

export function BelvoSandboxCard() {
  const { id: businessId, role } = useBusiness()
  const [status, setStatus] = useState<SandboxStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [fullName, setFullName] = useState('')
  const [cpf, setCpf] = useState('')
  const [sandboxConfirmed, setSandboxConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [pendingLinkId, setPendingLinkId] = useState<string | null>(null)
  const [callbackMessage, setCallbackMessage] = useState<string | null>(null)
  const [callbackMessageIsWarning, setCallbackMessageIsWarning] = useState(false)
  const [callbackError, setCallbackError] = useState<string | null>(null)
  const [verifiedLink, setVerifiedLink] = useState<VerifiedLink | null>(null)
  const processedCallback = useRef<string | null>(null)

  async function verifyLink(linkId: string) {
    setPendingLinkId(linkId)
    setCallbackError(null)
    setCallbackMessageIsWarning(false)
    setCallbackMessage('Fluxo concluído. Validando o vínculo da sandbox diretamente com a Belvo…')
    try {
      if (!supabaseClient) throw new Error('A conexão segura com o Supabase não está disponível.')
      const { data, error } = await supabaseClient.functions.invoke<VerifiedLink>('belvo-open-finance', {
        body: { action: 'verify_link', business_id: businessId, link_id: linkId },
      })
      if (error) throw error
      if (!data?.verified) throw new Error('A Belvo não confirmou o vínculo de teste.')
      setVerifiedLink(data)
      setPendingLinkId(null)
      setCallbackMessage('Vínculo de teste confirmado. Nenhuma movimentação foi importada.')
    } catch (error) {
      setCallbackMessage(null)
      setCallbackError(getMessage(error))
    }
  }

  const refreshStatus = async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      if (!supabaseClient) throw new Error('A conexão segura com o Supabase não está disponível.')
      const { data, error } = await supabaseClient.functions.invoke<SandboxStatus>('belvo-open-finance', {
        body: { action: 'status', business_id: businessId },
      })
      if (error) throw error
      setStatus(data ?? {})
    } catch (error) {
      setStatusError(getMessage(error))
    } finally {
      setStatusLoading(false)
    }
  }

  useEffect(() => {
    void refreshStatus()
  }, [businessId])

  useEffect(() => {
    const url = new URL(window.location.href)
    const callback = url.searchParams.get('belvo_callback')
    if (!callback) return

    const linkId = url.searchParams.get('link')
    const errorCode = url.searchParams.get('error') ?? url.searchParams.get('last_encountered_error_code')
    const safeErrorCode = errorCode && /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : null
    const callbackKey = `${callback}:${linkId ?? ''}`
    if (processedCallback.current === callbackKey) return
    processedCallback.current = callbackKey

    for (const key of ['belvo_callback', 'link', 'institution', 'last_encountered_error_code', 'meta_data_institution_name', 'meta_data_step', 'error', 'error_message']) {
      url.searchParams.delete(key)
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)

    if (callback === 'success' && linkId) {
      void verifyLink(linkId)
      return
    }

    if (callback === 'success') {
      setCallbackError('A Belvo retornou ao sistema sem o identificador do vínculo. Nenhuma movimentação foi importada; tente novamente.')
      return
    }

    if (callback === 'exit') {
      setCallbackMessageIsWarning(true)
      setCallbackMessage(`O fluxo de teste foi encerrado antes da conclusão${safeErrorCode ? ` (${safeErrorCode})` : ''}. Nenhum dado bancário foi importado.`)
    } else if (callback === 'event') {
      setCallbackError(`A Belvo encerrou o fluxo com um erro${safeErrorCode ? ` (${safeErrorCode})` : ''}. Nenhuma movimentação foi importada; confira a configuração e tente novamente.`)
    } else {
      setCallbackError('A Belvo retornou um estado de callback inesperado. Nenhuma movimentação foi importada; volte à tela e inicie um novo teste.')
    }
  }, [businessId])

  const missing = status?.missing_config ?? status?.missing_configuration ?? status?.missing_secrets ?? []
  const ready = status?.ready ?? status?.configured ?? false

  async function startSandbox(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setCallbackError(null)
    setCallbackMessage(null)
    setCallbackMessageIsWarning(false)
    try {
      if (role !== 'owner') throw new Error('Somente uma pessoa responsável pela empresa pode iniciar este teste.')
      if (!supabaseClient) throw new Error('A conexão segura com o Supabase não está disponível.')
      const cleanName = fullName.trim()
      const cleanCpf = cpf.replace(/\D/g, '')
      if (!sandboxConfirmed) throw new Error('Confirme que está usando somente os dados fictícios do guia da Belvo Sandbox.')
      if (cleanName.length < 2 || cleanCpf.length !== 11) throw new Error('Informe o nome e o CPF fictícios fornecidos pelo guia oficial da Belvo Sandbox.')

      const { data, error } = await supabaseClient.functions.invoke<WidgetResponse>('belvo-open-finance', {
        body: { action: 'create_widget_token', business_id: businessId, full_name: cleanName, cpf: cleanCpf },
      })
      if (error) throw error
      const widgetUrl = data?.widget_url
      if (!widgetUrl) throw new Error('A Belvo não retornou a URL do widget.')
      const parsedWidgetUrl = new URL(widgetUrl)
      if (parsedWidgetUrl.protocol !== 'https:' || parsedWidgetUrl.hostname !== 'widget.belvo.io') {
        throw new Error('A URL de acesso retornada pela Belvo não passou pela validação de segurança.')
      }
      setFullName('')
      setCpf('')
      window.location.assign(parsedWidgetUrl.toString())
    } catch (error) {
      setCallbackError(getMessage(error))
      setSubmitting(false)
    }
  }

  return (
    <section className="surface-panel belvo-sandbox-card" aria-labelledby="belvo-sandbox-heading">
      <div className="belvo-sandbox-header">
        <div>
          <p className="eyebrow">OPEN FINANCE · AMBIENTE DE TESTES</p>
          <h2 id="belvo-sandbox-heading">Prova de conceito com Belvo Sandbox</h2>
        <p className="belvo-sandbox-intro">Vamos validar o consentimento e a criação de um vínculo fictício antes de planejar a importação de movimentações.</p>
        </div>
        <span className="neutral-status">Sem conta real</span>
      </div>

      <div className="belvo-sandbox-scope" role="note">
        <strong>O widget ficará restrito à instituição fictícia da Belvo Sandbox.</strong>
        <span>A Belvo solicitará somente dados de conta fictícios e configuramos retenção de 1 dia (`stale_in=1d`); não solicitaremos transações e o Shalom não importará extratos nem movimentos. A tela de consentimento exibe as permissões padrão OFDA da Belvo, mas a busca assíncrona desta prova fica limitada a `ACCOUNTS`. Use a identidade fictícia indicada no <a href={BELVO_SANDBOX_GUIDE} rel="noreferrer" target="_blank">guia oficial da Belvo Sandbox</a>. O nome e o CPF fictícios serão enviados à Belvo pelo servidor para gerar o token; não informe CPF, senha ou código de uma conta real.</span>
      </div>

      {statusLoading && <p className="belvo-sandbox-status" role="status">Verificando a configuração segura da sandbox…</p>}
      {statusError && <div className="form-message form-message-error" role="alert">{statusError} <button className="text-button" onClick={() => void refreshStatus()} type="button">Verificar novamente</button></div>}

      {!statusLoading && !statusError && !ready && <div className="belvo-sandbox-setup" aria-live="polite">
        <h3>Configuração pendente no Supabase</h3>
        <p>O fluxo só será liberado quando os valores obrigatórios estiverem configurados como secrets do servidor. Esta tela não mostra nem guarda os secrets.</p>
        {missing.length > 0 && <ul>{missing.map((key) => <li key={key}>{formatMissingKey(key)}</li>)}</ul>}
        <button className="button button-secondary" disabled={statusLoading} onClick={() => void refreshStatus()} type="button">Atualizar configuração</button>
      </div>}

      {!statusLoading && !statusError && ready && role === 'owner' && <form className="belvo-sandbox-form" onSubmit={(event) => void startSandbox(event)}>
        <h3>Iniciar teste de consentimento</h3>
        <p>Os dados fictícios são enviados uma única vez ao servidor e à Belvo para criar o token temporário do widget. Eles não são salvos pelo Shalom.</p>
        <div className="record-form-grid">
          <label className="record-field"><span className="field-label">Nome fictício da identidade</span><input autoComplete="off" className="text-input" maxLength={120} onChange={(event) => setFullName(event.target.value)} required value={fullName} /></label>
          <label className="record-field"><span className="field-label">CPF fictício da sandbox</span><input autoComplete="off" className="text-input" inputMode="numeric" maxLength={14} onChange={(event) => setCpf(event.target.value.replace(/\D/g, '').slice(0, 11))} required value={cpf} /></label>
        </div>
        <p className="belvo-sandbox-identity-note">Esta prova usa uma identidade individual fictícia. Uma conexão empresarial exigirá CNPJ e a identificação da pessoa autorizada, em uma etapa própria.</p>
        <label className="belvo-sandbox-confirm"><input checked={sandboxConfirmed} onChange={(event) => setSandboxConfirmed(event.target.checked)} type="checkbox" /> Confirmo que usei apenas os dados fictícios do guia oficial da Belvo.</label>
        <button className="button button-primary" disabled={submitting} type="submit">{submitting ? 'Preparando ambiente…' : 'Abrir teste seguro da Belvo'}</button>
      </form>}

      {!statusLoading && !statusError && ready && role !== 'owner' && <p className="belvo-sandbox-status">Apenas a pessoa responsável pela empresa pode iniciar um fluxo de consentimento de teste.</p>}

      {callbackMessage && <p className={`form-message ${callbackMessageIsWarning ? 'form-message-warning' : 'form-message-success'}`} role="status">{callbackMessage}</p>}
      {callbackError && <p className="form-message form-message-error" role="alert">{callbackError}</p>}
      {callbackError && pendingLinkId && <div className="belvo-sandbox-retry"><button className="button button-secondary" disabled={submitting} onClick={() => void verifyLink(pendingLinkId)} type="button">Tentar validar o vínculo novamente</button><small>O ID temporário fica disponível somente enquanto esta tela estiver aberta; se você sair ou atualizar, será necessário iniciar outra prova.</small></div>}
      {verifiedLink && <dl className="belvo-sandbox-result">
        <div><dt>Instituição de teste</dt><dd>{verifiedLink.institution ?? 'Confirmada pela Belvo'}</dd></div>
        <div><dt>Estado informado pela Belvo</dt><dd>{verifiedLink.status ?? 'Vínculo confirmado'}</dd></div>
      </dl>}

      <p className="belvo-sandbox-next-step">Próxima etapa após esta prova: processar webhooks, buscar transações, validar duplicidade e permitir conciliação. Nenhum movimento é gravado no histórico bancário, e o ID do vínculo e o resultado do teste ficam apenas nesta sessão; sair ou atualizar exige iniciar outra prova.</p>
    </section>
  )
}
