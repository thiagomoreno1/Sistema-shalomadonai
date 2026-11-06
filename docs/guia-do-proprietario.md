# Guia do proprietário — Shalom Adonai

**Atualizado em 06/11/2026.** Este guia descreve os fluxos do repositório e os limites do ambiente conferido. A integração direta com Evolution está em implementação; o código local ainda não significa que o número ou o webhook estejam conectados.

## Antes de começar

- Entre com seu e-mail e senha. Use **Esqueci minha senha** se precisar recuperar o acesso.
- Uma conta nova só vê os dados da empresa depois que a gestão aprova o pedido. Entregadores são registros de atribuição; não crie contas para eles.
- O cadastro inicial é manual. Nenhum cliente, produto, estoque, pedido ou lançamento de demonstração é criado pelo sistema.
- Faça primeiro cadastros reais e pequenos. Confirme o resultado antes de repetir uma operação que pareça ter falhado; várias ações financeiras e de estoque usam uma chave de repetição segura.

## Fluxo diário

1. **Painel:** abra a fila do dia para ver retornos prioritários, vencimentos e entregas que precisam de atualização. Indicadores sem dados ou com erro de configuração devem ser conferidos antes de agir.
2. **Clientes:** cadastre o cliente e seus telefones e endereços conhecidos. Quando o webhook da Evolution estiver conectado, conversas e eventos de chamadas poderão ser associados ao cadastro por um telefone brasileiro único e completo; correspondências ambíguas ou sem número ficam para escolha manual.
3. **Catálogo e estoque:** cadastre nome, preço e custo conhecidos. Para controlar estoque, informe unidade e contagem inicial; sem isso, o produto não deve ser interpretado como saldo zero. Um combo precisa ter sua composição salva.
4. **Pedido:** selecione cliente, itens e quantidades. Informe cada vencimento e valor no pedido conforme o combinado com o cliente; os prazos comuns de cesta e eletrodoméstico não são aplicados automaticamente a todo produto.
5. **Recebimento:** registre pagamentos no pedido/contas a receber. O saldo e os vencimentos aparecem na tela financeira; recebimentos parciais são aceitos.
6. **Entrega ou retirada:** só pedidos marcados explicitamente como entrega entram na fila de entregas. A baixa de estoque acontece no despacho confirmado ou quando você registra a retirada pelo cliente. Se o saldo ficar negativo, confira o aviso. Uma devolução física exige registro manual depois da conferência.
7. **Despesas e relatórios:** esta versão registra valores já pagos. Ao comprar estoque, registre a entrada física em **Estoque** e, separadamente, o pagamento em **Financeiro**; a entrada física não cria uma saída de caixa. Compra de estoque afeta o caixa quando paga; o custo do produto entra no resultado gerencial quando o item é vendido. A fórmula aprovada desconta descontos, custo congelado dos itens, despesas pagas e custo real de entrega. Se faltar custo congelado em algum item ou houver devolução sem tratamento financeiro definido, o sistema omite o resultado em vez de estimá-lo. Os relatórios podem ser filtrados por período e exportados/impressos.
8. **Conciliação bancária:** hoje a operação é manual. Ela liga movimentos a recebimentos ou saídas já registradas; conciliar não cria nem altera esses lançamentos. O agrupamento com soma exata está no código, mas depende de migrations ainda ausentes no banco hospedado.

## O que ainda não está conectado

| Área | Situação nesta versão | O que falta |
| --- | --- | --- |
| WhatsApp | Caixa própria em integração direta com Evolution está no repositório, mas ainda não foi conectada nem testada com um número. | Completar o fluxo Evolution ↔ Supabase local, aplicar a migration local, configurar webhook e validar mensagens/chamadas com um número dedicado de teste. Não usar o número operacional antes dessa validação. |
| Banco | Importação OFX/QFX e prova Belvo Sandbox existem no repositório. Não há conexão bancária ativa nem importação habilitada no banco hospedado. | Aplicar migration, validar arquivo bancário sanitizado e, para Belvo, obter credenciais sandbox, URL pública HTTPS, termos aprovados e webhook. |
| Fiscal | Não emite documentos fiscais. | Contador confirmar regime, documentos e requisitos; depois escolher e validar provedor. |
| Mensagens automáticas | Não envie lembretes, reativação ou pesquisas automaticamente. | Confirmar textos, gatilhos, horários, consentimento, opt-out e suporte do canal; só então ativar e testar. |
| Dados históricos | O cadastro manual foi escolhido para começar. | Enviar produtos e contagens iniciais e, gradualmente, os demais registros. Antes de importar em lote, inventariar volume e origem. |

