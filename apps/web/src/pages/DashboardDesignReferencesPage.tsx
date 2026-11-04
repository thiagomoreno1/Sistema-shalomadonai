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
    title: 'Indicadores primeiro',
    description: 'Abre com vendas e resultado; abaixo vêm o gráfico, a atenção do dia, a fila e os detalhes operacionais.',
    focus: 'Comparar os números do negócio antes de descer para as ações.',
    tradeoff: 'Os alertas aparecem depois do gráfico; por isso também ficam resumidos perto do topo.',
  },
  {
    id: 'trend',
    number: '02',
    title: 'Gráfico em destaque',
    description: 'O gráfico ganha mais espaço, mas retornos, entregas e vencimentos continuam visíveis logo no começo.',
    focus: 'Entender o ritmo das vendas sem perder os avisos operacionais.',
    tradeoff: 'A fila detalhada e os pedidos recentes ficam mais abaixo na rolagem.',
  },
  {
    id: 'result',
    number: '03',
    title: 'Atenção primeiro',
    description: 'Começa pelos retornos, entregas e contas a acompanhar; depois mostra resultado, gráfico e pedidos.',
    focus: 'Enxergar rapidamente o que pode travar a operação de hoje.',
    tradeoff: 'As métricas financeiras descem um pouco para dar prioridade às pendências.',
  },
  {
    id: 'hybrid',
    number: '04',
    title: 'Resumo equilibrado',
    description: 'Combina métricas e alertas na abertura, seguido por gráfico, fila de ações e detalhes do negócio.',
    focus: 'Ver desempenho e prioridades sem privilegiar só uma área.',
    tradeoff: 'Tem mais blocos no topo e exige rolar para consultar cada detalhe.',
  },
]

function MetricStub({ label, value = 'R$ —', emphasis = false }: { label: string; value?: string; emphasis?: boolean }) {
  return (
    <div className={`dashboard-reference-metric${emphasis ? ' is-emphasis' : ''}`}>
      <span>{label}</span>
      <strong aria-label={`${label}: valor não exibido na referência`}>{value}</strong>
    </div>
  )
}

