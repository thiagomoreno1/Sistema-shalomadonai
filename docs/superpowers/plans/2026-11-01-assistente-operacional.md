# Assistente operacional Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduzir a digitação do dono com atalhos de pedido e, depois, um assistente interno que prepara rascunhos de pedidos sem executar ações financeiras ou operacionais sozinho.

**Architecture:** Entregar primeiro automações determinísticas no formulário de pedidos, sem dependência de IA. Depois, adicionar uma Edge Function autenticada para converter texto em uma proposta estruturada; o navegador apresenta o rascunho e somente a confirmação do dono usa a RPC existente `create_order`.

**Tech Stack:** React, TypeScript, Vite, Supabase Auth/Postgres, SQL migrations e Supabase Edge Functions.

**Spec:** [docs/superpowers/specs/2026-11-01-assistente-operacional-design.md](../specs/2026-11-01-assistente-operacional-design.md)

## Global Constraints

- Não introduzir prazo de pagamento, quantidade de parcelas, intervalo, método de pagamento ou valor padrão sem configuração explícita do dono.
- Preços e totais de pedidos vêm do catálogo atual e são recalculados no servidor.
- O assistente só prepara rascunhos; gravações usam RPCs existentes e dependem da confirmação explícita do dono.
- Não registrar pagamentos, despesas pagas, baixa/retorno de estoque, despacho ou mensagem externa por inferência do modelo.
- Nunca expor segredo de provedor de IA no navegador; não aceitar autorização ou escopo de negócio vindos da resposta do modelo.
- Preservar escopo por negócio, RLS, validação, idempotência e histórico já existentes.
- Não armazenar prompts completos ou dados pessoais desnecessários em logs.
- Nenhum provedor, custo ou tratamento de dados de IA está aprovado; a etapa de IA fica bloqueada até decisão explícita do dono.
- Não adicionar nem executar testes automatizados nesta entrega sem autorização específica; usar revisão de diff e verificação manual autorizada.

## Review Focus

- Pedido de origem cancelado ou pertencente a outro negócio não pode ser copiado.
- Alteração de preço desde o pedido de origem deve usar o preço atual e deixar a revisão visível.
- Modelos de parcelas não podem resultar em soma diferente do pedido após arredondamento de centavos.
- Cliente/produto ambíguo, inexistente ou inativo deve pedir seleção; nunca escolher por suposição.
- Timeout, repetição de chamada ou resposta parcial do assistente não podem criar pedido duplicado.
- Texto do usuário, observações ou nomes importados não podem alterar instruções ou permissões do sistema.
- Falha do serviço de IA deve preservar o rascunho e permitir continuar manualmente.

## File Map

- Modify `apps/web/src/pages/OrderDetailPage.tsx`: ação para iniciar pedido repetido a partir de um pedido existente.
- Modify `apps/web/src/pages/NewOrderPage.tsx`: carregar uma origem autorizada, converter itens em rascunho com preços atuais e aplicar modelos de vencimentos editáveis.
- Modify `apps/web/src/pages/CustomersPage.tsx`: sugestão de possível duplicidade por telefone/WhatsApp normalizado, sem mesclar registros.
- Create `supabase/migrations/<timestamp>_payment_schedule_templates.sql`: modelos de vencimentos por negócio, autorização do dono, estrutura ordenada e limites validados.
- Create `supabase/migrations/<timestamp>_limit_order_installments.sql`: limite também aplicado pela RPC `create_order`.
- Create `supabase/migrations/<timestamp>_customer_phone_match_rpc.sql`: consulta limitada e isolada por negócio para possíveis duplicidades com dígitos normalizados.
- Create `supabase/migrations/<timestamp>_assistant_provider_consents.sql`: confirmação revogável e versionada do aviso de processamento, por usuário, negócio e provedor.
- Create `supabase/functions/operations-assistant/index.ts`: validar sessão/negócio, preparar contexto mínimo, chamar o provedor escolhido e validar saída estruturada.
- Create `apps/web/src/lib/operationsAssistant.ts`: tipos, validação da resposta e chamada autenticada da função.
- Create `apps/web/src/components/OperationsAssistant.tsx`: entrada de texto, estados de carregamento/erro, esclarecimento de ambiguidades e prévia do rascunho.
- Modify `apps/web/src/pages/NewOrderPage.tsx`: receber a proposta validada do assistente e preencher o mesmo formulário já usado manualmente.
- Modify `apps/web/src/App.tsx` ou `apps/web/src/components/AppShell.tsx` somente para disponibilizar o assistente no contexto de pedidos, sem criar rota pública.

