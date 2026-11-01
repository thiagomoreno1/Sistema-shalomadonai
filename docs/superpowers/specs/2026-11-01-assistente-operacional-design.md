# Assistente operacional — desenho aprovado

## Objetivo

Reduzir o trabalho manual do dono, que é o único operador do sistema. Entregadores não acessam o app. O comprador final também não é usuário do sistema.

## Direção

Fazer a automação em etapas, começando por atalhos determinísticos baseados em dados que o negócio já registrou. Depois, adicionar um assistente interno de texto que transforme instruções do dono em rascunhos estruturados.

### Etapa 1 — automatizações sem IA

- Repetir um pedido anterior como rascunho, copiando somente cliente e itens/quantidades; recalcular preços atuais e revisar antes de salvar. Entrega, endereço, desconto, taxa, observações e vencimentos são confirmados novamente.
- Permitir modelos de vencimentos definidos pelo dono e editáveis ao aplicar. O sistema não escolhe prazo, intervalo, número de parcelas nem forma de pagamento por conta própria.
- Preparar sugestões de alocação de recebimento e possíveis clientes duplicados, sempre sujeitas à conferência.

O sistema já preenche o endereço salvo quando o cliente é selecionado, gera a entrega junto com o pedido e baixa estoque somente na confirmação de despacho ou retirada.

### Etapa 2 — assistente interno

- Entrada inicial por texto dentro do sistema.
- Primeiro caso de uso: instrução para criar pedido usando clientes e produtos já cadastrados.
- O assistente identifica dados e perguntas pendentes, resolve nomes contra os registros autorizados do negócio e prepara um rascunho para a tela atual de pedido. Na repetição, a prévia separa o que foi copiado, recalculado e ainda precisa ser informado.
- Se houver ambiguidade, mostra opções; se faltar um dado obrigatório, pergunta. Não inventa preços, estoque, datas, prazos, acordos ou pagamentos.
- O dono revisa e confirma. A gravação continua usando a RPC existente `create_order`, com sua validação e idempotência.
- O assistente não tem acesso a SQL livre nem ferramentas genéricas de escrita.

## Limites de autonomia

O sistema pode calcular totais, reutilizar endereços e históricos autorizados, carregar modelos escolhidos, detectar possíveis duplicidades e ordenar prioridades a partir dos dados existentes.

O sistema não pode registrar recebimento, marcar despesa como paga, despachar entrega, lançar perda/devolução de estoque ou enviar mensagem externa sem um evento real e confirmação explícita. Repetir um pedido nunca copia recebimentos anteriores.

## Privacidade e arquitetura

- A aplicação atual é React/Vite com acesso autenticado ao Supabase; não há provedor de IA nem função de servidor para IA configurados.
- Qualquer chave de modelo fica exclusivamente em segredo de servidor. A IA responde em formato estruturado validado; a autorização, resolução de registros e gravação são validadas pelo servidor e pelas RPCs/RLS existentes.
- Não confiar em `business_id`, IDs ou permissões produzidos pelo modelo. Usar o negócio associado à sessão autenticada.
- Minimizar dados enviados ao provedor. Não guardar prompts completos ou dados pessoais desnecessários em logs.
- Antes da primeira chamada, informar que o texto digitado poderá ser processado pelo provedor escolhido. Não enviar telefone, endereço, observações, saldos ou histórico de pagamentos; nomes e lista mínima de produtos/clientes só serão enviados se necessários para interpretar o pedido.
- Antes da etapa de IA, o dono precisa aprovar provedor, custo, tratamento/retenção dos dados e habilitar os segredos necessários.

## Fora do escopo inicial

- Portal ou conta para compradores finais.
- Entrada por voz, envio automático de mensagens, WhatsApp, Open Finance, cobrança ou movimentação financeira automática.
- Automação de compras, despacho, ajuste físico de estoque ou regras contábeis presumidas.

## Critérios de sucesso

- O dono redigita menos itens e condições em pedidos repetidos.
- Valores calculados continuam vindo do catálogo atual e do servidor.
- Rascunhos podem ser editados, cancelados e confirmados sem duplicar pedidos.
- Nenhuma ação financeira ou operacional externa é confirmada pelo modelo.
- Dados de outro negócio nunca são consultados nem enviados no contexto da IA.
- As mensagens da interface deixam claro o que foi copiado, sugerido ou ainda precisa ser preenchido.
