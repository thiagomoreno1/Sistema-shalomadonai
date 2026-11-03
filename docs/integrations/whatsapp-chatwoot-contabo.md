# WhatsApp no Shalom Adonai: Chatwoot na Contabo

## Objetivo

Atender conversas do WhatsApp dentro do Shalom Adonai e associá-las a clientes e pedidos. O proprietário indicou a Contabo como caminho preferido para hospedar a integração. A Contabo fornece o servidor; o Chatwoot fornece a caixa de atendimento; a plataforma oficial da Meta conecta o número do WhatsApp.

```text
WhatsApp Business Platform (Meta)
                 ↕
        Chatwoot hospedado na VPS
                 ↕ API
       Função segura no Supabase
                 ↕
     Caixa nativa no Shalom Adonai
```

A caixa nativa já existe no código. Ela não é uma cópia visual do WhatsApp Web: apresenta conversas do Chatwoot dentro do Shalom, sem expor o token do Chatwoot ao navegador.

## Estado confirmado no repositório

- A rota `/whatsapp` oferece busca, filtros de status, histórico e resposta de texto, resolução/reabertura, vínculo manual com cliente e pedido, contador de mensagens não lidas, atualização da leitura ao abrir uma conversa e estado das mensagens enviadas quando o Chatwoot informa `sent`, `delivered`, `read` ou `failed`.
- O estado de envio fica oculto quando o Chatwoot ainda não recebeu um estado para a mensagem; ausência de indicador não é tratada como falha.
- A função `supabase/functions/chatwoot-inbox` implementa a chamada ao Chatwoot e lê URL, conta, caixa e token de secrets do servidor.
- A migration `20261103170953_whatsapp_chatwoot_links.sql` cria os vínculos locais entre conversas, clientes e pedidos.
- A migration não foi aplicada ao Supabase hospedado e a função ainda não foi publicada.
- Não há instância Chatwoot, domínio público, credenciais da Meta ou número de WhatsApp configurados.

O sistema deve continuar mostrando a integração como pendente até que uma conversa real seja recebida e uma resposta real seja entregue. Não use dados de demonstração para aparentar conexão.

## Roteiro de implantação

### 1. Preparar a hospedagem

- Contratar ou selecionar uma VPS Contabo em nome do proprietário. A preferência pela Contabo não significa que a compra ou provisionamento já estejam autorizados ou concluídos.
- Escolher um domínio ou subdomínio para o Chatwoot e apontar um registro DNS `A` para o IP da VPS.
- Instalar Chatwoot em uma versão mantida igual ou superior a **4.19.0**. A autenticação Bearer usada pelo adaptador foi adicionada nessa versão.
- Configurar HTTPS, URL pública, envio de e-mail para recuperação de acesso, armazenamento persistente, atualizações e backups testáveis.
- Não publicar Postgres ou Redis diretamente na internet. Restringir o SSH e manter acesso administrativo protegido.

O guia oficial do Chatwoot documenta instalação em uma VM Linux ou via Docker Compose, além de domínio, proxy HTTPS e variáveis necessárias. A opção de instalação deve ser escolhida quando a VPS e o domínio estiverem definidos.

### 2. Criar a caixa de atendimento

- Criar a conta e o inbox de WhatsApp no Chatwoot.
- Escolher o fluxo de conexão Meta antes de registrar o número. O método manual da Cloud API não oferece coexistência com o aplicativo WhatsApp Business; o fluxo Quick Setup com Meta pode oferecer essa opção, conforme disponibilidade da conta.
- Em uma instalação própria, o superadministrador do Chatwoot precisa configurar as credenciais da Meta antes de disponibilizar o Quick Setup.
- Guardar o ID da conta, ID do inbox e token de API fora do repositório e do navegador.

### 3. Conectar Meta e Supabase

- Configurar o número e o aplicativo WhatsApp Business na Meta, com as permissões e o webhook exigidos pelo método escolhido.
- Aplicar a migration de vínculos e publicar a função Edge após a revisão de configuração e autorização operacional para as mudanças no Supabase hospedado.
- Configurar `CHATWOOT_BASE_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_INBOX_ID` e `CHATWOOT_API_TOKEN` como secrets da função. Configurar `CHATWOOT_ATTACHMENT_ALLOWED_HOSTS` somente se anexos usarem domínios externos de armazenamento.
- Preservar a verificação JWT e a autorização de proprietário. O token de Chatwoot nunca deve ir para variáveis `VITE_*`, respostas ao navegador ou logs.

### 4. Verificar a operação de ponta a ponta

Com um número de teste aprovado ou o número autorizado pelo proprietário:

1. Enviar uma mensagem ao número comercial e confirmar que ela aparece na caixa do Shalom.
2. Responder pelo Shalom e confirmar a entrega no telefone remetente.
3. Confirmar atualização do estado da conversa e vínculo manual com cliente e pedido.
4. Verificar mensagens com anexos, falhas de rede, token inválido e usuário sem acesso de proprietário.
5. Confirmar que backups do Chatwoot podem ser restaurados e que a tela do Shalom informa claramente indisponibilidade quando o serviço não responde.

Até completar essas verificações, a integração é uma estrutura de código e uma preparação de implantação, não uma conexão operacional.

## Referências oficiais

- [Chatwoot: instalação de produção com Docker](https://developers.chatwoot.com/self-hosted/deployment/docker)
- [Chatwoot: instalação de produção em VM Linux](https://developers.chatwoot.com/self-hosted/deployment/linux-vm)
- [Chatwoot: variáveis de ambiente](https://developers.chatwoot.com/self-hosted/configuration/environment-variables)
- [Chatwoot: APIs e uso da Application API em integrações internas](https://developers.chatwoot.com/api-reference/introduction)
- [Chatwoot: conectar WhatsApp Cloud API manualmente](https://app.chatwoot.com/hc/user-guide/articles/1756799850-how-to-setup-a-whats_app-channel-manual-flow)
- [Chatwoot: opções de conexão para WhatsApp](https://chatwoot.help/hc/user-guide/articles/1677832735-how-to-setup-a-whats_app-channel)
- [Chatwoot v4.19.0: suporte à autenticação Bearer para tokens de API](https://github.com/chatwoot/chatwoot/releases/tag/v4.19.0)
