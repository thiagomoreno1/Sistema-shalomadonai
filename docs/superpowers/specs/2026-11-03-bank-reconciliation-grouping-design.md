# Conciliação bancária agrupada

## Intent

Permitir que o proprietário concilie um único movimento bancário com vários recebimentos ou saídas pagas já registrados, como um depósito que agrupa pagamentos de clientes. A soma dos lançamentos selecionados deve corresponder exatamente, em centavos, ao valor do movimento.

## Goals

- Selecionar manualmente um ou mais lançamentos elegíveis para um movimento bancário.
- Exibir a soma acumulada e impedir a confirmação enquanto ela não for exatamente igual ao movimento.
- Salvar o grupo e todos os vínculos em uma única operação atômica e idempotente.
- Desfazer o grupo inteiro com motivo, mantendo histórico de quem conciliou, desfez e quando.
- Manter compatibilidade com conciliações individuais já registradas.
- Não alterar recebimentos, saídas, caixa, estoque ou resultado gerencial.

## Non-goals

- Ratear um lançamento entre movimentos bancários diferentes.
- Aceitar conciliação parcial ou diferença de centavos.
- Conciliar automaticamente ou habilitar importação de transações Open Finance.
- Alterar valores financeiros de origem ou criar recebimentos/saídas durante a conciliação.

## Approaches

1. **Manter o vínculo um para um:** preserva o modelo atual e é o menor trabalho, mas não permite conferir depósitos que agrupam recebimentos.
2. **Um movimento para vários lançamentos com soma exata — escolhido pelo proprietário:** cobre depósitos ou pagamentos agrupados sem criar rateios. Cada lançamento fica integralmente vinculado, o total precisa fechar em centavos e todos os vínculos podem ser desfeitos juntos.
3. **Rateio muitos para muitos:** permitiria dividir valores entre vários movimentos e lançamentos, mas introduziria regras de alocação parcial e saldos residuais que não foram pedidos.

## Constraints and behavior

- Entradas bancárias aceitam somente recebimentos; saídas bancárias aceitam somente saídas já pagas e não anuladas.
- Todos os registros devem pertencer à empresa e ainda não estar conciliados ativamente nem marcados como duplicados.
- A seleção e a confirmação são ações manuais do proprietário; sugestões existentes podem orientar, mas não conciliam por conta própria.
- O banco valida elegibilidade, direção, soma exata e concorrência dentro de uma RPC protegida e transacional.
- Um grupo já conciliado aparece como uma única unidade na lista, com seus lançamentos identificados; “Desfazer conciliação” encerra todos os vínculos do grupo.
- O modelo preserva conciliações históricas individuais e seus motivos de reversão.
- A mudança será versionada numa migration local. O Supabase hospedado não será alterado nesta etapa.
- Nenhuma animação é necessária; feedback textual e foco visível são suficientes, inclusive com movimento reduzido.

## Open to implementation

- Nomes e colunas exatos das tabelas de grupo e reversão, compatíveis com o esquema atual.
- Como carregar sugestões adicionais para que um conjunto de valores menores possa somar o total do movimento sem exigir busca ampla.
- Limites de itens por grupo coerentes com a quantidade máxima de registros que o Postgres e a interface conseguem validar com clareza.
