# WhatsApp no Shalom Adonai: Evolution API e Chatwoot

## Objetivo

Atender conversas do WhatsApp dentro do Shalom Adonai e associá-las a clientes e pedidos. O proprietário indicou a Contabo como caminho preferido para hospedar a integração. Neste primeiro fluxo, a Evolution API conecta um número de teste por QR/Baileys ao Chatwoot, que fornece a caixa de atendimento. A Cloud API oficial da Meta ligada diretamente ao Chatwoot é uma alternativa separada, fora desta primeira prova.

```text
WhatsApp (Evolution API)
                 ↕
        Chatwoot hospedado na VPS
                 ↕ painel embutido
       Aplicativo Shalom Adonai
```

O proprietário escolheu embutir o painel original do Chatwoot dentro do Shalom e agora indicou a Evolution API como caminho para conectar o WhatsApp. O Chatwoot continua sendo a caixa de atendimento; a Evolution faz a conexão com o WhatsApp. A hospedagem da Contabo continua como intenção, ainda sem VPS ou domínio provisionados.

O Compose local usa a versão fixada `v2.3.7` e serve apenas para a primeira prova de API/QR. O modo QR/Baileys será testado com um número dedicado; não conecte o número de operação antes de validar a sessão e a integração. O próprio projeto descreve limitações do modo WhatsApp Web, e a equipe do Chatwoot esclarece que Evolution é um canal de terceiros não oficialmente suportado. Trate Evolution–Chatwoot como compatibilidade a validar, não como integração garantida.

Há um relato aberto no repositório oficial da Evolution sobre a versão `v2.3.7`: `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=false` não oculta o token de instância na resposta de `/instance/fetchInstances`. Por isso, o Compose local prende a API a `127.0.0.1`; esta versão não deve ser publicada diretamente na internet antes de confirmar a correção ou uma proteção de rede adequada.

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
- `ops/evolution` prepara uma instância local da Evolution API, com PostgreSQL, Redis, sessão persistente e chave gerada localmente. O serviço fica vinculado a `127.0.0.1:8080`; nenhum segredo ou endpoint da Evolution é enviado ao navegador.
- O Compose local cobre apenas a API e o QR. A instância local não é alcançável pelo Chatwoot remoto nem pelo Supabase hospedado. A prova ponta a ponta exige uma URL HTTPS protegida para a Evolution, hospedada na mesma VPS do Chatwoot ou em outro host alcançável por ele.
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

### 2. Preparar Evolution e Chatwoot

- Para a prova local, abrir o Docker Desktop, aguardar o Engine e seguir `ops/evolution/README.md`. Se `docker version` não mostrar a seção `Server`, o Engine ainda não está pronto e os containers não podem iniciar.
- Escolher o tipo de conexão antes de parear: QR/Baileys para um número dedicado de teste é o primeiro caminho proposto. A Cloud API oficial conectada diretamente ao Chatwoot é uma alternativa separada. O projeto não salva nem envia QR de demonstração.
- Quando a VPS estiver provisionada, hospedar a Evolution em uma URL HTTPS que o Chatwoot alcance. Não use uma URL `localhost` no serviço hospedado.
- Criar a conta no Chatwoot e gerar um token de agente. Ao criar a instância com os parâmetros de integração do Chatwoot, a Evolution pode criar o inbox automaticamente; não crie outro inbox para o mesmo número. Validar a conexão no ambiente de teste antes de ser considerada operacional.
- Criar uma conta de agente para cada pessoa autorizada no Shalom e testar o login dentro do iframe e em uma nova guia. A sessão e as permissões do Chatwoot são próprias do Chatwoot.
- Guardar o ID da conta, ID do inbox e token de API fora do repositório e do navegador.

### 3. Abrir o painel Chatwoot no Shalom

- Configurar `VITE_CHATWOOT_DASHBOARD_URL` na aplicação com a rota `/app/accounts/<id>/inbox` da instalação. Essa URL não é um segredo; não colocar tokens ou credenciais nela.
- Validar `frame-src` no Shalom e `frame-ancestors` no Chatwoot pelas respostas HTTP.

### 4. Configurar a caixa do Shalom e Supabase

- Para Evolution com QR/Baileys, criar a instância e vincular a conta do Chatwoot usando a URL HTTPS, o ID da conta e o token de Chatwoot. A Evolution cria o inbox; depois, localizar seu ID no Chatwoot e atualizar `CHATWOOT_INBOX_ID` na função do Shalom. Para a alternativa Cloud API conectada diretamente ao Chatwoot, configurar o número e o aplicativo WhatsApp Business na Meta com as permissões e o webhook exigidos.
- Aplicar a migration de vínculos e publicar a função Edge após a revisão de configuração e autorização operacional para as mudanças no Supabase hospedado.
- Configurar `CHATWOOT_BASE_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_INBOX_ID` e `CHATWOOT_API_TOKEN` como secrets da função. Configurar `CHATWOOT_ATTACHMENT_ALLOWED_HOSTS` somente se anexos usarem domínios externos de armazenamento.
- Preservar a verificação JWT e a autorização de proprietário. O token de Chatwoot nunca deve ir para variáveis `VITE_*`, respostas ao navegador ou logs.

### 5. Verificar a operação de ponta a ponta

Com um número e um inbox dedicados a teste:

1. Enviar uma mensagem ao número de teste e confirmar que ela aparece na caixa do Chatwoot embutida no Shalom.
2. Fazer login no Chatwoot dentro do iframe, navegar pelas conversas e confirmar que a sessão persiste após atualizar o Shalom; repetir em celular e em uma nova guia. Confirmar `frame-src` no Shalom e `frame-ancestors` no Chatwoot pelas respostas HTTP.
3. Responder pelo painel e confirmar a entrega no telefone remetente; verificar também status, mídia e reconexão.
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
- [Evolution API: Docker e requisitos de PostgreSQL/Redis](https://github.com/evolution-foundation/docs-evolution/blob/main/v2/en/install/docker.mdx)
- [Evolution API: instância vinculada ao Chatwoot e geração de QR](https://github.com/evolution-foundation/evolution-docs/blob/main/docs/03-Instance%20contoller/00-create-instance.md)
- [Evolution API: provedores Baileys e Cloud API e versão estável](https://github.com/evolution-foundation/evolution-api/releases)
- [Evolution API: relato aberto sobre o token retornado por `fetchInstances` na v2.3.7](https://github.com/evolution-foundation/evolution-api/issues/2677)
- [Chatwoot: Evolution é uma integração de terceiros](https://github.com/orgs/chatwoot/discussions/13391)
