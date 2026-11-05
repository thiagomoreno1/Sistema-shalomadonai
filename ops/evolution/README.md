# Evolution API para teste local

Este Compose prepara uma instância local e isolada da Evolution API. Ela mantém PostgreSQL, Redis e sessões em volumes próprios. A porta `8080` fica disponível apenas em `127.0.0.1`; banco e Redis não são publicados no computador.

## Iniciar

Abra o Docker Desktop e aguarde o mecanismo ficar pronto. Depois, neste diretório:

```powershell
.\Initialize.ps1
docker compose up -d
```

Antes de iniciar, `docker version` deve mostrar informações de `Client` e `Server`. Se mostrar apenas `Client` ou erro de conexão, o Docker Engine ainda não está pronto.

Abra `http://127.0.0.1:8080` para conferir a API e ver a documentação interativa disponível pela instalação. Para acompanhar a inicialização:

```powershell
docker compose logs -f evolution-api
```

O `.env` recebe uma chave da API e senhas aleatórias na primeira execução e não deve ser enviado ao Git nem compartilhado no chat. O Compose usa a versão estável fixada `v2.3.7`; não usa `latest`.

## O que este teste local cobre

Esta etapa inicia apenas a Evolution. Ela permite verificar a API e, com um **número dedicado de teste**, criar uma instância, ler o QR e validar a sessão WhatsApp Web. O endpoint de criação é `POST /instance/create`; consulte a documentação interativa local para os campos e use o token global da Evolution somente no computador.

Este Compose não inclui o Chatwoot. A Evolution está presa ao endereço local `127.0.0.1`, então o Chatwoot hospedado e o Shalom publicado não conseguem alcançá-la. Para visualizar mensagens no Shalom, será necessário hospedar a Evolution num endereço HTTPS protegido que o Chatwoot possa acessar e configurar a integração no Chatwoot.

Quando a Evolution estiver num host HTTPS alcançável pelo Chatwoot, crie a instância de teste com a integração Chatwoot e informe a URL, o ID da conta e o token de agente. A Evolution pode criar a caixa de entrada automaticamente; não crie outra manualmente. Depois, localize o ID da caixa criada e configure-o como secret `CHATWOOT_INBOX_ID` da função do Shalom. Guarde todos os tokens em um gerenciador de secrets, fora do Git, do navegador do Shalom e do chat.

**Limite de segurança da versão fixada:** há um relato aberto na Evolution API `v2.3.7` de que `/instance/fetchInstances` ainda retorna o token da instância mesmo com `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=false`. Por isso, este Compose mantém a API somente em loopback. Não publique essa versão diretamente na internet; para um teste ponta a ponta, primeiro confirme uma versão corrigida ou proteja a API atrás de uma rede privada e proxy autenticado.

## Integração planejada

O Shalom mantém o Chatwoot como caixa de atendimento. A Evolution será o canal entre o WhatsApp e o Chatwoot; o painel embutido e a função `chatwoot-inbox` do Shalom continuam usando os dados do Chatwoot. A integração Evolution–Chatwoot precisa ser validada antes de conectar o número de operação.

Use primeiro um número dedicado de teste. O modo QR/Baileys usa a sessão do WhatsApp Web; não é a API oficial da Meta e pode ter limitações. A Cloud API oficial pode ser conectada diretamente ao Chatwoot como outro caminho, mas não faz parte desta primeira prova. A equipe do Chatwoot descreve Evolution como integração de terceiros, não como canal oficialmente suportado pelo Chatwoot.

Esta instância local não pode ser acessada pelo Supabase hospedado nem pelo Chatwoot em outra máquina. Para testes ponta a ponta, a Evolution precisa de endereço HTTPS alcançável pelo Chatwoot, idealmente na mesma VPS do Chatwoot. A URL e a chave nunca devem ser colocadas em variáveis `VITE_*` ou enviadas ao navegador.

## Parar

```powershell
docker compose down
```

Os dados continuam nos volumes nomeados para que a sessão de teste não desapareça ao parar os containers.
