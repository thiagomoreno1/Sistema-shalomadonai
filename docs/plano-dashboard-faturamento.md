# Plano do faturamento no Dashboard

**Status:** regra aplicada ao cálculo de faturamento, aos custos congelados nos pedidos, às entradas de compra e aos gráficos financeiros. Ainda falta o detalhamento de faturamento por produto e o rateio do desconto entre as linhas.

## Objetivo

Mostrar, por período, quanto foi vendido, quanto custaram os produtos vendidos e quanto sobrou depois desses custos. O cálculo deve vir dos pedidos e dos custos dos produtos cadastrados. Não depende de integração bancária, extrato, OFX, Open Finance ou conciliação.

## Quando uma venda entra no faturamento

- O pedido entra quando a entrega é concluída ou quando a retirada pelo cliente é registrada.
- Pedido aguardando separação ou em rota ainda não entra.
- Pedido cancelado ou com tentativa de entrega sem sucesso não entra.
- A data usada no Dashboard é a data da entrega concluída ou retirada registrada.
- O recebimento pode acontecer depois, por exemplo numa parcela. Isso não cria uma segunda venda nem muda a data de faturamento.

## Valores por pedido e por produto

O Dashboard deve mostrar os valores com nomes diretos:

1. **Faturamento bruto:** valor dos produtos pelo preço de venda registrado no pedido, mais a taxa de entrega cobrada do cliente, antes dos descontos. A taxa de entrega também aparece separada para não confundir venda de produto com entrega.
2. **Descontos:** valor concedido no pedido. Como o pedido permite desconto sobre produtos e taxa de entrega, o desconto é distribuído proporcionalmente entre as linhas de produtos e a taxa. A parte de cada produto segue o valor da linha; o rateio fecha exatamente nos centavos e não deixa valor negativo.
3. **Custo dos produtos vendidos:** quantidade vendida multiplicada pelo custo unitário congelado na linha do pedido.
4. **Faturamento líquido, conforme a regra solicitada:** faturamento bruto menos descontos e menos o custo dos produtos vendidos.
5. **Resultado do período:** faturamento líquido menos despesas operacionais pagas e custos reais de entrega pagos.

Exemplo: um produto é vendido por **R$ 200**, sem desconto nem taxa de entrega, e seu custo é **R$ 100**. O Dashboard mostra **R$ 200 de faturamento bruto**, **R$ 100 de custo dos produtos vendidos** e **R$ 100 de faturamento líquido**. Despesas e entregas pagas aparecem separadas e só reduzem o resultado do período.

## Como determinar o custo

- Cada produto tem um custo unitário. O custo é salvo como fotografia no pedido; mudar o cadastro depois não altera vendas antigas.
- Combo usa o custo próprio informado no cadastro do combo. **Não** soma o custo dos produtos da composição para o faturamento. A composição continua servindo para movimentar o estoque.
- O cadastro tem o custo médio unitário e os pedidos guardam uma fotografia desse custo. Cada recebimento salva quantidade e custo unitário; o sistema atualiza o custo médio ponderado: `(saldo anterior × custo médio anterior + quantidade recebida × custo unitário da compra) ÷ saldo após a entrada`. O custo de abertura precisa ser informado para saldos iniciais positivos. O novo custo vale para pedidos criados depois; pedidos antigos conservam a fotografia já salva.
- Se houver saldo positivo sem custo cadastrado, o recebimento não presume um custo para esse saldo. Primeiro, o custo-base deve ser informado no Catálogo. Quando o saldo for zero ou negativo, o custo da compra recebida estabelece o novo custo-base.
- Se faltar custo, o sistema deve sinalizar o item e não inventar um valor. O faturamento líquido e o resultado devem indicar que o cálculo está incompleto até o custo ser informado.

## Compras, pagamentos e devoluções

- Compra de estoque é uma saída de dinheiro, mas não reduz imediatamente o resultado do período. Seu custo entra no cálculo quando os produtos são vendidos.
- Despesas operacionais e custos de entrega reduzem o resultado na data em que forem registrados como pagos.
- Valores recebidos e parcelas a receber podem continuar em seus próprios indicadores. Eles não substituem o faturamento por data de entrega/retirada e não exigem ligação com banco.
- Pedido cancelado ou não concluído fica fora do faturamento.
- Devolução física depois da entrega deve aparecer como pendência de ajuste financeiro até a regra de reembolso/estorno ser definida. A devolução ao estoque, sozinha, não deve criar um reembolso fictício.

## Visão sugerida para o Dashboard

- **Indicadores no topo:** faturamento bruto, descontos, custo dos produtos vendidos, faturamento líquido, despesas pagas, entregas pagas e resultado do período.
- No cartão **Faturamento líquido**, mostrar uma explicação curta: “depois dos descontos e do custo dos produtos”.
- **Gráficos financeiros:** evolução diária de faturamento bruto, vendas após descontos, custo dos produtos e faturamento líquido; gráfico de pizza com a divisão das vendas após descontos entre custo dos produtos e faturamento líquido. O gráfico de pizza fica oculto quando há custo desconhecido, devolução sem ajuste ou faturamento líquido negativo.
- **Detalhe por produto:** unidades vendidas, faturamento bruto, desconto atribuído, custo total e faturamento líquido de cada produto; combos aparecem como um produto com seu próprio custo.
- **Resumo de despesas:** despesas operacionais e custos de entrega, separados do custo dos produtos.
- **Filtro de período:** hoje, últimos 7 dias, mês atual, últimos 30 dias, ano e intervalo personalizado. Todos os cartões, gráficos e listas devem usar as mesmas datas de entrega/retirada.

## Situação atual e próximas etapas

1. Aplicados: custo médio nas entradas e fotografia do custo no pedido; combo continua com custo próprio; gráficos diários e de pizza disponíveis na Central do dia e no Dashboard financeiro.
2. Próximo: ratear descontos entre linhas e montar totais de faturamento por produto.
3. Depois: conferir com dados reais da empresa os casos de parcelamento, entrega, retirada, cancelamento, custos ausentes, combo e devolução.

Nenhuma etapa depende de extrato bancário, OFX, Open Finance ou conciliação.
