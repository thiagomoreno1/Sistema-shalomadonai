# Início operacional com gráficos intuitivos

## Intenção

Fazer a página Início ajudar a equipe a decidir o que tratar hoje e como a operação está evoluindo, sem depender de números isolados do dia. Preservar as prioridades operacionais existentes e acrescentar tendências com dados reais.

## Objetivos

- Manter retornos, contas vencidas ou com vencimento hoje e entregas prioritárias no topo.
- Substituir a sequência de seis indicadores financeiros de um único dia por duas visualizações comparáveis:
  - **Movimento registrado:** recebimentos informados e saídas pagas, em reais por dia.
  - **Pedidos registrados:** quantidade de pedidos por dia de criação.
- Permitir alternar entre **7 dias** e **30 dias**.
- Manter os gráficos legíveis em tela estreita, teclado, tema claro e escuro; oferecer resumo textual e estados de carregamento, vazio, erro e recuperação.

## Fora de escopo

- Não apresentar movimento registrado como saldo bancário nem como resultado contábil.
- Não inventar tendência de estoque: ainda não há snapshots históricos consistentes. Alertas e itens de estoque em atenção continuam como informação atual.
- Não acrescentar biblioteca de gráficos nem integrar novos serviços.

## Abordagens consideradas

1. **Operação diária (escolhida):** manter as prioridades no topo e exibir tendências de recebimentos/saídas e pedidos logo abaixo. Conecta a fila de trabalho de hoje ao ritmo recente da operação.
2. **Financeiro em primeiro plano:** dar destaque principal à movimentação financeira e deslocar as prioridades operacionais para baixo. Ajuda a acompanhar dinheiro, mas reduz a visibilidade das ações urgentes ao abrir a página.
3. **Painéis por área:** separar operação, financeiro e estoque em abas. Aumenta a navegação e sugeriria tendências de estoque sem histórico suficiente; não é adequado para esta primeira versão.

## Direção de experiência

- Manter “Atenção de hoje” como primeira seção.
- Abaixo, apresentar dois painéis lado a lado em desktop e empilhados em telas estreitas. Usar barras agrupadas para as duas séries financeiras e barras diárias para a contagem de pedidos, com rótulos, legenda e valores acessíveis sem depender de hover ou cor.
- Mostrar a faixa de datas selecionada e um resumo textual dos valores do período. Trocar 7/30 dias atualiza ambos os gráficos.
- Sem lançamentos no período, explicar como começar: registrar pedidos, recebimentos ou saídas. Em falha, permitir tentar novamente.
- Usar SVG/CSS do projeto, sem dependência nova. Transições breves só ao trocar período; respeitar `prefers-reduced-motion`.

## Dados e segurança

As RPCs atuais retornam prioridades de hoje e resumos agregados, mas não uma série diária. A implementação precisará de uma RPC agregada diária, com escopo de empresa autorizado no servidor, intervalo limitado aos períodos disponíveis, dias sem eventos preenchidos com zero e datas interpretadas no fuso `America/Sao_Paulo`. Nenhum cliente ou pedido individual será devolvido.

Os recebimentos usam a data em que foram informados; as saídas usam a data do pagamento e excluem saídas anuladas. A contagem de pedidos usa a data de criação, incluindo pedidos cancelados posteriormente, e será rotulada como volume de pedidos, sem misturá-la a valores em reais. O movimento financeiro seguirá identificado como registro manual, não saldo bancário.

## Critérios de aceite

- O primeiro bloco da página continua respondendo “o que precisa de ação hoje?”.
- Os dois gráficos mostram 7 ou 30 dias completos, com escala e resumo claros; períodos sem eventos não desaparecem.
- As agregações respeitam empresa, permissões e fuso horário; estados vazio, erro, carregamento e nova tentativa são compreensíveis.
- Nenhuma afirmação de saldo bancário, resultado contábil ou tendência de estoque é criada.
- Não há dependência visual de cor, mouse ou animação para entender os dados.

## Decisões deixadas à implementação

Usar os componentes e tokens existentes e escolher a apresentação mais simples que preserve rótulos legíveis em desktop e celular. Manter atalhos e status atuais salvo se a nova hierarquia tornar algum item redundante.