## Phase 1 — Automação determinística

### Task 1: Repetir pedido como rascunho

**Files:**
- Modify `apps/web/src/pages/OrderDetailPage.tsx`
- Modify `apps/web/src/pages/NewOrderPage.tsx`

- [ ] Adicionar ação “Criar pedido parecido” para pedidos elegíveis, encaminhando apenas o identificador de origem.
- [ ] Carregar a origem sob a sessão atual e o escopo do negócio; rejeitar origens canceladas ou inacessíveis.
- [ ] Copiar somente o cliente e os IDs/quantidades de produtos que ainda estão ativos; recalcular cada preço usando o catálogo atual.
- [ ] Deixar entrega, endereço, desconto, taxa, observações e cronograma de vencimentos para nova confirmação. Nunca copiar pagamentos ou fatos de status.
- [ ] Mostrar uma prévia distinguindo dados copiados, preço recalculado e campos ainda necessários antes de prosseguir.
- [ ] Revisar diff e conferir manualmente: pedido repetido, produto inativo, preço alterado, origem cancelada e voltar atrás sem gravar.
- [ ] Commitar apenas os arquivos da tarefa com mensagem `feat: repeat order as draft`.

### Task 2: Modelos de vencimentos editáveis

**Files:**
- Create migration `supabase/migrations/<timestamp>_payment_schedule_templates.sql`
- Create migration `supabase/migrations/<timestamp>_limit_order_installments.sql`
- Modify `apps/web/src/pages/NewOrderPage.tsx`

- [ ] Criar tabela de modelos por negócio com nome e parcelas ordenadas por ordinal, percentual em pontos-base (somando 10.000), dias após a data-base escolhida pelo dono e método textual opcional.
- [ ] Limitar cada cronograma e cada pedido a no máximo 120 parcelas; na migration, substituir a definição ativa de `create_order` em `20261029214746_inventory_and_deliveries.sql` e validar o tamanho do array antes de `jsonb_to_recordset`, além da validação da interface.
- [ ] Aplicar grants mínimos, RLS e política owner-only; validar quantidade, ordinais únicos, percentuais não negativos e soma exata dos percentuais.
- [ ] Permitir salvar um cronograma conferido como modelo e aplicar um modelo ao pedido atual.
- [ ] Calcular valores sobre o total atual em centavos; distribuir arredondamento residual na última parcela para fechar exatamente o total.
- [ ] Calcular vencimentos a partir da data-base escolhida pelo dono, sem supor condição universal; deixar parcelas, datas e método editáveis antes de salvar.
- [ ] Revisar diff e conferir manualmente totais ímpares, datas no passado, edição após aplicação e isolamento entre negócios.
- [ ] Commitar migração e tela juntos com mensagem `feat: add editable payment schedule templates`.

### Task 3: Aviso de possível cliente duplicado

**Files:**
- Modify `apps/web/src/pages/CustomersPage.tsx`
- Create migration `supabase/migrations/<timestamp>_customer_phone_match_rpc.sql`

- [ ] Ao informar telefone ou WhatsApp, chamar uma RPC de leitura com dígitos normalizados que procure campos de telefone e WhatsApp no negócio da sessão, retornando no máximo cinco candidatos; não depender da lista paginada/carregada na tela nem enviar estes dados a provedor externo.
- [ ] A RPC deriva o negócio do usuário autenticado, usa RLS/grants mínimos e compara dígitos dos campos existentes; não aceita `business_id` do navegador como autoridade.
- [ ] Mostrar candidatos por nome e número mascarado e permitir voltar para o cadastro existente; permitir continuar após confirmação explícita quando for outra pessoa usando o mesmo telefone.
- [ ] Nunca criar bloqueio de unicidade, mesclar clientes ou alterar histórico automaticamente.
- [ ] Revisar diff e conferir manualmente números com formatação distinta, campos cruzados telefone/WhatsApp, números compartilhados, limite de candidatos, isolamento entre negócios e ausência de correspondências; commit migration e tela juntos com `feat: warn about possible duplicate customers`.

### Task 4: Sugestão de alocação de recebimento

**Files:**
- Modify `apps/web/src/pages/OrderDetailPage.tsx`
- Reuse the existing payment registration RPC; do not add a second write path.

