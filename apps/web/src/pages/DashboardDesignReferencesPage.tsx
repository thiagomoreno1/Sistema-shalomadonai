import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Icon } from '../components/Icon'
import './DashboardDesignReferencesPage.css'

type ReferenceId = 'indicators' | 'trend' | 'result' | 'hybrid'
type ChartKind = 'line' | 'bars' | 'bridge' | 'spark'

const references: Array<{
  id: ReferenceId
  number: string
  title: string
  description: string
  focus: string
  tradeoff: string
}> = [
  {
    id: 'indicators',
    number: '01',
    title: 'Indicadores no topo',
    description: 'Bate o olho em vendas, recebimentos, contas vencidas e resultado; o gráfico vem logo abaixo.',
    focus: 'Leitura rápida dos principais números.',
    tradeoff: 'Exige definir qual medida de vendas deve ser chamada de faturamento.',
  },
  {
    id: 'trend',
    number: '02',
    title: 'Gráfico em destaque',
    description: 'A evolução do período ocupa a área principal. Os indicadores resumidos ficam perto do gráfico.',
    focus: 'Entender o ritmo e comparar períodos.',
    tradeoff: 'O gráfico depende de uma série confiável de vendas; recebimentos não são faturamento.',
  },
  {
    id: 'result',
    number: '03',
    title: 'Composição do resultado',
    description: 'Mostra de forma direta como vendas, custos e despesas formam o resultado gerencial.',
    focus: 'Explicar de onde vem o resultado.',
    tradeoff: 'O número só aparece quando custo dos itens e devoluções permitem um cálculo confiável.',
  },
  {
    id: 'hybrid',
    number: '04',
    title: 'Métricas junto da rotina',
    description: 'Dá prioridade às métricas e mantém retornos, vencimentos e entregas visíveis na mesma tela.',
    focus: 'Equilibrar desempenho e trabalho de hoje.',
    tradeoff: 'Reúne mais informações; no celular, a rotina fica abaixo dos indicadores.',
  },
]

function MetricStub({ label, context, emphasis = false }: { label: string; context?: string; emphasis?: boolean }) {
  return (
    <div className={`dashboard-reference-metric${emphasis ? ' is-emphasis' : ''}`}>
      <span>{label}</span>
      <strong aria-label={`${label}: valor não exibido na referência`}>R$ —</strong>
      {context && <small>{context}</small>}
    </div>
  )
}

function ChartPlaceholder({ kind, title }: { kind: ChartKind; title: string }) {
  return (
    <div className={`dashboard-reference-chart is-${kind}`} role="img" aria-label={`${title}. Estrutura visual sem valores ou série de dados.`}>
      <div className="dashboard-reference-chart-guides" aria-hidden="true"><span /><span /><span /><span /></div>
      {kind === 'bars' && <div className="dashboard-reference-bars" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div>}
      {kind === 'line' && <svg className="dashboard-reference-line" aria-hidden="true" focusable="false" viewBox="0 0 400 120" preserveAspectRatio="none"><path d="M0 92 C46 83 58 89 96 67 S153 77 194 54 S254 67 294 38 S354 48 400 21" /></svg>}
      {kind === 'spark' && <svg className="dashboard-reference-spark" aria-hidden="true" focusable="false" viewBox="0 0 180 54" preserveAspectRatio="none"><path d="M2 42 C24 38 27 14 48 23 S74 38 91 19 S119 27 137 11 S163 19 178 4" /></svg>}
      <span className="dashboard-reference-chart-note">Prévia estrutural · sem dados reais</span>
    </div>
  )
}

function PreviewHeader({ title, period = 'Período a escolher' }: { title: string; period?: string }) {
  return <div className="dashboard-reference-preview-heading"><strong>{title}</strong><span>{period}</span></div>
}

