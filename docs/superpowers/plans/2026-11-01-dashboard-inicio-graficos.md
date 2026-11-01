# Gráficos operacionais do Início — Plano de implementação

> **Para os agentes de implementação:** Use `superpowers:subagent-driven-development` para implementar cada tarefa delimitada e revisar o conjunto ao final.

**Objetivo:** Tornar a página Início mais útil para a rotina diária, preservando as prioridades de hoje e acrescentando tendências reais de pedidos e movimento registrado.

**Arquitetura:** Criar uma RPC diária agregada e protegida por empresa, sem retornar registros individuais. O React buscará a série de até 30 dias e apresentará dois gráficos locais, com períodos de 7/30 dias, resumo textual, estados próprios e alternativa tabular acessível.

**Stack:** Supabase/PostgreSQL, React, TypeScript, CSS/SVG já existentes; nenhuma biblioteca nova.

**Especificação:** `docs/superpowers/specs/2026-11-01-dashboard-inicio-graficos-design.md`

## Restrições globais

- Manter retornos, contas vencidas/hoje e entregas como primeira seção.
- Disponibilizar períodos de 7 e 30 dias, incluindo dias sem eventos como zero.
- Usar `America/Sao_Paulo` para datas de eventos com horário.
- Mostrar recebimentos registrados e saídas pagas, sem chamá-los de saldo bancário ou resultado contábil.
- Não criar tendência de estoque sem histórico consistente.
- Preservar escopo de empresa e autorização existentes; não retornar dados de clientes/pedidos individuais.
- Não adicionar dependências de gráficos.
- Não adicionar nem executar testes automatizados sem solicitação explícita do usuário.
- Concluir a alteração com revisão, commit e push apenas dos arquivos relacionados.

## Revisão de foco

- Datas próximas à meia-noite local: recebimentos e pedidos precisam cair no dia de São Paulo.
- Dias sem movimento: aparecer como zero para manter escala e intervalo compreensíveis.
- Período inválido, futuro ou acima de 30 dias: RPC deve rejeitar a chamada.
- Empresa/usuário sem acesso: RPC não deve expor agregados de outra empresa.
- Pedidos cancelados e saídas anuladas: pedidos contam a entrada registrada; saídas anuladas ficam excluídas.

Revisar esses casos por leitura da função SQL, aplicação da migração local e inspeção manual do painel; nenhuma suíte de teste será criada ou executada.

---

### Task 1: RPC agregada diária do dashboard

**Arquivos:**
- Criar `supabase/migrations/202611010001_dashboard_daily_trends.sql`.

**Interface produzida:**
- `public.get_dashboard_daily_trends(p_business_id uuid, p_start_on date, p_end_on date)`.
- Retorna uma linha por dia com `business_date date`, `order_count bigint`, `receipts_cents bigint` e `paid_outflows_cents bigint`.
- Aceita somente intervalo inclusivo de 1 a 30 dias, sem data final futura no fuso `America/Sao_Paulo`.
- Só usuários autenticados autorizados pelo mesmo limite de empresa usado nas RPCs atuais do dashboard podem executar.

- [x] Criar a função SQL com `SECURITY DEFINER`, `search_path = ''`, referências totalmente qualificadas, validação de entrada e revogação/grant compatíveis com as funções de relatório existentes.
- [x] Gerar as datas do período e agregar `orders.created_at`, `order_payments.received_at` e `financial_outflows.paid_on` separadamente; converter timestamps para `America/Sao_Paulo`, excluir saídas anuladas e preencher dias vazios com zero.
- [x] Revisar a migração e aplicá-la somente à instância Supabase local; conferir retorno em dias vazios e a cobertura das permissões por leitura do SQL. Não consultar dados reais nem aplicar migration remota.
- [x] Fazer commit somente da migration após autorrevisão; não enviar para o remoto antes da revisão integrada.

### Task 2: Tendências na página Início

**Arquivos:**
- Modificar `apps/web/src/pages/DashboardPage.tsx`.
- Criar `apps/web/src/components/DashboardTrends.tsx` para os controles, gráficos e tabelas acessíveis.
- Modificar `apps/web/src/App.css` para hierarquia, legenda, estados e layout responsivo.

**Interface consumida:**
- Chamar `get_dashboard_daily_trends` com `businessId`, a data corrente em São Paulo e início calculado para 7 ou 30 dias inclusivos.
- Mapear o retorno para `{ business_date, order_count, receipts_cents, paid_outflows_cents }[]`.

- [x] Adicionar período padrão de 7 dias e alternância para 30 dias, mantendo estados de carregamento, erro e nova tentativa independentes das prioridades atuais.
- [x] Trocar os seis cartões financeiros de um único dia por dois painéis: barras agrupadas de recebimentos/saídas por dia e barras de pedidos criados por dia. Mostrar o resumo do período, legenda e nota de que movimento registrado não é saldo bancário.
- [x] Fornecer tabela diária expansível com valores e rótulos acessíveis; manter a informação compreensível sem cor, hover ou animação.
- [x] Tratar períodos sem dados com orientação para registrar pedidos, recebimentos ou saídas; manter alertas de estoque como estado atual, sem linha de tendência.
- [x] Usar tokens claro/escuro existentes, empilhar os painéis em telas estreitas e respeitar `prefers-reduced-motion`.
- [x] Fazer commit somente dos arquivos da interface e dos documentos aprovados após autorrevisão; não enviar para o remoto antes da revisão integrada.

### Task 3: Revisão do resultado e entrega

**Arquivos:** somente os três arquivos de produto e a migração descritos acima, além destes documentos de especificação/plano.

- [x] Revisar o diff contra os critérios de aceite; pedir revisão read-only ao especialista de produto e ao especialista de segurança de aplicação.
- [x] Abrir o painel local em tema claro e escuro e inspecionar a composição visual, a alternância 7/30 dias e os estados sem dados/erro disponíveis sem expor dados empresariais reais.
- [x] Confirmar que não há novos testes executados nem alterações alheias à tarefa.
- [x] Fazer revisão integrada, enviar os commits da branch de trabalho e integrá-los em `main`, preservando somente arquivos desta tarefa.
