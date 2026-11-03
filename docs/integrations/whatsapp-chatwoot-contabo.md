# WhatsApp no Shalom Adonai: Chatwoot na Contabo

## Objetivo

Atender conversas do WhatsApp dentro do Shalom Adonai e associá-las a clientes e pedidos. O proprietário indicou a Contabo como caminho preferido para hospedar a integração. A Contabo fornece o servidor; o Chatwoot fornece a caixa de atendimento; a plataforma oficial da Meta conecta o número do WhatsApp.

```text
WhatsApp Business Platform (Meta)
                 ↕
        Chatwoot hospedado na VPS
                 ↕ painel embutido
       Aplicativo Shalom Adonai
```

O proprietário escolheu embutir o painel original do Chatwoot dentro do Shalom. Isso é diferente de carregar WhatsApp Web em um iframe. O Chatwoot continua sendo o serviço de atendimento e a plataforma oficial da Meta continua conectando o número.

O iframe mostra o atendimento do Chatwoot, mas não associa por conta própria a conversa ao cadastro ou pedido no Shalom. Esses vínculos manuais permanecem na caixa nativa alternativa até que uma integração de contexto seja definida.

Não encontramos uma configuração oficial do Chatwoot para autorizar o domínio que pode incorporar o painel `/app`. O Chatwoot v4.19.1 usa os padrões Rails 7, que enviam `X-Frame-Options: SAMEORIGIN`; por isso um iframe simples entre domínios seria bloqueado. O Caddy deste repositório remove esse cabeçalho somente na resposta do Chatwoot e adiciona `Content-Security-Policy: frame-ancestors` com a origem exata do Shalom. Essa customização precisa ser validada na instalação real antes de ser considerada operacional.

O login do Shalom não inicia sessão no Chatwoot. Na primeira etapa, cada agente entra com sua própria conta Chatwoot dentro do painel. Para reduzir problemas com cookies em iframes, os dois endereços devem usar HTTPS e subdomínios do mesmo domínio registrável, por exemplo `app.exemplo.com` e `chat.exemplo.com`; isso melhora a compatibilidade, mas ainda precisa ser testado nos navegadores usados pela equipe. A origem autorizada no Caddy deve ser apenas a origem do aplicativo, sem caminho e sem curinga. A revogação de acesso deve ser feita também no Chatwoot quando alguém sair da equipe, pois as contas e sessões ainda não são sincronizadas com o Shalom.

## Estado confirmado no repositório

- A rota `/whatsapp/caixa-shalom` oferece busca, filtros de status, histórico e resposta de texto, resolução/reabertura, vínculo manual com cliente e pedido, contador de mensagens não lidas, atualização da leitura ao abrir uma conversa e estado das mensagens enviadas quando o Chatwoot informa `sent`, `delivered`, `read` ou `failed`.
- O estado de envio fica oculto quando o Chatwoot ainda não recebeu um estado para a mensagem; ausência de indicador não é tratada como falha.
- A função `supabase/functions/chatwoot-inbox` implementa a chamada ao Chatwoot e lê URL, conta, caixa e token de secrets do servidor.
- A migration `20261103170953_whatsapp_chatwoot_links.sql` cria os vínculos locais entre conversas, clientes e pedidos.
- A rota `/whatsapp` abre o painel original em iframe quando `VITE_CHATWOOT_DASHBOARD_URL` contém uma URL HTTPS válida de `/app`; sem ela, mostra a implantação como pendente. A URL é pública e não contém token.
- A rota `/whatsapp/caixa-shalom` preserva a caixa nativa baseada na API como alternativa. Ela ainda depende da migration hospedada, da Edge Function publicada e dos secrets do Chatwoot.
- O Caddy exige `SHALOM_APP_ORIGIN` e só permite que essa origem incorpore o painel. O valor não deve ser `*`.
- A política CSP do host do Shalom também precisa permitir carregar o domínio do Chatwoot em `frame-src`; não há `frame-src` configurado no repositório atualmente.
- A migration não foi aplicada ao Supabase hospedado e a função ainda não foi publicada.
- Não há instância Chatwoot, domínio público, URL de embed, credenciais da Meta ou número de WhatsApp configurados.

O sistema deve continuar mostrando a integração como pendente até que uma conversa real seja recebida e uma resposta real seja entregue. Não use dados de demonstração para aparentar conexão.

## Roteiro de implantação

### 1. Preparar a hospedagem

