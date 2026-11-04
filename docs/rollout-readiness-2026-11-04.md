# Preparação para ativação — 2026-11-04

Este roteiro registra o que foi conferido e organiza o próximo rollout. A auditoria do Supabase foi somente leitura; nenhuma migration, função ou configuração foi alterada no projeto hospedado.

## Estado confirmado

- Projeto `shalom-adonai` (`mnsfdcqcsluhqtzqiiun`): `ACTIVE_HEALTHY`, região `sa-east-1`.
- O Supabase registrava 22 migrations aplicadas. O repositório tem 34; estas 12 estavam pendentes, em ordem cronológica:
  1. `202611010001_dashboard_daily_trends`
  2. `20261101155000_payment_schedule_templates`
  3. `20261101155001_limit_order_installments`
  4. `20261101155002_customer_phone_match_rpc`
  5. `202611020001_order_custom_components`
  6. `202611020002_customer_import_idempotency`
  7. `20261103170953_whatsapp_chatwoot_links`
  8. `20261103173000_customer_interaction_idempotency`
  9. `20261103185422_customer_addresses`
  10. `20261103222331_bank_statement_ofx_import`
  11. `20261104005707_business_member_management`
  12. `20261104013512_bank_reconciliation_grouping`
- Nenhuma Edge Function estava publicada. Há três pastas de função no repositório: Belvo Open Finance, webhook sandbox da Belvo e inbox Chatwoot.
- A hospedagem de produção e o domínio HTTPS do aplicativo ainda não estão escolhidos.
- A organização está no plano Supabase Free. A documentação oficial informa que esse plano não recebe backups diários automáticos; o repositório não tem uma rotina externa de backup versionada nem evidência de restauração testada. Confirme com o responsável se existe cópia manual fora do repositório.

Confirme novamente a contagem de migrations e o estado dos dados imediatamente antes de qualquer mudança remota.

## Backup antes do rollout

