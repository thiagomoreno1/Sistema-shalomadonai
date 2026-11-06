# Plano: Evolution API direta no Shalom

## Objetivo

Retirar Chatwoot do fluxo do Shalom e construir uma caixa nativa que use Evolution API, com mensagens, identificação de clientes e registros de chamadas. A paridade integral com o aplicativo WhatsApp não é presumida; recursos são liberados conforme suporte verificável no canal/versão conectado.

## Primeira entrega

### 1. Dados e segurança

- [x] Criar a migration da caixa, mensagens, vínculos e eventos de chamadas, com RLS/grants por empresa.
- [x] Garantir constraints de mesma empresa entre conversa, cliente e pedido.
- [x] Evitar persistir payload integral, segredos ou mídia Base64.

### 2. Entrada de eventos

- [x] Validar segredo do webhook e instance name antes de processar o corpo.
- [x] Normalizar mensagens recebidas/enviadas, estado inicial sincronizado, estados de entrega, exclusões e CALL; estado da conexão vem do endpoint da Evolution.
- [x] Deduplicar mensagens e eventos de chamada.
- [x] Registrar chamada mesmo quando `@lid` não revelar telefone; não inferir estado/duração ausente.
- [x] Associar cliente automaticamente apenas quando um telefone brasileiro normalizado encontrar um único cadastro ativo, incluindo `remoteJidAlt` e reconciliação ao cadastrar/alterar telefone; preservar vínculo manual e limpar associação automática que fique ambígua.

### 3. Caixa e resposta

- [x] Migrar API autenticada para Supabase/Evolution sem expor credenciais.
- [x] Manter lista, histórico, busca, não lidas, resolver/reabrir, resposta de texto, contexto cliente/pedido e visualização de anexos recebidos.
- [x] Mostrar alternância entre conversas e chamadas, eventos na conversa e registro resumido no módulo Atendimento.
- [x] Vincular `/whatsapp` à caixa nativa e remover Chatwoot do fluxo ativo do produto.
- [x] Manter estados de configuração, erro, vazio e indisponibilidade visíveis.

### 4. Execução local

- [x] Documentar secrets em `supabase/functions/.env` (ignorado pelo Git) e configuração do webhook.
- [x] Documentar rede Docker local necessária entre Supabase Functions e Evolution.
- [x] Manter `evoapicloud/evolution-api:v2.3.7` loopback-only; sem número real, deploy de função ou migration hospedada.
- [x] Produzir build do frontend; não executar suíte de testes sem solicitação.
- [ ] Revisar diff, fazer commit/push do código coeso e informar o status real.
- [ ] Aplicar migration e validar mensagens/chamadas ponta a ponta com número dedicado de teste.

## Limites conhecidos

- O evento `CALL` da Evolution contém metadados de chamadas. Não promete áudio gravado, duração, status final confiável, chamada dentro do navegador ou controles de atender/recusar.
- A versão v2.3.7 tem relato de evento `offer` suprimido quando quem liga vem como `@lid` e respostas/recusa automáticas estão configuradas. A aplicação não ativará esses ajustes; o log preserva número desconhecido.
- A instalação local não alcança Supabase hospedado; o teste hospedado requer API Evolution corrigida em endpoint HTTPS/rede privada.

## Próximas etapas (não entram na primeira entrega)

1. Envio de imagem, áudio, vídeo e documento.
2. Respostas citadas, reações, edição e exclusão conforme endpoints confirmados.
3. Sincronização de contatos, fotos, grupos, participantes e etiquetas.
4. Localização, contatos, listas/botões, presença, status e automações onde suportados.
5. Revisão por canal: Baileys e Cloud API não expõem necessariamente o mesmo conjunto.

Antes de ativar cada item, conferir a API e a versão instaladas e deixar explícito na tela quando o provedor não oferecer aquele recurso.