- [ ] Add a “Sugerir mais antigas primeiro” control that creates an editable allocation draft from the outstanding installments ordered by due date and installment number.
- [ ] Preserve manual adjustment and the existing exact-total validation; do not submit automatically.
- [ ] Review diff and manually inspect partial, exact, and excessive receipt amounts before committing `feat: suggest oldest installment allocation`.

## Phase 2 — Assistente de texto, gated

**Entry gate before implementation:** owner explicitly selects the model provider and approves price, data handling/retention and server secrets. Do not provision an account or enable paid calls as part of this plan. Present a versioned data-processing notice tied to the authenticated user, business and provider before the first request; changing provider/notice version requires new acknowledgement, and the owner can revoke it before future calls. The notice explains that revocation prevents future calls but cannot recall text already sent, and retention depends on the selected provider's approved terms.

### Task 5: Authenticated draft endpoint

**Files:**
- Create `supabase/migrations/<timestamp>_assistant_provider_consents.sql`
- Create `supabase/functions/operations-assistant/index.ts`
- Add only the required endpoint configuration in `supabase/config.toml`

- [ ] Store acknowledgement version, provider, business, authenticated user, accepted/revoked timestamps under owner-only RLS; never store prompt content in this record.
- [ ] Validate the user's JWT (`verify_jwt` enabled) and derive business membership on the server; use the authenticated user's Supabase JWT and RLS for data reads, not the service-role key. Do not trust caller-supplied business scope.
- [ ] Before any model call, verify a versioned acknowledgement for this user/business/provider; display the data-processing notice if absent or stale and honor revocation. Explain that the free-text command itself may contain personal data processed by the provider, that revocation blocks future calls but does not recall prior text, and that retention follows the approved provider terms.
- [ ] Send only the minimum command and active candidate labels needed for the order intent; never include customer phone/address/notes, balances, payment history or unrelated fields. Do not persist raw prompts.
- [ ] Treat model output and all database text as untrusted; validate a strict JSON schema containing intent, allowlisted opaque candidate keys valid only for the current request, quantities, delivery flag and missing fields. The model must never provide database IDs used directly; the server resolves candidate keys to current active records in the authenticated business.
- [ ] Provide no SQL, generic function execution, payment, inventory, delivery, message-send or order-write tool to the model.
- [ ] Enforce request size, timeout and rate/cost limits; avoid storing full prompts in logs.
- [ ] Manually inspect authorization denial, ambiguous customer/product, malformed model output, timeout, prompt-injection-like text and another-business isolation before committing `feat: add secured order assistant endpoint`.

### Task 6: In-app assistant and confirmed draft

**Files:**
- Create `apps/web/src/lib/operationsAssistant.ts`
- Create `apps/web/src/components/OperationsAssistant.tsx`
- Modify `apps/web/src/pages/NewOrderPage.tsx`
- Modify `apps/web/src/App.tsx` or `apps/web/src/components/AppShell.tsx` only as needed

- [ ] Add a text command entry in the order flow. Initial supported intent is “prepare a new order”; unsupported intents return a clear explanation and stay in manual flow.
- [ ] Show the current provider/data-retention notice before the first call; require versioned acknowledgement for this user/business/provider, block absent/revoked/stale acknowledgements, and offer revocation that prevents future calls.
- [ ] Display parsed customer/product matches and questions. Require owner selection for ambiguous matches and prompt for required delivery/payment fields that have no configured rule.
- [ ] Populate the existing order form as an editable draft; show copied/suggested fields separately from manually confirmed values.
- [ ] Require an explicit owner action to save through existing `create_order`, with a stable request ID; never let the model call the write RPC.
- [ ] Preserve draft input on provider or network failure and offer the existing manual order path.
- [ ] Manually inspect keyboard-only operation, loading/error/cancel/retry, duplicate-submit prevention, and responsive layout; commit with `feat: add in-app order assistant`.

## Verification and delivery

- At each task boundary, inspect `git diff`, `git diff --check`, database policy changes and the relevant UI states; do not claim runtime or integration success without actual verification.
- Keep each task commit narrow and push completed commits to `origin/main` after review, following the user's standing Git preference.
- Do not run automated tests, build or lint under the user's current instruction; ask separately if those checks are wanted.
- After phase 1, the app remains useful with no AI provider. Do not start phase 2 until the owner approves its provider and data/cost terms.

## Deferred discovery

- Official WhatsApp integration, inbound message parsing and outbound notifications require provider selection, verified consent, copy/timing/stop rules, and separate end-to-end review.
- Voice input, bank/Open Finance automation, customer-facing portal, automatic cash receipts and unattended purchasing are outside this plan.
