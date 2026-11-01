# Central do dia — direção de experiência

## Objetivo

Fazer a página Início responder rapidamente “o que precisa de ação hoje?” e permitir encontrar os próximos pedidos sem percorrer vários cartões iguais. Preservar as tendências de 7/30 dias existentes.

## Estrutura

1. Cabeçalho curto com data atual e pergunta operacional.
2. Três contadores independentes e clicáveis: retornos vencidos ou de hoje; contas vencidas ou vencendo hoje; entregas que precisam de atualização. Não somar os valores: um pedido pode constar em mais de uma categoria.
3. Área principal em duas colunas: uma fila de ações agrupada por tipo à esquerda e até quatro pedidos recentes à direita. A fila mantém os rótulos, ordenação e destinos atuais de retornos, recebíveis e entregas. Não achatar os itens numa única ordenação porque os dados vêm de listas limitadas com critérios diferentes.
4. Gráficos de movimento financeiro e pedidos registrados de 7/30 dias logo abaixo.
5. Estoque, conexões e atalhos permanecem abaixo das tendências.

## Dados e permissões

- Reutilizar `get_dashboard_priorities` sem alterar banco ou política de acesso.
- Para pedidos recentes, consultar somente `id`, `customer_name_snapshot`, `status`, `requires_delivery` e `created_at`, com filtro explícito pela empresa ativa, data descendente e limite de quatro.
- A tabela `orders` só permite leitura para o papel autorizado pela política atual (`owner`). Executar essa consulta apenas para o papel proprietário. Para outros perfis, mostrar uma explicação curta de acesso indisponível e não tentar contornar RLS.
- Falhas na consulta de pedidos têm estado e tentativa novamente independentes das prioridades; resposta antiga não deve substituir a empresa atual.
- Não carregar pagamentos, telefone, endereço, linhas do pedido, nem exibir totais financeiros por pedido.

## Apresentação e interação

- Manter marfim, azul-marinho, superfícies e tokens claro/escuro já existentes.
- Contadores levam às áreas correspondentes; pedidos abrem seu detalhe.
- Em tela estreita, a fila de ações vem antes dos pedidos recentes.
- Rótulos e estados usam texto além de cor. Mostrar estados de carregamento, erro, vazio e indisponibilidade por papel.
- Sem animação decorativa. Preservar o feedback breve já usado nos controles e `prefers-reduced-motion`.

## Fora de escopo

- Alterar permissões de equipe, RPCs, políticas ou banco de dados.
- Somar categorias com sobreposição ou criar métricas sem fonte confiável.
- Alterar os gráficos, períodos, alertas de estoque ou integrações atuais.
