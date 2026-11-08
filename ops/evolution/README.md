# WhatsApp local com Evolution API

O Shalom conversa diretamente com a Evolution API. A caixa própria do Shalom recebe mensagens, anexos, atualizações de entrega e eventos de chamada por webhook. O Chatwoot não faz parte desse fluxo.

## Contabo

Use `compose.contabo.yaml` only as an overlay to the pinned `compose.yaml`. On the VPS, set `SERVER_URL` to `https://<VPS-IP>/evolution` and `CORS_ORIGIN` to the exact public origin of the Shalom app. Keep `EVOLUTION_API_KEY`, `POSTGRES_PASSWORD`, and `REDIS_PASSWORD` in a root-owned `.env` file with mode `0600`; never commit it.

The production API binds only to `127.0.0.1:8081`. The Caddy site in `Caddyfile.contabo` routes `/evolution/*` to that loopback listener and keeps the database and Redis private. Apply the overlay with:

```sh
docker compose -p shalom-evolution-prod --env-file .env -f compose.yaml -f compose.contabo.yaml up -d
```

For a data migration, stop the source Evolution API before creating the final PostgreSQL dump and archiving `/evolution/instances`. Transfer both files over SSH, restore into the target PostgreSQL container, and copy the instance directory into the target volume before starting its API. Keep dumps and session archives out of Git and delete temporary copies after confirming the cutover.

## Subir a Evolution

Abra o Docker Desktop e espere o Engine ficar pronto. Neste diretório:

```powershell
.\Initialize.ps1
docker compose up -d
```

O Manager/API abre em `http://127.0.0.1:8081`. A API escuta somente no computador; Postgres, Redis e sessões ficam em volumes locais. A chave da API e as senhas são geradas no `.env` local e não devem ser compartilhadas.

## Ligar à Supabase local

A Evolution e as funções locais do Supabase precisam compartilhar uma rede Docker. Copie `supabase/functions/.env.example` para `supabase/functions/.env` e preencha os valores para o ambiente local. Esse arquivo é ignorado pelo Git.

1. Inicie a stack local do Supabase e confira a rede com `docker network ls`.
2. Copie `supabase/functions/.env.example` para `supabase/functions/.env`. Preencha a chave da Evolution, o UUID da empresa e o segredo aleatório do webhook. Use `http://evolution-api:8080` como `EVOLUTION_API_URL`; para `EVOLUTION_WEBHOOK_URL`, informe o DNS real do container Kong na porta `8000`, seguido de `/functions/v1/evolution-webhook`.
3. Na raiz do projeto, defina o nome exato da rede Supabase e suba o override:

```powershell
$env:SUPABASE_DOCKER_NETWORK = "supabase_network_mnsfdcqcsluhqtzqiiun"
docker compose --env-file ops/evolution/.env -f ops/evolution/compose.yaml -f ops/evolution/compose.supabase.yaml up -d
Remove-Item Env:SUPABASE_DOCKER_NETWORK
```

4. No diretório do projeto, rode `supabase functions serve --env-file supabase/functions/.env` e abra `/whatsapp` no Shalom local. A gestão pode usar **Configurar recebimento** para cadastrar os eventos na Evolution.

O exemplo usa a rede e o Kong da instalação local atual. Se os nomes forem diferentes, confira os nomes reais com `docker network ls` e `docker network inspect <rede>`. Não use a chave do Supabase no lugar do segredo do webhook nem aponte as funções locais para uma Evolution pública.

## Escopo do primeiro fluxo

- Conversas, texto, situação de envio, arquivos recebidos sob demanda e estado de leitura.
- O histórico sincronizado precisa ficar salvo na base local da Evolution (`DATABASE_SAVE_DATA_HISTORIC=true`) para que mensagens antigas possam ser carregadas depois. Ativar isso agora preserva histórico futuro; não recupera mensagens que a Evolution nunca recebeu ou salvou.
- Registro dos eventos `CALL` que a Evolution entregar, exibido junto à conversa e na aba **Chamadas**.
- Associação automática somente por telefone brasileiro completo, normalizado e único entre os clientes ativos da mesma empresa. A caixa usa `remoteJidAlt` quando a Evolution fornece um telefone alternativo para um endereço `@lid` e reconcilia conversas antigas quando o cadastro do cliente é criado/alterado. Sem telefone confiável ou com duplicidade, a equipe escolhe manualmente.
- A caixa não grava áudio de chamadas, não atende ligações e não inventa duração ou resultado quando a API não envia esses dados.

O canal e a versão da Evolution podem oferecer conjuntos diferentes de recursos. Cada função extra será habilitada depois de confirmar o endpoint/evento disponível para a instalação conectada.

## Segurança

A versão local fixada `evoapicloud/evolution-api:v2.3.7` deve permanecer presa ao loopback; não publique essa versão diretamente na internet. Use um número dedicado de teste. A chave da Evolution fica nos secrets locais do servidor de funções, nunca em `VITE_*` ou no navegador. A API só pode ser considerada integrada após a Evolution e o webhook trocarem eventos pela rede local.