function ChartPlaceholder({ kind, title, large = false }: { kind: ChartKind; title: string; large?: boolean }) {
  return (
    <div className={`dashboard-reference-chart is-${kind}${large ? ' is-large' : ''}`} role="img" aria-label={`${title}. Estrutura visual sem valores ou série de dados.`}>
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

function MetricsOverview({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`dashboard-reference-metric-grid is-three${compact ? ' is-compact' : ''}`}>
      <MetricStub emphasis label="Vendas no período" />
      <MetricStub emphasis label="Resultado gerencial" />
      <MetricStub label="Recebido no período" />
      <MetricStub label="Contas vencidas" />
      <MetricStub label="Vencem hoje" />
    </div>
  )
}

function AttentionOverview({ prominent = false }: { prominent?: boolean }) {
  return (
    <section className={`dashboard-reference-section${prominent ? ' is-attention-prominent' : ''}`} aria-label="Itens que precisam de atenção">
      <div className="dashboard-reference-section-heading"><strong>Precisa de atenção</strong><span>Atalhos para agir</span></div>
      <div className="dashboard-reference-attention-grid">
        <div className="is-followups"><span>Retornos</span><strong>—</strong><small>Atrasados ou de hoje</small></div>
        <div className="is-deliveries"><span>Entregas</span><strong>—</strong><small>Precisam de atualização</small></div>
        <div className="is-receivables"><span>Recebimentos</span><strong><small>Vencidas</small> R$ —</strong><strong><small>Vencem hoje</small> R$ —</strong></div>
        <div className="is-inventory"><span>Estoque</span><strong>—</strong><small>Produtos em atenção</small></div>
      </div>
    </section>
  )
}

function ActionQueuePreview() {
  return (
    <section className="dashboard-reference-section">
      <div className="dashboard-reference-section-heading"><strong>Fila de ações do dia</strong><span>Retornos · recebimentos · entregas</span></div>
      <ul className="dashboard-reference-action-list">
        <li><span className="is-followup">Retorno</span><span><strong>Confirmar próximo passo</strong><small>Cliente · prazo —</small></span><b>Ver →</b></li>
        <li><span className="is-receivable">Recebimento</span><span><strong>Parcela a acompanhar</strong><small>Cliente · vencimento —</small></span><b>R$ —</b></li>
        <li><span className="is-delivery">Entrega</span><span><strong>Atualizar andamento</strong><small>Pedido — · status —</small></span><b>Ver →</b></li>
      </ul>
    </section>
  )
}

function OperationalDetails() {
  return (
    <div className="dashboard-reference-operational-grid">
      <section className="dashboard-reference-section">
        <div className="dashboard-reference-section-heading"><strong>Pedidos recentes</strong><span>Ver todos →</span></div>
        <ul className="dashboard-reference-plain-list">
          <li><span><strong>Cliente · Pedido —</strong><small>Entrega · data —</small></span><b>Ativo</b></li>
          <li><span><strong>Cliente · Pedido —</strong><small>Retirada · data —</small></span><b>Ativo</b></li>
        </ul>
      </section>
      <section className="dashboard-reference-section">
        <div className="dashboard-reference-section-heading"><strong>Nível de atenção do estoque</strong><span>Ver estoque →</span></div>
        <ul className="dashboard-reference-plain-list">
          <li><span><strong>Produto abaixo do mínimo</strong><small>Saldo atual · mínimo</small></span><b>—</b></li>
          <li><span><strong>Produto em falta</strong><small>Saldo atual · unidade</small></span><b>—</b></li>
        </ul>
      </section>
    </div>
  )
}

function ResultComposition() {
  return (
    <section className="dashboard-reference-section">
      <div className="dashboard-reference-section-heading"><strong>Como o resultado é formado</strong><span>Visão gerencial</span></div>
      <div className="dashboard-reference-bridge" aria-label="Composição proposta do resultado gerencial">
        <div><span>Vendas concluídas após descontos</span><strong>R$ —</strong></div>
        <div><span>− Custo dos itens vendidos</span><strong>R$ —</strong></div>
        <div><span>− Despesas operacionais pagas</span><strong>R$ —</strong></div>
        <div><span>− Custo real de entrega</span><strong>R$ —</strong></div>
        <div className="is-total"><span>Resultado gerencial</span><strong>R$ —</strong></div>
      </div>
    </section>
  )
}

function ShortcutStrip() {
  return <div className="dashboard-reference-shortcuts" aria-label="Atalhos"><span>Atendimento</span><span>Pedidos</span><span>Estoque</span><span>Financeiro</span></div>
}

function ReferenceMockup({ id }: { id: ReferenceId }) {
  return (
    <div className={`dashboard-reference-screen dashboard-reference-full-screen is-${id}`}>
      <div className="dashboard-reference-full-heading"><PreviewHeader title="Central do dia" period="Hoje · período —" /><span>PRÉVIA COMPLETA ↓</span></div>
      {id === 'indicators' && <>
        <MetricsOverview />
        <div className="dashboard-reference-graph-block"><PreviewHeader title="Vendas ao longo do período" period="Gráfico" /><ChartPlaceholder kind="line" title="Gráfico completo de vendas ao longo do período" large /></div>
        <AttentionOverview />
        <ActionQueuePreview />
        <OperationalDetails />
        <ShortcutStrip />
      </>}
      {id === 'trend' && <>
        <AttentionOverview prominent />
        <div className="dashboard-reference-graph-block"><PreviewHeader title="Ritmo de vendas" period="Gráfico em destaque" /><ChartPlaceholder kind="bars" title="Gráfico completo para acompanhar o ritmo de vendas" large /><div className="dashboard-reference-legend"><span>Vendas</span><span>Recebimentos</span><span>Saídas pagas</span></div></div>
        <MetricsOverview compact />
        <ActionQueuePreview />
        <OperationalDetails />
        <ShortcutStrip />
      </>}
      {id === 'result' && <>
        <AttentionOverview prominent />
        <ActionQueuePreview />
        <MetricsOverview compact />
        <ResultComposition />
        <div className="dashboard-reference-graph-block"><PreviewHeader title="Tendência do período" period="Gráfico" /><ChartPlaceholder kind="line" title="Gráfico completo de tendência do período" large /></div>
        <OperationalDetails />
        <ShortcutStrip />
      </>}
      {id === 'hybrid' && <>
        <div className="dashboard-reference-balanced-top"><MetricsOverview compact /><AttentionOverview /></div>
        <div className="dashboard-reference-graph-block"><PreviewHeader title="Evolução do negócio" period="Gráfico" /><ChartPlaceholder kind="spark" title="Gráfico completo com evolução do negócio" large /></div>
        <ActionQueuePreview />
        <OperationalDetails />
        <ResultComposition />
        <ShortcutStrip />
      </>}
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
          <h1>Quatro centrais completas</h1>
          <p className="page-description">Compare a página inteira: indicadores, gráfico, retornos, entregas, vencimentos e os blocos que aparecem ao descer.</p>
        </div>
        <Link className="quiet-link dashboard-reference-back" to={backTo}><Icon name="arrow" /> {session ? 'Voltar para a Central' : 'Voltar ao acesso'}</Link>
      </header>

      <aside className="dashboard-reference-notice" aria-label="Sobre estas referências">
        <Icon name="shield" />
        <p><strong>Prévia completa, sem dados financeiros.</strong> Cada opção mostra a rolagem da Central do Dia. Os valores são marcadores e os traços dos gráficos são ilustrativos; nada é carregado ou gravado.</p>
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
      <p className="dashboard-reference-finance-note">Retornos, entregas, vencimentos e alertas de estoque aparecem em todas as opções. “Vendas”, “recebimentos” e “resultado gerencial” são indicadores diferentes; o detalhamento financeiro completo continua em Financeiro e Relatórios.</p>
    </main>
  )
}
