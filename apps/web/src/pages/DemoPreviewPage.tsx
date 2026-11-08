import { useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Icon, type IconName } from '../components/Icon'
import { formatBRLExact, formatBusinessDate } from '../lib/formatters'
import { useBusinessToday } from '../lib/useBusinessToday'
import './DemoPreviewPage.css'

type DemoCustomer = { id: string; name: string; contact: string; kind: string; phone: string; email: string; address: string; lastOrder: string }
type DemoOrderLine = { name: string; quantity: string; totalCents: number }
type DemoOrder = { id: string; number: string; customerId: string; createdOn: string; status: string; delivery: string; totalCents: number; payment: string; lines: DemoOrderLine[] }

function day(today: string, offset: number) {
  const value = new Date(`${today}T12:00:00-03:00`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

function brl(cents: number) {
  return formatBRLExact(String(cents))
}

function stockLabel(product: (typeof products)[number]) {
  return product.stock < 0 ? `Faltam ${Math.abs(product.stock)} ${product.unit}` : `${product.stock} ${product.unit}`
}

function dateLabel(value: string) {
  return formatBusinessDate(value)
}

function getCustomers(today: string): DemoCustomer[] {
  return [
    { id: 'demo-customer-1', name: 'Mercado Boa Praça', contact: 'Paula Ribeiro', kind: 'Mercado', phone: '(21) 90000-0001', email: 'compras@boapraca.example', address: 'Fonseca · Niterói, RJ', lastOrder: day(today, 0) },
    { id: 'demo-customer-2', name: 'Condomínio Vila Verde', contact: 'Marcos Azevedo', kind: 'Condomínio', phone: '(21) 90000-0002', email: 'sindico@vilaverde.example', address: 'Icaraí · Niterói, RJ', lastOrder: day(today, -1) },
    { id: 'demo-customer-3', name: 'Restaurante Sabor Caseiro', contact: 'Renata Martins', kind: 'Restaurante', phone: '(21) 90000-0003', email: 'financeiro@saborcaseiro.example', address: 'Centro · Niterói, RJ', lastOrder: day(today, -1) },
    { id: 'demo-customer-4', name: 'Lavanderia Ponto Limpo', contact: 'Diego Nunes', kind: 'Lavanderia', phone: '(21) 90000-0004', email: 'contato@pontolimpo.example', address: 'Fonseca · Niterói, RJ', lastOrder: day(today, -2) },
    { id: 'demo-customer-5', name: 'Flor & Afeto', contact: 'Camila Duarte', kind: 'Floricultura', phone: '(21) 90000-0005', email: 'loja@floreafeto.example', address: 'Santa Rosa · Niterói, RJ', lastOrder: day(today, -4) },
    { id: 'demo-customer-6', name: 'Ateliê Casa Serena', contact: 'Lívia Campos', kind: 'Loja de presentes', phone: '(21) 90000-0006', email: 'pedidos@casaserena.example', address: 'São Francisco · Niterói, RJ', lastOrder: day(today, -7) },
  ]
}

function getOrders(today: string): DemoOrder[] {
  return [
    { id: 'demo-order-1', number: 'SA-1048', customerId: 'demo-customer-1', createdOn: day(today, 0), status: 'Aguardando separação', delivery: 'Entrega', totalCents: 76550, payment: 'Pix · parcialmente recebido', lines: [{ name: 'Detergente neutro 5 L', quantity: '12 un.', totalCents: 35880 }, { name: 'Desinfetante floral 2 L', quantity: '10 un.', totalCents: 28600 }, { name: 'Sabão líquido 5 L', quantity: '2 un.', totalCents: 12070 }] },
    { id: 'demo-order-2', number: 'SA-1047', customerId: 'demo-customer-2', createdOn: day(today, 0), status: 'Pronto para retirada', delivery: 'Retirada', totalCents: 43200, payment: 'Boleto · vence hoje', lines: [{ name: 'Kit limpeza essencial', quantity: '2 un.', totalCents: 33000 }, { name: 'Aromatizador de ambiente', quantity: '2 un.', totalCents: 10200 }] },
    { id: 'demo-order-3', number: 'SA-1046', customerId: 'demo-customer-3', createdOn: day(today, -1), status: 'Em rota', delivery: 'Entrega', totalCents: 124000, payment: 'Transferência · parcial', lines: [{ name: 'Detergente neutro 5 L', quantity: '20 un.', totalCents: 59800 }, { name: 'Sabão líquido 5 L', quantity: '8 un.', totalCents: 52720 }, { name: 'Entrega', quantity: '1 un.', totalCents: 11480 }] },
    { id: 'demo-order-4', number: 'SA-1045', customerId: 'demo-customer-5', createdOn: day(today, -2), status: 'Concluído', delivery: 'Entrega', totalCents: 18990, payment: 'Pix · recebido', lines: [{ name: 'Aromatizador de ambiente', quantity: '3 un.', totalCents: 13770 }, { name: 'Detergente neutro 5 L', quantity: '1 un.', totalCents: 5220 }] },
    { id: 'demo-order-5', number: 'SA-1044', customerId: 'demo-customer-4', createdOn: day(today, -3), status: 'Tentativa sem sucesso', delivery: 'Entrega', totalCents: 96400, payment: 'Boleto · em aberto', lines: [{ name: 'Sabão líquido 5 L', quantity: '8 un.', totalCents: 96400 }] },
    { id: 'demo-order-6', number: 'SA-1043', customerId: 'demo-customer-6', createdOn: day(today, -5), status: 'Cancelado', delivery: 'Retirada', totalCents: 54900, payment: 'Sem recebimento', lines: [{ name: 'Kit limpeza essencial', quantity: '2 un.', totalCents: 54900 }] },
  ]
}

const products = [
  { id: 'demo-product-1', name: 'Detergente neutro 5 L', code: 'SA-DT-005', category: 'Limpeza', priceCents: 2_990, costCents: 1_640, stock: 3, minimum: 8, unit: 'un.' },
  { id: 'demo-product-2', name: 'Desinfetante floral 2 L', code: 'SA-DF-002', category: 'Limpeza', priceCents: 1_590, costCents: 820, stock: -1, minimum: 6, unit: 'un.' },
  { id: 'demo-product-3', name: 'Sabão líquido 5 L', code: 'SA-SL-005', category: 'Lavanderia', priceCents: 4_890, costCents: 2_730, stock: 24, minimum: 8, unit: 'un.' },
  { id: 'demo-product-4', name: 'Aromatizador de ambiente 500 ml', code: 'SA-AA-050', category: 'Aromas', priceCents: 4_590, costCents: 2_100, stock: 18, minimum: 5, unit: 'un.' },
  { id: 'demo-product-5', name: 'Kit limpeza essencial', code: 'SA-KT-001', category: 'Combos', priceCents: 16_500, costCents: 8_400, stock: 7, minimum: 3, unit: 'kit' },
]

const followUps = [
  { title: 'Confirmar reposição do sabão neutro', customerId: 'demo-customer-1', dueOffset: -1, channel: 'WhatsApp', priority: 'Alta', owner: 'Equipe de gestão' },
  { title: 'Retornar sobre orçamento de novembro', customerId: 'demo-customer-2', dueOffset: 0, channel: 'Telefone', priority: 'Normal', owner: 'Atendimento' },
  { title: 'Confirmar quantidade para sexta-feira', customerId: 'demo-customer-3', dueOffset: 0, channel: 'WhatsApp', priority: 'Normal', owner: 'Atendimento' },
  { title: 'Enviar tabela atualizada de produtos', customerId: 'demo-customer-5', dueOffset: 1, channel: 'WhatsApp', priority: 'Baixa', owner: 'Equipe de gestão' },
]

type Metric = { label: string; value: string; note: string; icon?: IconName }

function DemoHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="page-heading demo-page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action && <div className="demo-page-action">{action}</div>}</header>
}

function DemoMetrics({ items, className = '' }: { items: Metric[]; className?: string }) {
  return <div className={`demo-metric-grid ${className}`.trim()}>{items.map((item) => <article className="surface-panel demo-metric" key={item.label}><div className="demo-metric-label">{item.icon && <Icon name={item.icon} />}<span>{item.label}</span></div><strong>{item.value}</strong><small>{item.note}</small></article>)}</div>
}

function DemoPanel({ title, subtitle, action, children, className = '' }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`surface-panel demo-panel ${className}`}><div className="demo-panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>{children}</section>
}

function DemoBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' }) {
  return <span className={`demo-badge is-${tone}`}>{children}</span>
}

function DemoTable({ caption, headings, rows }: { caption: string; headings: string[]; rows: ReactNode[][] }) {
  return <div className="demo-table-wrap" role="region" aria-label={caption} tabIndex={0}><table className="demo-table"><caption className="visually-hidden">{caption}</caption><thead><tr>{headings.map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`${caption}-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div>
}

function ReadOnlyButton({ children }: { children: ReactNode }) {
  return <button className="demo-readonly-button" disabled type="button">{children}</button>
}

function FinanceTabs({ current }: { current: 'receivables' | 'outflows' }) {
  return <nav className="finance-subnav" aria-label="Seções financeiras">
    <Link className={current === 'receivables' ? 'is-active' : ''} to="/financeiro">Pagamentos pendentes</Link>
    <Link className={current === 'outflows' ? 'is-active' : ''} to="/financeiro/saidas">Gastos pagos</Link>
  </nav>
}

function customerLink(customer: DemoCustomer) {
  return <Link className="demo-record-link" to={`/clientes/${customer.id}`}>{customer.name}</Link>
}

function orderLink(order: DemoOrder) {
  return <Link className="demo-record-link" to={`/pedidos/${order.id}`}>{order.number}</Link>
}

function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'accent' {
  if (/concluído|recebido|pago|conciliado|entregue/i.test(status)) return 'success'
  if (/atrasado|cancelado|sem sucesso|vencido|negativo/i.test(status)) return 'danger'
  if (/hoje|separação|rota|pendente|aberto|reagendada/i.test(status)) return 'warning'
  return 'accent'
}

function orderStatusLabel(status: string) {
  return status === 'Tentativa sem sucesso' ? 'Entrega não concluída' : status
}

function CustomerList({ today }: { today: string }) {
  const [search, setSearch] = useState('')
  const customers = getCustomers(today).filter((customer) => `${customer.name} ${customer.contact} ${customer.kind}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')))
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="RELACIONAMENTO" title="Clientes" description="Cadastros, contatos e histórico de compras da carteira." action={<ReadOnlyButton><Icon name="people" /> Novo cliente</ReadOnlyButton>} />
    <DemoMetrics items={[{ label: 'Clientes ativos', value: '42', note: '+4 neste mês', icon: 'people' }, { label: 'Compraram nos últimos 30 dias', value: '28', note: '67% da carteira', icon: 'bag' }, { label: 'Retornos pendentes', value: '6', note: '2 passaram do prazo ou vencem hoje', icon: 'phone' }, { label: 'Pagamentos pendentes', value: 'R$ 1.284,00', note: '3 clientes ainda têm valores a pagar', icon: 'coin' }]} />
    <DemoPanel title="Carteira de clientes" subtitle={`${customers.length} registros de exemplo`} action={<label className="demo-search"><span>Buscar</span><input aria-label="Buscar cliente fictício" onChange={(event) => setSearch(event.target.value)} placeholder="Nome, contato ou tipo" value={search} /></label>}>
      <DemoTable caption="Clientes fictícios" headings={['Cliente', 'Tipo', 'Contato', 'Último pedido', 'Situação']} rows={customers.map((customer) => [customerLink(customer), customer.kind, <span className="demo-secondary-copy">{customer.contact}<small>{customer.phone}</small></span>, dateLabel(customer.lastOrder), <DemoBadge tone="success">Ativo</DemoBadge>])} />
    </DemoPanel>
    <DemoPanel title="Atividade recente" subtitle="Interações registradas na demonstração"><div className="demo-activity-list"><ActivityItem date={dateLabel(day(today, 0))} title="Pedido criado" detail="Mercado Boa Praça · SA-1048 · R$ 765,50" icon="bag" /><ActivityItem date={dateLabel(day(today, -1))} title="Retorno programado" detail="Condomínio Vila Verde · confirmar orçamento" icon="phone" /><ActivityItem date={dateLabel(day(today, -2))} title="Pagamento recebido" detail="Flor & Afeto · Pix · R$ 189,90" icon="coin" /></div></DemoPanel>
  </div>
}

function ActivityItem({ date, title, detail, icon = 'clock' }: { date: string; title: string; detail: string; icon?: IconName }) {
  return <article className="demo-activity-item"><span className="demo-activity-icon"><Icon name={icon} /></span><div><strong>{title}</strong><p>{detail}</p></div><time>{date}</time></article>
}

function CustomerDetail({ customerId, today }: { customerId: string; today: string }) {
  const customers = getCustomers(today)
  const customer = customers.find((item) => item.id === customerId) ?? customers[0]
  const orders = getOrders(today).filter((order) => order.customerId === customer.id)
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="CLIENTE · CADASTRO DEMONSTRATIVO" title={customer.name} description={`${customer.kind} · cliente fictício desde agosto de 2026`} action={<Link className="quiet-link" to="/clientes"><Icon name="arrow" /> Voltar aos clientes</Link>} />
    <DemoMetrics className="demo-customer-metrics" items={[{ label: 'Pedidos feitos', value: orders.length ? String(orders.length) : '0', note: 'Compras registradas no exemplo', icon: 'bag' }, { label: 'Falta receber', value: customer.id === 'demo-customer-1' ? 'R$ 120,00' : customer.id === 'demo-customer-2' ? 'R$ 87,00' : 'R$ 198,00', note: 'Valor de pedidos ainda não pagos', icon: 'coin' }]} />
    <div className="demo-two-column">
      <DemoPanel title="Contato e entrega" subtitle="Informações de exemplo"><dl className="demo-detail-list"><div><dt>Contato principal</dt><dd>{customer.contact}</dd></div><div><dt>Telefone / WhatsApp</dt><dd>{customer.phone}</dd></div><div><dt>E-mail</dt><dd>{customer.email}</dd></div><div><dt>Endereço de entrega</dt><dd>{customer.address}</dd></div><div><dt>Preferência</dt><dd>WhatsApp em horário comercial</dd></div></dl></DemoPanel>
      <DemoPanel title="Observação interna"><p className="demo-body-copy">Cliente recorrente. Costuma confirmar reposições e horários de entrega pelo WhatsApp.</p><DemoBadge tone="accent">Cadastro demonstrativo</DemoBadge></DemoPanel>
    </div>
    <DemoPanel title="Pedidos recentes" subtitle="Histórico de compras de exemplo"><DemoTable caption={`Pedidos fictícios de ${customer.name}`} headings={['Pedido', 'Data', 'Entrega', 'Situação', 'Total']} rows={(orders.length ? orders : getOrders(today).slice(0, 2)).map((order) => [orderLink(order), dateLabel(order.createdOn), order.delivery, <DemoBadge tone={statusTone(order.status)}>{orderStatusLabel(order.status)}</DemoBadge>, brl(order.totalCents)])} /></DemoPanel>
    <DemoPanel title="Linha do tempo"><div className="demo-activity-list"><ActivityItem date={dateLabel(day(today, 0))} title="Contato de acompanhamento" detail="Retorno programado para confirmar o próximo pedido." icon="phone" /><ActivityItem date={dateLabel(day(today, -5))} title="Pedido concluído" detail="Entrega confirmada e pagamento registrado no exemplo." icon="check" /></div></DemoPanel>
  </div>
}

function FollowUpsPreview({ today }: { today: string }) {
  const customers = getCustomers(today)
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="RELACIONAMENTO · ACOMPANHAMENTO" title="Atendimento" description="Retornos programados, contatos prioritários e próximos passos." action={<ReadOnlyButton><Icon name="phone" /> Registrar contato</ReadOnlyButton>} />
    <DemoMetrics items={[{ label: 'Retornos em aberto', value: '6', note: 'Na carteira inteira', icon: 'phone' }, { label: 'Atrasados ou para hoje', value: '3', note: 'Prioridade de atendimento', icon: 'clock' }, { label: 'Concluídos nesta semana', value: '14', note: 'Histórico demonstrativo', icon: 'check' }]} />
    <div className="demo-filter-row"><DemoBadge tone="accent">Todos · 6</DemoBadge><DemoBadge>Hoje · 2</DemoBadge><DemoBadge tone="danger">Atrasados · 1</DemoBadge><DemoBadge>Próximos · 3</DemoBadge></div>
    <DemoPanel title="Fila de retornos" subtitle="Exemplos organizados por prazo"><DemoTable caption="Retornos fictícios" headings={['Prazo', 'Cliente', 'Assunto', 'Canal', 'Prioridade', 'Responsável']} rows={followUps.map((task) => { const customer = customers.find((item) => item.id === task.customerId) ?? customers[0]; const due = day(today, task.dueOffset); return [<span className="demo-secondary-copy">{dateLabel(due)}<small>{task.dueOffset < 0 ? 'Atrasado' : task.dueOffset === 0 ? 'Hoje' : 'Próximo'}</small></span>, customerLink(customer), task.title, task.channel, <DemoBadge tone={task.priority === 'Alta' ? 'danger' : 'neutral'}>{task.priority}</DemoBadge>, task.owner] })} /></DemoPanel>
    <DemoPanel title="Atendimento recente" subtitle="Últimos contatos fictícios"><div className="demo-activity-list"><ActivityItem date={dateLabel(day(today, 0))} title="Mensagem recebida" detail="Mercado Boa Praça · pediu confirmação do horário" icon="message" /><ActivityItem date={dateLabel(day(today, -1))} title="Ligação concluída" detail="Condomínio Vila Verde · orçamento enviado" icon="phone" /><ActivityItem date={dateLabel(day(today, -2))} title="Retorno agendado" detail="Restaurante Sabor Caseiro · revisar quantidades" icon="clock" /></div></DemoPanel>
  </div>
}

function WhatsAppPreview({ inbox = false, today }: { inbox?: boolean; today: string }) {
  const customers = getCustomers(today)
  if (inbox) return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="WHATSAPP · CAIXA DE EXEMPLO" title="Conversas" description="Mensagens simuladas para visualizar o atendimento; nenhuma conta está conectada." action={<DemoBadge tone="warning">Não conectado</DemoBadge>} />
    <div className="demo-whatsapp-layout">
      <DemoPanel title="Conversas" subtitle="3 conversas fictícias" className="demo-chat-list"><article className="demo-chat-preview is-selected"><span className="demo-chat-avatar">MB</span><div><strong>Mercado Boa Praça</strong><small>Consegue confirmar a entrega de hoje?</small></div><time>10:42</time></article><article className="demo-chat-preview"><span className="demo-chat-avatar">VV</span><div><strong>Condomínio Vila Verde</strong><small>Recebi o orçamento, obrigado.</small></div><time>09:18</time></article><article className="demo-chat-preview"><span className="demo-chat-avatar">SC</span><div><strong>Restaurante Sabor Caseiro</strong><small>Vamos precisar de mais 4 unidades.</small></div><time>Ontem</time></article></DemoPanel>
      <DemoPanel title="Mercado Boa Praça" subtitle="Conversa simulada · sem sincronização" className="demo-chat-thread"><div className="demo-chat-messages"><p className="demo-message received">Bom dia! Vocês conseguem entregar o pedido hoje?<small>10:31</small></p><p className="demo-message sent">Bom dia, Paula! O pedido SA-1048 está em separação e a previsão é até 15h.<small>10:36</small></p><p className="demo-message received">Ótimo. Pode confirmar quando sair para entrega?<small>10:42</small></p></div><div className="demo-chat-compose"><input aria-label="Campo de mensagem fictício" disabled placeholder="Prévia somente leitura" /><button disabled type="button"><Icon name="arrow" /></button></div></DemoPanel>
      <DemoPanel title="Contato vinculado" className="demo-chat-contact"><div className="demo-contact-summary"><span className="demo-chat-avatar">MB</span><strong>Mercado Boa Praça</strong><small>{customers[0].phone} · exemplo</small><Link to={`/clientes/${customers[0].id}`}>Ver cadastro <Icon name="arrow" /></Link><Link to="/pedidos/demo-order-1">Pedido SA-1048 <Icon name="arrow" /></Link></div></DemoPanel>
    </div>
  </div>
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="RELACIONAMENTO · CANAL DIGITAL" title="WhatsApp" description="Visão de conversas de exemplo, com vínculos a clientes e pedidos fictícios." action={<Link className="quiet-link" to="/whatsapp/caixa-shalom"><Icon name="message" /> Abrir caixa</Link>} />
    <div className="demo-callout"><Icon name="message" /><p><strong>Conexão ainda não configurada.</strong> A caixa abaixo é apenas uma demonstração visual; as mensagens não vêm de um número real nem serão enviadas.</p></div>
    <DemoMetrics items={[{ label: 'Conversas de exemplo', value: '3', note: 'Mensagens fictícias', icon: 'message' }, { label: 'Aguardando resposta', value: '2', note: 'Fila simulada', icon: 'clock' }, { label: 'Vínculos com pedidos', value: '2', note: 'Associações de demonstração', icon: 'bag' }]} />
    <DemoPanel title="Conversas recentes" subtitle="Prévia de caixa de entrada"><div className="demo-conversation-list">{customers.slice(0, 3).map((customer, index) => <Link className="demo-conversation" key={customer.id} to="/whatsapp/caixa-shalom"><span className="demo-chat-avatar">{customer.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><span><strong>{customer.name}</strong><small>{['Consegue confirmar a entrega de hoje?', 'Recebi o orçamento, obrigado.', 'Vamos precisar de mais 4 unidades.'][index]}</small></span><time>{['10:42', '09:18', 'Ontem'][index]}</time><Icon name="arrow" /></Link>)}</div></DemoPanel>
  </div>
}

function OrdersPreview({ today, detailId, newOrder = false }: { today: string; detailId?: string; newOrder?: boolean }) {
  const customers = getCustomers(today)
  const orders = getOrders(today)
  if (newOrder) {
    const draftLines: DemoOrderLine[] = [
      { name: 'Detergente neutro 5 L', quantity: '8 un.', totalCents: 23_920 },
      { name: 'Aromatizador de ambiente 500 ml', quantity: '3 un.', totalCents: 13_770 },
    ]
    const draftCustomer = customers[2]
    const draftTotal = draftLines.reduce((total, line) => total + line.totalCents, 0)
    return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="PEDIDOS · FORMULÁRIO DE EXEMPLO" title="Novo pedido" description="Visualização de um pedido preenchido; campos e gravação estão desativados." action={<Link className="quiet-link" to="/pedidos"><Icon name="arrow" /> Voltar aos pedidos</Link>} />
    <div className="demo-callout"><Icon name="shield" /><p><strong>Somente visualização.</strong> Este formulário fictício não cria pedido nem altera estoque.</p></div>
    <DemoPanel title="Cliente e atendimento" subtitle="Exemplo de pedido"><div className="demo-form-grid"><label>Cliente<input disabled value={draftCustomer.name} /></label><label>Tipo de pedido<input disabled value="Entrega" /></label><label>Data prevista<input disabled value={dateLabel(today)} /></label><label>Responsável<input disabled value="Equipe de gestão" /></label></div></DemoPanel>
    <DemoPanel title="Itens do pedido" subtitle="Preço e quantidade registrados no exemplo"><DemoTable caption="Itens do pedido fictício" headings={['Produto', 'Quantidade', 'Preço unitário', 'Total']} rows={draftLines.map((line) => [line.name, line.quantity, brl(line.totalCents / Number.parseInt(line.quantity, 10)), brl(line.totalCents)])} /><div className="demo-total-row"><span>Total do pedido</span><strong>{brl(draftTotal)}</strong></div><p className="demo-footnote">O preço unitário fica registrado no pedido; alterações futuras no catálogo não mudam este registro.</p></DemoPanel>
    <DemoPanel title="Pagamento e entrega" subtitle="Condições informadas no exemplo"><div className="demo-form-grid"><label>Forma de pagamento<input disabled value="Boleto" /></label><label>Prazo<input disabled value="1ª parcela · vencimento em 15 dias" /></label><label>Endereço<input disabled value={draftCustomer.address} /></label><label>Observações<input disabled value="Confirmar horário antes de sair para entrega." /></label></div></DemoPanel>
  </div>
  }
  const order = detailId ? orders.find((item) => item.id === detailId) ?? orders[0] : null
  if (order) {
    const customer = customers.find((item) => item.id === order.customerId) ?? customers[0]
    return <div className="page-stack demo-preview-page">
      <DemoHeading eyebrow={`PEDIDO · ${order.number}`} title={customer.name} description={`${dateLabel(order.createdOn)} · ${order.delivery.toLocaleLowerCase('pt-BR')} · registro fictício`} action={<Link className="quiet-link" to="/pedidos"><Icon name="arrow" /> Voltar aos pedidos</Link>} />
      <DemoMetrics items={[{ label: 'Total do pedido', value: brl(order.totalCents), note: orderStatusLabel(order.status), icon: 'bag' }, { label: 'Pagamento', value: order.payment.split(' · ')[0], note: order.payment.split(' · ')[1], icon: 'coin' }, { label: 'Entrega', value: order.delivery, note: orderStatusLabel(order.status), icon: 'truck' }]} />
      <div className="demo-two-column"><DemoPanel title="Itens" subtitle="Composição fictícia"><DemoTable caption={`Itens do pedido ${order.number}`} headings={['Produto', 'Quantidade', 'Total']} rows={order.lines.map((line) => [line.name, line.quantity, brl(line.totalCents)])} /><div className="demo-total-row"><span>Total</span><strong>{brl(order.totalCents)}</strong></div></DemoPanel><DemoPanel title="Resumo do pedido"><dl className="demo-detail-list"><div><dt>Cliente</dt><dd>{customerLink(customer)}</dd></div><div><dt>Situação</dt><dd><DemoBadge tone={statusTone(order.status)}>{orderStatusLabel(order.status)}</DemoBadge></dd></div><div><dt>Pagamento informado</dt><dd>{order.payment}</dd></div><div><dt>Endereço</dt><dd>{customer.address}</dd></div></dl><div className="demo-disabled-actions"><ReadOnlyButton>Registrar pagamento</ReadOnlyButton><ReadOnlyButton>Atualizar entrega</ReadOnlyButton></div></DemoPanel></div>
      <DemoPanel title="Histórico" subtitle="Eventos fictícios"><div className="demo-activity-list"><ActivityItem date={dateLabel(order.createdOn)} title="Pedido criado" detail={`Pedido ${order.number} registrado para ${customer.name}.`} icon="bag" /><ActivityItem date={dateLabel(order.createdOn)} title={order.status} detail={order.delivery === 'Entrega' ? 'Aguardando próxima atualização logística.' : 'Retirada pelo cliente aguardando confirmação.'} icon="truck" /></div></DemoPanel>
    </div>
  }
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="VENDAS · PEDIDOS" title="Pedidos" description="Vendas, formas de pagamento e entregas em um só lugar." action={<Link className="demo-primary-link" to="/pedidos/novo"><Icon name="bag" /> Novo pedido</Link>} />
    <DemoMetrics items={[{ label: 'Pedidos no período', value: '24', note: 'Últimos 30 dias', icon: 'bag' }, { label: 'Em andamento', value: '5', note: 'Separação, rota ou retirada', icon: 'clock' }, { label: 'Faturamento líquido', value: 'R$ 18.742,50', note: 'Total após descontos', icon: 'coin' }, { label: 'Falta receber', value: 'R$ 1.284,00', note: '3 parcelas ainda não pagas', icon: 'chart' }]} />
    <div className="demo-filter-row"><DemoBadge tone="accent">Todos · 24</DemoBadge><DemoBadge>Em andamento · 5</DemoBadge><DemoBadge tone="success">Concluídos · 17</DemoBadge><DemoBadge tone="danger">Cancelados · 2</DemoBadge></div>
    <DemoPanel title="Pedidos recentes" subtitle="Registros de exemplo"><DemoTable caption="Lista de pedidos fictícios" headings={['Pedido', 'Cliente', 'Data', 'Tipo', 'Situação', 'Total']} rows={orders.map((item) => { const customer = customers.find((entry) => entry.id === item.customerId) ?? customers[0]; return [orderLink(item), customerLink(customer), dateLabel(item.createdOn), item.delivery, <DemoBadge tone={statusTone(item.status)}>{orderStatusLabel(item.status)}</DemoBadge>, brl(item.totalCents)] })} /></DemoPanel>
  </div>
}

function CatalogPreview({ today }: { today: string }) {
  const [selectedCategory, setSelectedCategory] = useState('Todos')
  const categoryNames = ['Limpeza', 'Lavanderia', 'Aromas', 'Combos']
  const categoryCounts = new Map(categoryNames.map((category) => [category, products.filter((product) => product.category === category).length]))
  const filteredProducts = products.filter((product) => selectedCategory === 'Todos' || product.category === selectedCategory)
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="PRODUTOS · CATÁLOGO" title="Catálogo" description="Produtos, preços, unidades e combinações disponíveis para pedidos." action={<ReadOnlyButton><Icon name="box" /> Novo produto</ReadOnlyButton>} />
    <div className="demo-category-filters" role="group" aria-label="Filtrar produtos por categoria">
      {['Todos', ...categoryNames].map((category) => {
        const count = category === 'Todos' ? products.length : categoryCounts.get(category) ?? 0
        return <button aria-pressed={selectedCategory === category} className={`demo-category-filter${selectedCategory === category ? ' is-active' : ''}`} key={category} onClick={() => setSelectedCategory(category)} type="button">{category}<span>{count}</span></button>
      })}
    </div>
    <DemoMetrics className="demo-catalog-metrics" items={[{ label: 'Produtos no catálogo', value: String(products.length), note: 'Exemplos em 4 categorias', icon: 'tag' }, { label: 'Produtos com saldo no sistema', value: String(products.length), note: 'Atualizado em despachos e recebimentos', icon: 'check' }, { label: 'Precisam de reposição', value: '2', note: 'Abaixo da quantidade mínima', icon: 'clock' }]} />
    <DemoPanel title="Produtos e preços" subtitle={`${filteredProducts.length} exemplos · catálogo atualizado em ${dateLabel(today)}`}><DemoTable caption="Produtos fictícios" headings={['Produto', 'Código', 'Categoria', 'Preço', 'Custo', 'Quantidade']} rows={filteredProducts.map((product) => [<span className="demo-secondary-copy"><strong>{product.name}</strong><small>{product.unit}</small></span>, product.code, product.category, brl(product.priceCents), brl(product.costCents), <DemoBadge tone={product.stock < 0 ? 'danger' : product.stock < product.minimum ? 'warning' : 'success'}>{stockLabel(product)}</DemoBadge>])} /></DemoPanel>
  </div>
}

function InventoryPreview({ today }: { today: string }) {
  const movementRows = [
    [dateLabel(today), 'Detergente neutro 5 L', 'Venda despachada · SA-1046', '−20 un.', <DemoBadge tone="accent">Saída</DemoBadge>],
    [dateLabel(day(today, -1)), 'Sabão líquido 5 L', 'Compra recebida · NF de exemplo', '+12 un.', <DemoBadge tone="success">Entrada</DemoBadge>],
    [dateLabel(day(today, -2)), 'Desinfetante floral 2 L', 'Ajuste de retorno conferido', '+1 un.', <DemoBadge tone="neutral">Retorno</DemoBadge>],
  ]
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="OPERAÇÃO · ESTOQUE" title="Estoque" description="Quantidade atual de cada produto, compras recebidas e alterações registradas." action={<ReadOnlyButton><Icon name="box" /> Registrar movimentação</ReadOnlyButton>} />
    <DemoMetrics items={[{ label: 'Produtos com saldo', value: String(products.length), note: 'Atualizado em despachos e recebimentos', icon: 'box' }, { label: 'Abaixo do mínimo', value: '1', note: 'É hora de repor', icon: 'clock' }, { label: 'Estoque negativo', value: '1', note: 'Saíram mais unidades do que havia', icon: 'chart' }, { label: 'Compras recebidas este mês', value: '8', note: 'Produtos que chegaram e foram registrados', icon: 'check' }]} />
    <DemoPanel title="Quantidade atual" subtitle="Quantidade registrada para cada produto"><DemoTable caption="Saldos fictícios de estoque" headings={['Produto', 'Quantidade', 'Mínimo recomendado', 'Situação', 'Última movimentação']} rows={products.slice(0, 4).map((product) => [product.name, stockLabel(product), `${product.minimum} ${product.unit}`, <DemoBadge tone={product.stock < 0 ? 'danger' : product.stock < product.minimum ? 'warning' : 'success'}>{product.stock < 0 ? 'Abaixo de zero' : product.stock < product.minimum ? 'Repor' : 'Normal'}</DemoBadge>, dateLabel(day(today, -1))])} /></DemoPanel>
    <DemoPanel title="Movimentações recentes" subtitle="Rastreabilidade demonstrativa"><DemoTable caption="Movimentações fictícias" headings={['Data', 'Produto', 'Motivo', 'Quantidade', 'Tipo']} rows={movementRows} /></DemoPanel>
  </div>
}

function DeliveriesPreview({ today }: { today: string }) {
  const customers = getCustomers(today)
  const orders = getOrders(today).filter((item) => item.delivery === 'Entrega' && ['Aguardando separação', 'Em rota', 'Tentativa sem sucesso'].includes(item.status))
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="LOGÍSTICA · ENTREGAS" title="Entregas" description="Fila de separação, despacho e acompanhamento de pedidos." action={<ReadOnlyButton><Icon name="truck" /> Gerenciar entregadores</ReadOnlyButton>} />
    <DemoMetrics items={[{ label: 'Aguardando separação', value: '1', note: 'Preparar os pedidos da fila', icon: 'box' }, { label: 'Em rota', value: '1', note: 'Entrega em andamento', icon: 'truck' }, { label: 'Entrega não concluída', value: '1', note: 'Combinar um novo horário', icon: 'phone' }]} />
    <div className="demo-callout"><Icon name="truck" /><p><strong>Rastreamento simulado.</strong> Horários, status e entregadores abaixo são fictícios; não há localização ao vivo.</p></div>
    <DemoPanel title="Fila de entregas" subtitle={`${orders.length} entregas ativas de exemplo`}><DemoTable caption="Entregas fictícias" headings={['Pedido', 'Cliente', 'Janela', 'Entregador', 'Situação', 'Próximo passo']} rows={orders.map((order, index) => { const customer = customers.find((entry) => entry.id === order.customerId) ?? customers[0]; const nextSteps: Record<string, string> = { 'Aguardando separação': 'Separar produtos', 'Em rota': 'Confirmar recebimento', 'Tentativa sem sucesso': 'Combinar novo horário' }; const statusLabel = order.status === 'Tentativa sem sucesso' ? 'Entrega não concluída' : order.status; return [orderLink(order), customerLink(customer), `${index === 0 ? '10h–12h' : index === 1 ? '13h–15h' : '15h–17h'} · ${dateLabel(index === 2 ? day(today, -1) : today)}`, ['Rafael', 'João', 'Rafael'][index], <DemoBadge tone={statusTone(order.status)}>{statusLabel}</DemoBadge>, nextSteps[order.status]] })} /></DemoPanel>
    <DemoPanel title="Entregadores" subtitle="Equipe de demonstração"><div className="demo-driver-grid">{['Rafael · disponível', 'João · em rota', 'Marcos · disponível'].map((person) => <div className="demo-driver" key={person}><span className="demo-driver-avatar">{person[0]}</span><strong>{person.split(' · ')[0]}</strong><DemoBadge tone={person.includes('em rota') ? 'warning' : 'success'}>{person.split(' · ')[1]}</DemoBadge></div>)}</div></DemoPanel>
  </div>
}

function ReceivablesPreview({ today }: { today: string }) {
  const customers = getCustomers(today)
  const orders = getOrders(today)
  const rows = [
    { orderId: 'demo-order-1', customerId: 'demo-customer-1', installment: '2 de 2', due: day(today, -2), amount: 12_000 },
    { orderId: 'demo-order-5', customerId: 'demo-customer-4', installment: '1 de 2', due: day(today, -1), amount: 19_800 },
    { orderId: 'demo-order-2', customerId: 'demo-customer-2', installment: '1 de 1', due: today, amount: 8_700 },
    { orderId: 'demo-order-3', customerId: 'demo-customer-3', installment: '2 de 3', due: day(today, 4), amount: 42_500 },
  ]
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="FINANCEIRO · CLIENTES" title="Pagamentos pendentes" description="Valores que seus clientes ainda precisam pagar e as datas de vencimento." />
    <FinanceTabs current="receivables" />
    <DemoMetrics items={[{ label: 'Ainda falta receber', value: 'R$ 83.000,00', note: '18 parcelas não pagas', icon: 'coin' }, { label: 'Pagamentos atrasados', value: 'R$ 318,00', note: '2 parcelas passaram do prazo', icon: 'clock' }, { label: 'Pagamentos para hoje', value: 'R$ 87,00', note: '1 parcela vence hoje', icon: 'chart' }, { label: 'Recebido neste mês', value: 'R$ 12.230,00', note: 'Pagamentos marcados como recebidos', icon: 'check' }]} />
    <DemoPanel title="Pagamentos que precisam de atenção" subtitle="Atrasados, com prazo para hoje ou próximos"><DemoTable caption="Pagamentos pendentes fictícios" headings={['Data limite', 'Cliente / pedido', 'Parcela', 'Valor', 'Situação']} rows={rows.map((item) => { const customer = customers.find((entry) => entry.id === item.customerId) ?? customers[0]; const label = item.due < today ? 'Atrasado' : item.due === today ? 'Vence hoje' : 'Ainda não pago'; return [dateLabel(item.due), <span className="demo-secondary-copy">{customerLink(customer)}<small>{orderLink(orders.find((order) => order.id === item.orderId) ?? orders[0])}</small></span>, item.installment, brl(item.amount), <DemoBadge tone={statusTone(label)}>{label}</DemoBadge>] })} /></DemoPanel>
    <DemoPanel title="Pagamentos recebidos" subtitle="Valores já registrados como pagos"><DemoTable caption="Pagamentos recebidos de exemplo" headings={['Data recebida', 'Pedido', 'Cliente', 'Forma de pagamento', 'Valor']} rows={orders.slice(0, 3).map((order, index) => [dateLabel(day(today, -index)), orderLink(order), customers.find((customer) => customer.id === order.customerId)?.name ?? 'Cliente exemplo', ['Pix', 'Boleto', 'Transferência'][index], brl([64_550, 21_600, 48_000][index])])} /></DemoPanel>
  </div>
}

function OutflowsPreview({ today }: { today: string }) {
  const rows = [
    [dateLabel(day(today, 0)), 'Embalagens para pedidos', 'Materiais', 'Fornecedor Exemplo', 'R$ 486,00', <DemoBadge tone="success">Pago</DemoBadge>],
    [dateLabel(day(today, -1)), 'Combustível de entregas', 'Entrega', 'Posto Niterói (exemplo)', 'R$ 320,00', <DemoBadge tone="success">Pago</DemoBadge>],
    [dateLabel(day(today, -3)), 'Produtos para reposição', 'Produtos para revenda', 'Distribuidora Modelo', 'R$ 1.240,00', <DemoBadge tone="success">Pago</DemoBadge>],
    [dateLabel(day(today, -6)), 'Internet e telefone', 'Operação', 'Serviço Exemplo', 'R$ 189,90', <DemoBadge tone="success">Pago</DemoBadge>],
  ]
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="FINANCEIRO · GASTOS" title="Gastos pagos" description="Despesas da empresa e compras de produtos que já foram pagas." action={<ReadOnlyButton><Icon name="coin" /> Registrar gasto</ReadOnlyButton>} />
    <FinanceTabs current="outflows" />
    <DemoMetrics items={[{ label: 'Total pago neste mês', value: 'R$ 8.764,90', note: '11 gastos registrados', icon: 'coin' }, { label: 'Gastos da empresa', value: 'R$ 4.126,00', note: 'Contas e serviços já pagos', icon: 'check' }, { label: 'Produtos para revenda', value: 'R$ 4.638,90', note: 'Entram no lucro quando forem vendidos', icon: 'box' }]} />
    <DemoPanel title="Gastos registrados" subtitle="Exemplos de valores que já foram pagos"><DemoTable caption="Gastos fictícios já pagos" headings={['Data paga', 'O que foi pago', 'Tipo de gasto', 'Pago a', 'Valor', 'Situação']} rows={rows} /></DemoPanel>
    <p className="demo-footnote">Esta tela mostra somente valores já pagos. Produtos comprados para revenda entram no lucro quando forem vendidos.</p>
  </div>
}

function ReportsPreview({ today }: { today: string }) {
  const months = [{ label: 'Jun', value: 45 }, { label: 'Jul', value: 58 }, { label: 'Ago', value: 52 }, { label: 'Set', value: 69 }, { label: 'Out', value: 78 }, { label: 'Nov', value: 42 }]
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="GESTÃO · RESULTADOS" title="Relatórios" description="Veja quanto vendeu, quanto gastou e o lucro estimado no período." action={<DemoBadge tone="accent">Últimos 30 dias</DemoBadge>} />
    <DemoMetrics className="demo-report-metrics" items={[{ label: 'Faturamento bruto', value: 'R$ 120.000,00', note: 'Soma dos pedidos antes dos descontos', icon: 'coin' }, { label: 'Descontos aplicados', value: 'R$ 4.460,00', note: 'Redução nos preços dos pedidos', icon: 'chart' }, { label: 'Faturamento líquido', value: 'R$ 115.540,00', note: 'Total após os descontos', icon: 'coin' }, { label: 'Custo dos produtos vendidos', value: 'R$ 63.547,00', note: 'Quanto custaram os itens vendidos', icon: 'box' }, { label: 'Gastos da empresa e entregas', value: 'R$ 20.770,00', note: 'Valores já pagos no período', icon: 'chart' }, { label: 'Lucro estimado antes de impostos', value: 'R$ 31.223,00', note: 'Veja como chegamos a esse valor abaixo', icon: 'check' }]} />
    <div className="demo-two-column"><DemoPanel title="Faturamento por mês" subtitle="Valores de exemplo"><div className="demo-chart" role="img" aria-label="Gráfico fictício do faturamento mensal">{months.map((month) => <div className="demo-chart-column" key={month.label}><span style={{ height: `${month.value}%` }} /><small>{month.label}</small></div>)}</div></DemoPanel><DemoPanel title="Como calculamos o lucro" subtitle="Faturamento líquido menos produtos e gastos pagos"><dl className="demo-detail-list"><div><dt>Faturamento bruto</dt><dd>R$ 120.000,00</dd></div><div><dt>Descontos aplicados</dt><dd>− R$ 4.460,00</dd></div><div><dt>Faturamento líquido</dt><dd>R$ 115.540,00</dd></div><div><dt>Custo dos produtos vendidos</dt><dd>− R$ 63.547,00</dd></div><div><dt>Gastos da empresa pagos</dt><dd>− R$ 16.616,00</dd></div><div><dt>Pagamentos de entrega</dt><dd>− R$ 4.154,00</dd></div><div className="demo-total-definition"><dt>Lucro estimado antes de impostos</dt><dd>R$ 31.223,00</dd></div></dl><p className="demo-footnote">Compras de produtos entram na conta do lucro quando os produtos são vendidos. Período de exemplo encerrado em {dateLabel(today)}.</p></DemoPanel></div>
    <DemoPanel title="Pedidos concluídos" subtitle="Exemplo do que compõe cada venda"><DemoTable caption="Pedidos de exemplo no relatório" headings={['Data', 'Pedido / cliente', 'Total da venda', 'Custo dos produtos', 'Custo registrado?']} rows={getOrders(today).slice(0, 4).map((order) => [dateLabel(order.createdOn), <span>{orderLink(order)}<small className="demo-table-subline">{getCustomers(today).find((customer) => customer.id === order.customerId)?.name}</small></span>, brl(order.totalCents), brl(Math.round(order.totalCents * 0.55)), <DemoBadge tone="success">Sim</DemoBadge>])} /></DemoPanel>
  </div>
}

function SettingsPreview({ today }: { today: string }) {
  return <div className="page-stack demo-preview-page">
    <DemoHeading eyebrow="OPERAÇÃO · PREFERÊNCIAS" title="Configurações" description="Perfil, acesso, aparência e regras da operação." />
    <div className="demo-two-column"><DemoPanel title="Dados da empresa" subtitle="Perfil demonstrativo"><dl className="demo-detail-list"><div><dt>Nome</dt><dd>Shalom Adonai · exemplo</dd></div><div><dt>Município</dt><dd>Niterói, Rio de Janeiro</dd></div><div><dt>Fuso horário</dt><dd>America/Sao_Paulo</dd></div><div><dt>Cadastro iniciado</dt><dd>{dateLabel(day(today, -30))}</dd></div></dl><ReadOnlyButton>Editar dados</ReadOnlyButton></DemoPanel><DemoPanel title="Aparência" subtitle="Preferências de exemplo"><ul className="demo-setting-list"><li><span><strong>Tema</strong><small>Claro</small></span><DemoBadge>Ativo</DemoBadge></li><li><span><strong>Cor de destaque</strong><small>Azul</small></span><DemoBadge>Ativo</DemoBadge></li></ul></DemoPanel></div>
    <DemoPanel title="Equipe de demonstração" subtitle="Perfis fictícios; nenhuma permissão será alterada"><DemoTable caption="Equipe fictícia" headings={['Pessoa', 'Perfil', 'Acesso', 'Situação']} rows={[[<span className="demo-secondary-copy"><strong>Conta proprietária (exemplo)</strong><small>gestao@example.com</small></span>, 'Proprietário', 'Todas as áreas', <DemoBadge tone="success">Ativo</DemoBadge>], [<span className="demo-secondary-copy"><strong>Atendimento (exemplo)</strong><small>atendimento@example.com</small></span>, 'Equipe', 'Clientes, pedidos e atendimento', <DemoBadge tone="success">Ativo</DemoBadge>]]} /></DemoPanel>
  </div>
}

function MorePreview({ today }: { today: string }) {
  const links: Array<{ to: string; title: string; detail: string; icon: IconName }> = [
    { to: '/clientes', title: 'Clientes', detail: 'Cadastros e histórico', icon: 'people' }, { to: '/atendimento', title: 'Atendimento', detail: 'Retornos e contatos', icon: 'phone' }, { to: '/whatsapp', title: 'WhatsApp', detail: 'Conversas de exemplo', icon: 'message' }, { to: '/pedidos', title: 'Pedidos', detail: 'Vendas e entregas', icon: 'bag' }, { to: '/catalogo', title: 'Catálogo', detail: 'Produtos e combos', icon: 'tag' }, { to: '/estoque', title: 'Estoque', detail: 'Saldos e movimentações', icon: 'box' }, { to: '/entregas', title: 'Entregas', detail: 'Fila de despacho', icon: 'truck' }, { to: '/financeiro', title: 'Dashboard', detail: 'Faturamento e pagamentos', icon: 'coin' }, { to: '/relatorios', title: 'Relatórios', detail: 'Vendas, gastos e lucro estimado', icon: 'reports' }, { to: '/configuracoes', title: 'Configurações', detail: 'Perfil, acesso e aparência', icon: 'settings' },
  ]
  return <div className="page-stack demo-preview-page"><DemoHeading eyebrow="NAVEGAÇÃO · MÓDULOS" title="Mais ferramentas" description={`Acesso a todas as áreas da demonstração · ${dateLabel(today)}.`} /><div className="demo-module-grid">{links.map((item) => <Link className="demo-module-card" key={item.to} to={item.to}><span><Icon name={item.icon} /></span><strong>{item.title}</strong><small>{item.detail}</small><Icon className="demo-module-arrow" name="arrow" /></Link>)}</div></div>
}

function DemoDefaultPage({ path }: { path: string }) {
  const today = useBusinessToday()
  if (path === '/clientes') return <CustomerList today={today} />
  if (path.startsWith('/clientes/')) return <CustomerDetail customerId={path.split('/').at(-1) ?? ''} today={today} />
  if (path === '/atendimento') return <FollowUpsPreview today={today} />
  if (path === '/whatsapp') return <WhatsAppPreview today={today} />
  if (path.startsWith('/whatsapp/')) return <WhatsAppPreview inbox today={today} />
  if (path === '/pedidos/novo') return <OrdersPreview today={today} newOrder />
  if (path.startsWith('/pedidos/')) return <OrdersPreview today={today} detailId={path.split('/').at(-1)} />
  if (path === '/pedidos') return <OrdersPreview today={today} />
  if (path === '/catalogo') return <CatalogPreview today={today} />
  if (path === '/estoque') return <InventoryPreview today={today} />
  if (path === '/entregas') return <DeliveriesPreview today={today} />
  if (path === '/financeiro/saidas') return <OutflowsPreview today={today} />
  if (path === '/financeiro') return <ReceivablesPreview today={today} />
  if (path === '/relatorios') return <ReportsPreview today={today} />
  if (path === '/configuracoes') return <SettingsPreview today={today} />
  if (path === '/mais') return <MorePreview today={today} />
  return <CustomerList today={today} />
}

export function DemoPreviewPage() {
  const { pathname } = useLocation()
  return <DemoDefaultPage path={pathname} />
}
