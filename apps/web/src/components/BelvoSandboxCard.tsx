import { useEffect, useRef, useState, type FormEvent } from 'react'
import { canManageBusiness, useBusiness } from '../business/BusinessContext'
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
  owned?: boolean
  verified?: boolean
  institution?: string
  status?: string
}

type DeletedLink = {
  deleted?: boolean
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
    BELVO_SANDBOX_LINK_STATE_SECRET: 'chave secreta estável para proteger o vínculo de teste',
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
  const [verifiedLinkId, setVerifiedLinkId] = useState<string | null>(null)
  const [deletingLink, setDeletingLink] = useState(false)
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
      if (!data?.owned) throw new Error('A Belvo não confirmou que este vínculo foi criado nesta sessão.')
      setVerifiedLink(data)
      setVerifiedLinkId(linkId)
      setPendingLinkId(null)
      if (data.verified) {
        setCallbackMessage('Vínculo de teste confirmado. Nenhuma movimentação foi importada.')
      } else {
        setCallbackMessageIsWarning(true)
        setCallbackMessage(`A Belvo encontrou o vínculo de teste, mas informou o estado “${data.status ?? 'não confirmado'}”. Você pode excluí-lo nesta sessão.`)
      }
    } catch (error) {
      setCallbackMessage(null)
      setCallbackError(getMessage(error))
    }
  }

  async function deleteVerifiedLink() {
    if (!verifiedLinkId || !window.confirm('Excluir permanentemente este vínculo fictício da Belvo Sandbox?')) return
    setDeletingLink(true)
    setCallbackError(null)
    try {
      if (!supabaseClient) throw new Error('A conexão segura com o Supabase não está disponível.')
      const { data, error } = await supabaseClient.functions.invoke<DeletedLink>('belvo-open-finance', {
        body: { action: 'delete_link', business_id: businessId, link_id: verifiedLinkId },
      })
      if (error) throw error
      if (!data?.deleted) throw new Error('A Belvo não confirmou a exclusão do vínculo de teste.')
      setVerifiedLink(null)
      setVerifiedLinkId(null)
      setCallbackMessageIsWarning(false)
      setCallbackMessage('O vínculo fictício e os dados associados foram excluídos da Belvo Sandbox.')
    } catch (error) {
      setCallbackError(getMessage(error))
    } finally {
      setDeletingLink(false)
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
    const errorCode = url.searchParams.get('error') ?? url.searchParams.get('last_encountered_error_code') ?? url.searchParams.get('last_encountered_error')
    const safeErrorCode = errorCode && /^[a-zA-Z0-9_-]{1,80}$/.test(errorCode) ? errorCode : null
    const warningCode = url.searchParams.get('warning')
    const safeWarningCode = warningCode && /^[a-zA-Z0-9_-]{1,80}$/.test(warningCode) ? warningCode : null
    const callbackKey = `${callback}:${linkId ?? ''}`
    if (processedCallback.current === callbackKey) return
    processedCallback.current = callbackKey

    for (const key of ['belvo_callback', 'link', 'institution', 'last_encountered_error', 'last_encountered_error_code', 'last_encountered_error_message', 'meta_data_institution_name', 'meta_data_step', 'error', 'error_message', 'warning', 'warning_message']) {
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

    if (callback === 'warning' || (callback === 'event' && safeWarningCode)) {
      setCallbackMessageIsWarning(true)
      setCallbackMessage(`A Belvo enviou um aviso durante o teste${safeWarningCode ? ` (${safeWarningCode})` : ''}. O vínculo ainda não foi confirmado.`)
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
      if (!canManageBusiness(role)) throw new Error('Somente a gestão da empresa pode iniciar este teste.')
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
        <p className="belvo-sandbox-intro">Teste na instituição fictícia; a Belvo pedirá consentimento. Nenhum movimento será importado.</p>
        </div>
        <span className="neutral-status">Sem conta real</span>
      </div>

      <details className="belvo-sandbox-scope">
        <summary>Cuidados e detalhes do teste</summary>
        <div className="belvo-sandbox-scope-copy" role="note">
        <strong>O widget ficará restrito à instituição fictícia da Belvo Sandbox.</strong>
        <p>A Belvo pedirá seu consentimento para cadastro, contas, cartões e operações de crédito.</p>
        <p>Nesta prova, o aplicativo buscará somente dados de contas (<code>ACCOUNTS</code>). Não pediremos <code>TRANSACTIONS</code> nem importaremos extratos ou movimentos para o Shalom.</p>
        <p>O teste cria um vínculo único (<code>access_mode=single</code>). Sem configuração específica, a Belvo pode reter credenciais desse tipo de vínculo por até 365 dias. A regra <code>stale_in=1d</code> remove dados derivados após 1 dia sem atualização, mas não exclui o vínculo.</p>
        <p>Depois da confirmação, use <strong>Excluir vínculo de teste</strong> antes de sair desta tela. O Shalom não salva o ID do vínculo; se você sair sem excluir, esse botão não poderá recuperá-lo depois.</p>
        <p>Use somente a identidade fictícia indicada no <a href={BELVO_SANDBOX_GUIDE} rel="noreferrer" target="_blank">guia oficial da Belvo Sandbox</a>.</p>
        <p>O nome e o CPF fictícios serão enviados à Belvo pelo servidor para gerar o token, mas não serão salvos pelo Shalom. Não informe CPF, senha ou código de uma conta real.</p>
        </div>
      </details>

      {statusLoading && <p className="belvo-sandbox-status" role="status">Verificando a configuração segura da sandbox…</p>}
      {statusError && <div className="form-message form-message-error" role="alert">{statusError} <button className="text-button" onClick={() => void refreshStatus()} type="button">Verificar novamente</button></div>}

      {!statusLoading && !statusError && !ready && <div className="belvo-sandbox-setup" aria-live="polite">
        <h3>Configuração pendente no Supabase</h3>
        <p>O fluxo só será liberado quando os valores obrigatórios estiverem configurados como secrets do servidor. Esta tela não mostra nem guarda os secrets.</p>
        {missing.length > 0 && <ul>{missing.map((key) => <li key={key}>{formatMissingKey(key)}</li>)}</ul>}
        <button className="button button-secondary" disabled={statusLoading} onClick={() => void refreshStatus()} type="button">Atualizar configuração</button>
      </div>}

      {!statusLoading && !statusError && ready && canManageBusiness(role) && <form className="belvo-sandbox-form" onSubmit={(event) => void startSandbox(event)}>
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

      {!statusLoading && !statusError && ready && !canManageBusiness(role) && <p className="belvo-sandbox-status">Apenas a gestão da empresa pode iniciar um fluxo de consentimento de teste.</p>}

      {callbackMessage && <p className={`form-message ${callbackMessageIsWarning ? 'form-message-warning' : 'form-message-success'}`} role="status">{callbackMessage}</p>}
      {callbackError && <p className="form-message form-message-error" role="alert">{callbackError}</p>}
      {callbackError && pendingLinkId && <div className="belvo-sandbox-retry"><button className="button button-secondary" disabled={submitting} onClick={() => void verifyLink(pendingLinkId)} type="button">Tentar validar o vínculo novamente</button><small>O ID temporário fica disponível somente enquanto esta tela estiver aberta; se você sair ou atualizar, será necessário iniciar outra prova.</small></div>}
      {verifiedLink && <dl className="belvo-sandbox-result">
        <div><dt>Instituição de teste</dt><dd>{verifiedLink.institution ?? 'Confirmada pela Belvo'}</dd></div>
        <div><dt>Estado informado pela Belvo</dt><dd>{verifiedLink.status ?? 'Vínculo confirmado'}</dd></div>
      </dl>}
      {verifiedLink && canManageBusiness(role) && <div className="belvo-sandbox-retry">
        <button className="button button-secondary" disabled={deletingLink} onClick={() => void deleteVerifiedLink()} type="button">{deletingLink ? 'Excluindo vínculo…' : 'Excluir vínculo de teste'}</button>
        <small>A exclusão é permanente na Belvo Sandbox e apaga os dados associados a este vínculo fictício.</small>
      </div>}

      <p className="belvo-sandbox-next-step">Próxima etapa: buscar os movimentos bancários e permitir a conciliação.</p>
    </section>
  )
}
