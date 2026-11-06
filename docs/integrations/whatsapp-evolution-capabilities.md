# Recursos de WhatsApp no Shalom

O Shalom usa a Evolution API diretamente. O conjunto disponível depende da versão instalada e do tipo de conexão (Baileys ou WhatsApp Business Cloud). “Todas as funções do aplicativo WhatsApp” não é uma interface única garantida pela API; cada recurso precisa ter evento/endpoint e suporte confirmados no canal conectado.

## Cobertura desta primeira etapa

| Recurso | Situação no código | Observação |
| --- | --- | --- |
| Conversas e mensagens de texto | Integrado | Eventos da Evolution abastecem a caixa; a equipe pode responder com texto. |
| Entrega e leitura de mensagens | Integrado | Estados recebidos pelo webhook aparecem na conversa; abrir uma conversa zera as não lidas no Shalom. |
| Imagens, áudio, vídeo, documentos e figurinhas recebidos | Integrado | Metadados são salvos; o conteúdo é buscado sob demanda com limite de tamanho. |
| Contatos e telefones | Integrado | Nome e telefone recebidos podem atualizar a conversa. |
| Cliente Shalom por telefone | Integrado | Associação automática só com número brasileiro completo e único. Usa `remoteJidAlt` quando disponível e também reconcilia conversas existentes quando um cliente é cadastrado ou tem o telefone alterado; duplicidades exigem escolha manual. |
| Registro de chamadas | Integrado por eventos | A aba de chamadas e a seção Atendimento mostram os eventos enviados pela Evolution, agrupando pelo ID da chamada quando disponível. |
| Vínculo manual de cliente e pedido | Integrado | A gestão pode escolher outro cadastro ou pedido. Um vínculo manual não é substituído pela sincronização. |
| Histórico inicial | Integrado por evento | `MESSAGES_SET` é importado sem somar o histórico antigo como mensagens não lidas. A quantidade de histórico depende do que a Evolution sincronizar. |
| Resolver/reabrir conversa | Integrado | Estado operacional do Shalom; não altera o status do chat no aplicativo conectado. |

## Limites e próximas funções

Ainda faltam envio de mídia, respostas citadas, reações no conteúdo original, edição, localização, cartões de contato, grupos/participantes/etiquetas, presença e publicação de Status. A exclusão recebida é refletida no histórico, mas não há ação de apagar mensagens pelo Shalom. Esses recursos devem ser adicionados somente após validar as rotas da versão instalada e seu suporte no canal; a caixa não deve exibir uma ação que falhe silenciosamente.

O evento `CALL` fornece metadados conforme o provedor os envia. O Shalom não atende chamadas, não grava áudio e não inventa duração ou resultado quando esses campos não chegam. A versão Evolution fixada no teste local deve continuar restrita ao computador até ser atualizada e revisada.

## Para validar o fluxo real

1. Iniciar a Evolution e o Supabase local na mesma rede Docker.
2. Aplicar a migration e servir as Edge Functions apenas no ambiente local.
3. Conectar um número dedicado de teste e configurar o webhook pela caixa do Shalom.
4. Conferir recebimento, resposta, anexos, evento de chamada, estados de entrega e associação de telefone; repetir eventos para confirmar que não duplicam registros.

Até esse fluxo ser executado, o código e o build confirmam somente que a aplicação foi preparada; não confirmam mensagens nem chamadas reais.