- Defina com o responsável um backup manual seguro ou um plano com backups diários automáticos antes de aplicar migrations ou inserir um volume relevante de dados.
- Não salve dumps no repositório: arquivos de dump podem conter dados pessoais e financeiros. Mantenha o destino criptografado e com acesso restrito.
- A exportação lógica via `supabase db dump` não é recuperação completa deste app: o CLI exclui os schemas gerenciados `auth` e `storage`; por padrão, o dump contém esquema, não dados ou papéis personalizados; e os arquivos binários do Supabase Storage precisam de cópia separada. Auth, configurações e segredos de provedores também precisam de tratamento próprio.
- Backups diários não são cópias sob demanda para cada migration. Verifique a data do ponto de recuperação e, se a possível perda desde ele não for aceitável, faça e teste uma exportação manual antes da janela.
- Teste a restauração em ambiente isolado; não restaure sobre o projeto em uso sem janela, cópia preservada e verificação técnica. A restauração do painel pode deixar o projeto indisponível.
- Referências: [backups](https://supabase.com/docs/guides/platform/backups), [backup manual no plano Free](https://supabase.com/kb/faqs/platform/free-plan-backups), [backup/restauração pelo CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), [referência de `db dump`](https://supabase.com/docs/reference/cli/supabase-db-dump).

## Pontos de atenção nas migrations

- As migrations `20261101155001_limit_order_installments` e `202611020001_order_custom_components` substituem `public.create_order`; manter esta ordem.
- `202611020002_customer_import_idempotency` cria uma chave HMAC privada. Preserve o conteúdo da tabela de chaves privadas em backups; não recrie a chave sem um plano de compatibilidade para os registros existentes.
- `20261103185422_customer_addresses` copia endereços de entrega legados não vazios para a nova tabela. É um preenchimento adicional de dados.
- `20261104005707_business_member_management` revoga as permissões INSERT/DELETE diretas de `authenticated` sobre `business_memberships`; o frontend atual usa os RPCs de aprovação e revogação criados por essa migration. Como ainda não existe hospedagem de produção configurada, não há um frontend publicado para coordenar agora. Antes do rollout, confirme também que nenhum preview/túnel antigo está usando o banco hospedado; aplique o backend e publique a versão compatível na mesma janela, sem deixar um cliente antigo que dependa das permissões diretas em uso.
- `20261104013512_bank_reconciliation_grouping` adiciona o vínculo de grupo como nullable e tabelas de histórico. Conciliações individuais antigas continuam sem grupo.
- Aplique a sequência pendente em ordem, pare na primeira falha e investigue a divergência antes de continuar. Não aplique somente a última migration: outras telas atuais dependem das migrations anteriores.

## Verificações realizadas e limitações atuais

- Após o commit `bb74b5e`, `npm test` passou 21/21 e `npm run build` passou. Na verificação atual, `npm test` passou 21 testes web e 1 teste local Deno do webhook Belvo; `deno check` passou para as três Edge Functions; `npm run build` passou; `npm run lint` terminou com código 0 e 22 avisos existentes em componentes fora desta mudança.
- A verificação local anterior confirmou reset/replay das 34 migrations e 51/51 asserções pgTAP. Nesta sessão, o Docker Desktop e o cliente PostgreSQL não estão instalados; `npx supabase start`, `npx supabase migration list --local` e `npx supabase db lint` não conseguiram conectar a `127.0.0.1:54322`, então não foi possível repetir o reset ou executar a nova suíte `supabase/tests/order_inventory_workflows.test.sql`. Ela tem fixtures sintéticas revertidas e cobre pedidos, parcelas, recebimentos parciais, acesso por proprietário/equipe, retirada, despacho, falta de estoque, tentativa/devolução e cancelamento. A revisão estática detectou e corrigiu uma divergência no saldo esperado; a execução pgTAP continua pendente. Quando Docker estiver disponível, inicie o stack local com `npx supabase start` e execute `npx supabase test db supabase/tests/order_inventory_workflows.test.sql`; a ajuda da CLI confirma que o destino padrão é local. Não acrescente `--remote`.
- O Deno 2.9.6 foi executado temporariamente via `npx`, sem instalação global. A primeira checagem encontrou incompatibilidade de tipo `BlobPart` na função de anexos do Chatwoot, corrigida no código; depois disso, `deno check` passou para as três Edge Functions e uma verificação de bytes em blocos confirmou a preservação do conteúdo. Isso valida tipos e montagem de bytes, mas não substitui o teste autenticado no runtime Supabase nem a chamada real ao Chatwoot.
- O advisor de segurança lista 26 funções `SECURITY DEFINER` executáveis por `authenticated`. A revisão de código encontrou checagem de proprietário nas 24 funções de negócio. As duas exceções são esperadas: `get_signup_business()` retorna somente ID/nome para a tela pública de cadastro, e `request_business_access()` cria um pedido para o usuário autenticado sem conceder acesso. A revisão foi de código e grants; não substitui teste runtime de privilégios.
- A proteção de senha comprometida está desativada no Auth hospedado; essa opção precisa ser conferida no painel Supabase.
- O advisor de performance reporta 38 chaves estrangeiras sem índice de cobertura, 25 índices ainda sem uso e uma combinação de políticas SELECT permissivas em `business_access_requests`. São itens para avaliar com carga real; não remova índices nem altere políticas em lote com base apenas nesses avisos.

## Sequência de ativação

1. Conferir novamente o ledger de migrations e a contagem dos dados de produção; escolher uma janela e confirmar backup/restauração.
2. Após autorização do responsável, aplicar as 12 migrations pendentes em ordem cronológica durante a janela de release e registrar o resultado de cada uma.
3. Na mesma janela, publicar o frontend compatível logo após concluir as migrations; assim, os novos RPCs já estarão disponíveis. Publicar Edge Functions somente depois de configurar os segredos necessários e confirmar o ambiente HTTPS.
4. Criar uma conta de teste separada, aprová-la como membro de baixo privilégio e executar os testes de aceite abaixo com registros controlados.
5. Investigar qualquer falha de Auth, RLS, migration ou função antes de inserir dados operacionais reais.

### Testes de aceite hospedados

- Login do proprietário; conta separada de membro; aprovação/revogação; confirmar que a conta de baixo privilégio não executa ações de proprietário nem acessa dados de outra empresa.
- Dashboard e criação de pedido com parcelas; confirmar que busca por telefone, endereços e componentes de combo funcionam.
- Importar um arquivo OFX/QFX de teste, validar duplicidade por FITID e confirmar que importar não concilia automaticamente nem altera relatórios financeiros.
- Conciliação bancária individual legado; grupo com soma exata; rejeição de soma menor/maior; bloqueio de fonte já conciliada; repetição segura; estorno conjunto; totais globais sem duplicação.
- Validar a interface em desktop e celular e confirmar que mensagens de erro não deixam dados parciais.

## Itens que dependem do proprietário ou de terceiros

- Aprovar a janela de mudança do Supabase e a opção de backup/restauração.
- Disponibilizar/confirmar um endereço de e-mail de teste para criar e aprovar uma conta de equipe de baixo privilégio durante o aceite.
- No painel Auth, revisar e ativar proteção contra senhas comprometidas; testar o fluxo de cadastro depois da mudança.
- Escolher hospedagem e domínio HTTPS do aplicativo. Contabo está registrado como preferência para o servidor Chatwoot, mas ainda não há VPS ou domínio provisionado.
- Para Belvo Sandbox: credenciais sandbox, origem HTTPS pública, URL aprovada de termos e segredo/registro do webhook. A prova atual não importa transações bancárias.
- Para o Chatwoot embutido: instância, domínio HTTPS, conta/caixa de entrada, token de servidor, URL `/app`, política `frame-ancestors`, sessão/cookies e onboarding da conta/número Meta/WhatsApp.
- Para documentos fiscais: contador confirmar regime tributário, documentos necessários e provedor.
- Enviar produtos e contagens iniciais de estoque quando quiser começar o cadastro manual. Clientes, pedidos e financeiro podem ser preenchidos gradualmente pelas telas existentes; não são necessários arquivos históricos para iniciar.

O redesenho visual continua por último, conforme a orientação do proprietário.