function ReferenceMockup({ id }: { id: ReferenceId }) {
  if (id === 'indicators') {
    return (
      <div className="dashboard-reference-screen is-indicators">
        <PreviewHeader title="Visão do negócio" />
        <div className="dashboard-reference-metric-grid is-two">
          <MetricStub emphasis label="Vendas no período" context="Base a confirmar" />
          <MetricStub emphasis label="Resultado gerencial" context="Fórmula já documentada" />
        </div>
        <div className="dashboard-reference-metric-grid is-two is-compact">
          <MetricStub label="Recebimentos informados" />
          <MetricStub label="Saldo vencido" />
        </div>
        <div className="dashboard-reference-graph-block">
          <PreviewHeader title="Vendas ao longo do período" period="Gráfico" />
          <ChartPlaceholder kind="line" title="Gráfico de vendas ao longo do período" />
        </div>
      </div>
    )
  }

  if (id === 'trend') {
    return (
      <div className="dashboard-reference-screen is-trend">
        <PreviewHeader title="Ritmo de vendas" />
        <div className="dashboard-reference-legend"><span>Vendas</span><span>Recebimentos</span><span>Saídas pagas</span></div>
        <ChartPlaceholder kind="bars" title="Gráfico de comparação por período" />
        <div className="dashboard-reference-metric-grid is-three is-compact">
          <MetricStub label="Vendas" />
          <MetricStub label="Recebido" />
          <MetricStub label="Saídas pagas" />
        </div>
      </div>
    )
  }

  if (id === 'result') {
    return (
      <div className="dashboard-reference-screen is-result">
        <PreviewHeader title="Resultado gerencial" />
        <div className="dashboard-reference-bridge" aria-label="Composição proposta do resultado gerencial">
          <div><span>Vendas concluídas após descontos</span><strong>R$ —</strong></div>
          <div><span>− Custo dos itens vendidos</span><strong>R$ —</strong></div>
          <div><span>− Despesas operacionais pagas</span><strong>R$ —</strong></div>
          <div><span>− Custo real de entrega</span><strong>R$ —</strong></div>
          <div className="is-total"><span>Resultado</span><strong>R$ —</strong></div>
        </div>
        <p className="dashboard-reference-caveat">Se faltar custo congelado ou houver devolução sem tratamento financeiro definido, o resultado fica indisponível.</p>
        <div className="dashboard-reference-graph-block">
          <PreviewHeader title="Movimento de caixa registrado" period="Separado do resultado" />
          <ChartPlaceholder kind="bridge" title="Estrutura do movimento financeiro registrado" />
        </div>
      </div>
    )
  }

  return (
    <div className="dashboard-reference-screen is-hybrid">
      <PreviewHeader title="Resumo e rotina de hoje" />
      <div className="dashboard-reference-hybrid-grid">
        <div className="dashboard-reference-finance-focus">
          <div className="dashboard-reference-metric-grid is-two">
            <MetricStub emphasis label="Vendas" />
            <MetricStub emphasis label="Resultado gerencial" />
          </div>
          <div className="dashboard-reference-graph-block">
            <PreviewHeader title="Tendência do período" period="Gráfico" />
            <ChartPlaceholder kind="spark" title="Linha de tendência do período" />
          </div>
        </div>
        <div className="dashboard-reference-priorities">
          <strong>Precisa de atenção</strong>
          <div><span>Retornos</span><b>—</b></div>
          <div><span>Vencimentos</span><b>—</b></div>
          <div><span>Entregas</span><b>—</b></div>
        </div>
      </div>
    </div>
  )
}

export function DashboardDesignReferencesPage() {
  const { session } = useAuth()
  const [preferred, setPreferred] = useState<ReferenceId | null>(null)
  const backTo = session ? '/' : '/entrar'

  return (
    <main className="main-content page-stack dashboard-reference-page">
      <header className="page-heading dashboard-reference-heading">
        <div>
          <p className="eyebrow">ESTUDOS VISUAIS · CENTRAL DO DIA</p>
          <h1>Quatro ideias para o início</h1>
          <p className="page-description">Compare o peso das métricas, dos gráficos e da rotina antes de escolher o painel definitivo.</p>
        </div>
        <Link className="quiet-link dashboard-reference-back" to={backTo}><Icon name="arrow" /> {session ? 'Voltar para a Central' : 'Voltar ao acesso'}</Link>
      </header>

      <aside className="dashboard-reference-notice" aria-label="Sobre estas referências">
        <Icon name="shield" />
        <p><strong>Protótipos sem dados financeiros.</strong> Esta tela não carrega dados operacionais nem grava alterações. O traço dos gráficos é apenas estrutural; valores reais entram depois que a organização do painel for escolhida.</p>
      </aside>

      <div className="dashboard-reference-grid">
        {references.map((reference) => (
          <article className={`dashboard-reference-card${preferred === reference.id ? ' is-preferred' : ''}`} key={reference.id}>
            <header className="dashboard-reference-card-heading">
              <span className="dashboard-reference-number">{reference.number}</span>
              <div><h2>{reference.title}</h2><p>{reference.description}</p></div>
            </header>

            <ReferenceMockup id={reference.id} />

            <div className="dashboard-reference-notes">
              <p><strong>Favorece:</strong> {reference.focus}</p>
              <p><strong>Trade-off:</strong> {reference.tradeoff}</p>
            </div>

            <button
              aria-pressed={preferred === reference.id}
              className="dashboard-reference-choice"
              onClick={() => setPreferred(preferred === reference.id ? null : reference.id)}
              type="button"
            >
              <Icon name={preferred === reference.id ? 'check' : 'chart'} />
              {preferred === reference.id ? 'Marcada para conversar' : 'Marcar como preferida'}
            </button>
          </article>
        ))}
      </div>

      <p className="dashboard-reference-selection" aria-live="polite">{preferred ? 'A escolha fica somente nesta tela; me diga qual opção você prefere.' : 'Você pode marcar uma opção para facilitar a conversa. A Central do dia continua igual por enquanto.'}</p>
      <p className="dashboard-reference-finance-note">O detalhamento financeiro completo continua no módulo Financeiro e em Relatórios. “Vendas”, “recebimentos” e “resultado gerencial” usam bases diferentes e não devem ser somados como se fossem o mesmo indicador.</p>
    </main>
  )
}