- Contratar ou selecionar uma VPS Contabo em nome do proprietário. A preferência pela Contabo não significa que a compra ou provisionamento já estejam autorizados ou concluídos.
- Escolher um domínio ou subdomínio para o Chatwoot e apontar um registro DNS `A` para o IP da VPS.
- Escolher também o domínio do aplicativo Shalom. Usar HTTPS e subdomínios do mesmo domínio registrável para permitir uma sessão de Chatwoot confiável no iframe; por exemplo `app.exemplo.com` e `chat.exemplo.com`.
- Definir `SHALOM_APP_ORIGIN` no `.env` da VPS como a origem HTTPS exata do Shalom. O Caddy a usa como única origem permitida em `frame-ancestors` e remove `X-Frame-Options: SAMEORIGIN`, que bloquearia o painel entre origens.
- Se a hospedagem do Shalom emitir uma política CSP própria, liberar o domínio HTTPS do Chatwoot em `frame-src`. Após a publicação, inspecionar os cabeçalhos reais nos dois hosts: uma política anterior do Chatwoot com `frame-ancestors` mais restrito ainda poderá bloquear o iframe.
- Instalar Chatwoot em uma versão mantida igual ou superior a **4.19.0**. A autenticação Bearer usada pelo adaptador foi adicionada nessa versão. O bundle neste repositório fixa a release **4.19.1**.
- Configurar HTTPS, URL pública, envio de e-mail para recuperação de acesso, armazenamento persistente, atualizações e backups testáveis.
- Não publicar Postgres ou Redis diretamente na internet. Restringir o SSH e manter acesso administrativo protegido.
- Usar como ponto de partida uma VPS com pelo menos 4 GB de RAM, 4 núcleos recomendados e no mínimo 1 GB de swap para atualizações, conforme os requisitos atuais do Chatwoot. O volume necessário depende do histórico e dos anexos.

O bundle reproduzível está em [`ops/chatwoot`](../../ops/chatwoot/README.md) e usa Docker Compose, Caddy para HTTPS, PostgreSQL com pgvector e Redis. É uma preparação versionada; nenhuma VPS ou domínio foi provisionado.

### 2. Criar a caixa de atendimento

- Criar a conta e o inbox de WhatsApp no Chatwoot.
- Criar uma conta de agente para cada pessoa autorizada no Shalom e testar o login dentro do iframe e em uma nova guia. A sessão e as permissões do Chatwoot são próprias do Chatwoot.
- Configurar `VITE_CHATWOOT_DASHBOARD_URL` na aplicação com a rota `/app/accounts/<id>/inbox` da instalação. Essa URL não é um segredo; não colocar tokens ou credenciais nela.
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
2. Fazer login no Chatwoot dentro do iframe, navegar pelas conversas e confirmar que a sessão persiste após atualizar o Shalom; repetir em celular e em uma nova guia. Confirmar `frame-src` no Shalom e `frame-ancestors` no Chatwoot pelas respostas HTTP.
3. Responder pelo painel e confirmar a entrega no telefone remetente.
4. Confirmar o fluxo de entrada e saída em uma origem não autorizada e verificar que o navegador bloqueia o iframe; testar também os links para nova guia e para a caixa nativa.
5. Confirmar atualização do estado da conversa e vínculo manual com cliente e pedido usando a caixa nativa alternativa.
6. Verificar mensagens com anexos, falhas de rede, token inválido e usuário sem acesso de proprietário na alternativa via API.
7. Confirmar que backups do Chatwoot podem ser restaurados e que a tela do Shalom informa claramente indisponibilidade quando o serviço não responde.

Até completar essas verificações, a integração é uma estrutura de código e uma preparação de implantação, não uma conexão operacional.

## Referências oficiais

- [Chatwoot: instalação de produção com Docker](https://developers.chatwoot.com/self-hosted/deployment/docker)
- [Chatwoot: requisitos de sistema atuais](https://developers.chatwoot.com/self-hosted/deployment/requirements)
- [Chatwoot: instalação de produção em VM Linux](https://developers.chatwoot.com/self-hosted/deployment/linux-vm)
- [Chatwoot: variáveis de ambiente](https://developers.chatwoot.com/self-hosted/configuration/environment-variables)
- [Chatwoot: APIs e uso da Application API em integrações internas](https://developers.chatwoot.com/api-reference/introduction)
- [Chatwoot v4.19.1: configuração que carrega os padrões Rails 7](https://github.com/chatwoot/chatwoot/blob/v4.19.1/config/application.rb)
- [Chatwoot: discussão sobre painel de agente em iframe e Platform APIs](https://github.com/chatwoot/chatwoot/issues/4316)
- [Rails: cabeçalhos de segurança padrão](https://guides.rubyonrails.org/configuring.html#configuring-action-dispatch)
- [Caddy: editar cabeçalhos da resposta do proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers)
- [MDN: cookies SameSite em contexto de iframe](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#samesite)
- [Chatwoot: conectar WhatsApp Cloud API manualmente](https://app.chatwoot.com/hc/user-guide/articles/1756799850-how-to-setup-a-whats_app-channel-manual-flow)
- [Chatwoot: opções de conexão para WhatsApp](https://chatwoot.help/hc/user-guide/articles/1677832735-how-to-setup-a-whats_app-channel)
- [Chatwoot v4.19.0: suporte à autenticação Bearer para tokens de API](https://github.com/chatwoot/chatwoot/releases/tag/v4.19.0)
- [Chatwoot v4.19.1: release fixada no bundle de implantação](https://github.com/chatwoot/chatwoot/releases/tag/v4.19.1)