O código atual tem 34 migrations versionadas; o banco hospedado tinha 22 aplicadas na conferência de 04/11/2026. As 12 restantes incluem melhorias de pedidos, clientes, OFX, equipe e conciliação agrupada. Até o rollout coordenado, recursos que dependem delas podem aparecer como indisponíveis; a interface deve informar isso sem gravar dados parcialmente.

## Backup e recuperação

### Estado atual

- A organização Supabase está no plano Free. Segundo a documentação atual do Supabase, o plano Free não recebe backups diários automáticos; esses backups estão disponíveis nos planos pagos. Não encontrei configuração versionada nem evidência de restauração testada; confirme com o responsável se existe alguma cópia manual fora do repositório.
- Um dump lógico feito pelo CLI não equivale, sozinho, a uma recuperação completa deste sistema: o comando `supabase db dump` exclui por padrão os schemas gerenciados `auth` e `storage`; os arquivos de imagem armazenados pelo Supabase Storage também precisam de cópia separada. Por padrão, o dump contém o esquema, não os dados nem os papéis personalizados; dados e papéis exigem opções próprias do comando. O dump pode conter dados pessoais e financeiros; nunca o coloque no GitHub, em chamados ou em uma pasta compartilhada sem proteção.
- O backup manual com `supabase db dump` requer o Supabase CLI, um runtime compatível com Docker e acesso autorizado à conexão do banco. Planeje essa etapa com a pessoa responsável; não cole a senha do banco em chats ou no repositório.
- Um restore feito no painel pode deixar o projeto indisponível durante a operação e descartar alterações posteriores ao ponto escolhido. Não é uma ação para testar no projeto em uso.

### Antes de inserir muitos dados ou aplicar migrations

1. Combine com a pessoa responsável um plano completo: backup do banco mais cópia separada dos objetos do Storage e registro seguro das configurações de Auth/hosting e segredos dos provedores. Armazene credenciais em um gerenciador protegido, separado dos arquivos de dados.
2. Se usar o dump do CLI, confirme que exportou dados e papéis além do esquema; copie os arquivos do Storage separadamente e registre como recuperar Auth, configurações e segredos. A exportação lógica não inclui esses componentes por padrão.
3. Confirme que as cópias terminaram, têm tamanho plausível e estão fora deste repositório. Peça a um responsável técnico para testar a restauração em ambiente isolado e conferir tabelas, quantidades e acesso.
4. Antes de uma migration, verifique a data do último backup automático e se a possível perda desde aquele ponto é aceitável. O backup diário não é uma cópia sob demanda imediatamente anterior à migration; se o ponto for antigo demais, faça uma cópia manual testada.
5. Só então marque uma janela de mudança e mantenha o app sem gravações durante a etapa combinada.

### Se algo for apagado ou ficar inconsistente

1. Pare de cadastrar ou repetir a ação afetada e anote horário, tela, registro e mensagem de erro. Não envie senhas, tokens, certificados ou dados pessoais em chamados.
2. Avise o responsável técnico antes de executar qualquer restauração. Não rode `db reset`, `db push`, `migration repair` nem restaure sobre o banco hospedado por conta própria.
3. Preserve o estado atual e escolha com o responsável um backup anterior ao incidente. Restaurar o banco inteiro pode apagar operações válidas feitas depois desse backup.
4. Restaure primeiro em ambiente separado e confira os fluxos críticos. A volta para uso requer conferir autenticação, permissões, arquivos do Storage, segredos das funções, URLs e testes de leitura/gravação.

O projeto ainda não tem um procedimento completo de recuperação testado. A cópia do banco, a cópia dos arquivos, os segredos dos provedores e as configurações de Auth/hosting são partes distintas da recuperação.

## Decisões ainda necessárias para o início operacional

- Escolher domínio e hospedagem HTTPS para publicar o app e conectar provedores.
- Definir janela e backup para aplicar as 12 migrations pendentes no Supabase hospedado.
- Ativar e testar proteção contra senhas comprometidas no Auth; a organização atual está no plano Free, e a opção requer plano pago conforme a documentação do Supabase.
- Enviar produtos, unidades, custos/preços e contagem inicial para começar a operação real.
- Confirmar com o contador os dados e documentos fiscais necessários.
- Configurar e testar Evolution/WhatsApp e, separadamente, a prova Belvo Sandbox.
- Escolher a forma de backup que cubra banco, arquivos e configurações, e testar a restauração antes de depender dela.

## Referências oficiais do Supabase

- [Backups de banco e restauração](https://supabase.com/docs/guides/platform/backups)
- [Backups manuais no plano Free](https://supabase.com/kb/faqs/platform/free-plan-backups)
- [Backup e restauração com CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Referência do comando `supabase db dump`](https://supabase.com/docs/reference/cli/supabase-db-dump)
