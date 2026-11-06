# Recursos de WhatsApp no Shalom

O Shalom usa a Evolution API diretamente. O conjunto disponível depende da versão instalada e do tipo de conexão (Baileys ou WhatsApp Business Cloud). “Todas as funções do aplicativo WhatsApp” não é uma interface única garantida pela API; cada recurso precisa ter evento/endpoint e suporte confirmados no canal conectado.

## Cobertura desta primeira etapa

| Recurso | Situação no código | Observação |
| --- | --- | --- |
| Conversas e mensagens de texto | Integrado | Eventos da Evolution abastecem a caixa; a equipe pode responder com texto. |
| Envio de arquivos | Integrado | A gestão pode enviar imagem, áudio, vídeo MP4 e PDF de até 2 MiB pela conversa. |
| Entrega e leitura de mensagens | Integrado | Estados recebidos pelo webhook aparecem na conversa; abrir uma conversa zera as não lidas no Shalom. |
| Imagens, áudio, vídeo, documentos e figurinhas recebidos | Integrado | Metadados são salvos; o conteúdo é buscado sob demanda com limite de tamanho. |
| Contatos e telefones | Integrado | Nome e telefone recebidos podem atualizar a conversa. |
| Cliente Shalom por telefone | Integrado | Associação automática só com número brasileiro completo e único. Usa `remoteJidAlt` quando disponível e também reconcilia conversas existentes quando um cliente é cadastrado ou tem o telefone alterado; duplicidades exigem escolha manual. |
| Registro de chamadas | Integrado por eventos | A aba de chamadas e a seção Atendimento mostram os eventos enviados pela Evolution, agrupando pelo ID da chamada quando disponível. |
| Vínculo manual de cliente e pedido | Integrado | A gestão pode escolher outro cadastro ou pedido. Um vínculo manual não é substituído pela sincronização. |
| Histórico inicial | Integrado por evento | `MESSAGES_SET` é importado sem somar o histórico antigo como mensagens não lidas. A quantidade de histórico depende do que a Evolution sincronizar. |
| Resolver/reabrir conversa | Integrado | Estado operacional do Shalom; não altera o status do chat no aplicativo conectado. |
| Configurar instância, exibir QR e trocar número | Integrado | A gestão pede o QR explicitamente, desconecta a sessão atual e pode parear outro número escaneando o novo QR. |

## Limites e próximas funções

Ainda faltam respostas citadas, reações no conteúdo original, edição e exclusão de mensagens enviadas, localização, cartões de contato, grupos/participantes/etiquetas, presença e publicação de Status. Esses recursos devem ser adicionados somente após validar as rotas da versão instalada e seu suporte no canal; a caixa não deve exibir uma ação que falhe silenciosamente.

O evento `CALL` fornece metadados conforme o provedor os envia. O Shalom não atende chamadas, não grava áudio e não inventa duração ou resultado quando esses campos não chegam. A versão Evolution fixada no teste local deve continuar restrita ao computador até ser atualizada e revisada.

## Para validar o fluxo real

1. A configuração hospedada mantém endereço e chaves no Vault do Supabase. O computador da Evolution precisa ficar ligado e acessível pelo túnel temporário durante esta prova.
2. Na caixa do Shalom, a gestão pode criar a instância e solicitar um QR; nada é pareado antes da leitura manual.
3. Depois do pareamento, o Shalom configura o webhook e recebe mensagens, anexos, estados de entrega e metadados de chamadas.
4. Conferir recebimento, resposta, envio de arquivo, chamada e associação de telefone; repetir eventos para confirmar que não duplicam registros.

Até alguém escanear o QR, não há sessão de WhatsApp conectada e, portanto, não há conversas ou chamadas reais para exibir. O túnel Cloudflare usado para esta prévia é temporário e não substitui hospedagem permanente da Evolution.
