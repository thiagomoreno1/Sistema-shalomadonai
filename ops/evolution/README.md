# WhatsApp local com Evolution API

O Shalom conversa diretamente com a Evolution API. A caixa própria do Shalom recebe mensagens, anexos, atualizações de entrega e eventos de chamada por webhook. O Chatwoot não faz parte desse fluxo.

## Contabo

Use `compose.contabo.yaml` only as an overlay to the pinned `compose.yaml`. The public origin is `https://shalomadonai.duckdns.org`; create the root-owned VPS `.env` from `.env.contabo.example` and set the unique `SERVER_URL`, `EVOLUTION_API_KEY`, `POSTGRES_PASSWORD`, and `REDIS_PASSWORD` values. The DuckDNS A record must point to the Contabo IPv4 address `45.13.235.147` before Caddy is reloaded. Do not publish an AAAA record unless the VPS has a reachable IPv6 address. Caddy obtains and renews the hostname certificate automatically over ports 80/443; do not use the IP-only `shortlived` ACME profile for this hostname.

The Caddy proxy supplies the Shalom origin for Supabase Edge Function requests, which arrive without an `Origin` header; the API allows only the Shalom origin and keeps credentialed CORS disabled. The Evolution Manager and API docs are disabled because Shalom uses its own UI. Keep `EVOLUTION_API_KEY`, `POSTGRES_PASSWORD`, and `REDIS_PASSWORD` in a root-owned `.env` file with mode `0600`; never commit it.

The production API binds only to `127.0.0.1:8081`. The complete Caddy site in this directory routes `/evolution/*` to that loopback listener and keeps the database and Redis private. Do not replace it with `ops/contabo/Caddyfile`, which serves only the static app. The Contabo VPS must have Caddy installed and enabled, persistent Caddy certificate storage, the current Shalom release at `/var/www/shalom-releases/current`, and firewall access for ports 22, 80, and 443. Validate the Caddyfile with `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` before reloading. The running deployment stores Caddy's config and certificate state on the VPS; monitor `systemctl status caddy` and `journalctl -u caddy` for renewal errors.

After the DNS record and HTTPS site are verified, update the hosted Supabase settings: set Auth's Site URL to `https://shalomadonai.duckdns.org`, allow `https://shalomadonai.duckdns.org/redefinir-senha` as a redirect URL, and set the Vault secret `evolution_api_url` to `https://shalomadonai.duckdns.org/evolution`. Keep the Evolution webhook callback URL at the Supabase Edge Function URL; its webhook secret and API key do not change.

Create the named session volume before first startup. Preserve it and the project-scoped PostgreSQL/Redis volumes; **do not run `docker compose down -v`** on the production project.

```sh
docker volume create shalom-evolution-prod_evolution_instances
docker compose -p shalom-evolution-prod --env-file .env -f compose.yaml -f compose.contabo.yaml up -d
```

For a data migration from the local Windows Compose project, stop the source Evolution API before creating the final PostgreSQL dump and archiving the container path `/evolution/instances`. Run in PowerShell from the repository root, changing `C:\secure-transfer` to a private staging directory:

```powershell
$evolution = 'ops/evolution'
$transfer = 'C:\secure-transfer'
New-Item -ItemType Directory -Force $transfer | Out-Null
docker compose -f "$evolution/compose.yaml" --env-file "$evolution/.env" stop evolution-api
docker exec shalom-evolution-local-postgres-1 sh -c 'pg_dump -Fc -U evolution -d evolution -f /tmp/evolution.dump && chmod 600 /tmp/evolution.dump'
docker cp shalom-evolution-local-postgres-1:/tmp/evolution.dump "$transfer/evolution.dump"
docker cp shalom-evolution-local-evolution-api-1:/evolution/instances "$transfer/instances"
tar -czf "$transfer/instances.tar.gz" -C $transfer instances
```

Transfer only `evolution.dump` and `instances.tar.gz` over SSH into `/root/transfer` on Contabo, then restore in this order:

```sh
docker volume create shalom-evolution-prod_evolution_instances
docker compose -p shalom-evolution-prod --env-file .env -f compose.yaml -f compose.contabo.yaml up -d postgres redis
until [ "$(docker inspect --format '{{.State.Health.Status}}' shalom-evolution-prod-postgres-1)" = healthy ]; do sleep 2; done
docker cp /root/transfer/evolution.dump shalom-evolution-prod-postgres-1:/tmp/evolution.dump
docker exec shalom-evolution-prod-postgres-1 sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -U evolution -h 127.0.0.1 -d evolution /tmp/evolution.dump'
docker run --rm -v shalom-evolution-prod_evolution_instances:/instances -v /root/transfer:/transfer:ro postgres:15-alpine sh -c 'mkdir -p /tmp/unpack && tar -xzf /transfer/instances.tar.gz -C /tmp/unpack && cp -a /tmp/unpack/instances/. /instances/ && chown -R root:root /instances'
docker compose -p shalom-evolution-prod --env-file .env -f compose.yaml -f compose.contabo.yaml up -d evolution-api
```

Keep dumps and session archives out of Git and remove temporary copies after confirming the cutover. The source database and volume are a **pre-cutover snapshot**. If Contabo has accepted new messages and you need a lossless rollback, stop the Contabo API, dump its current database and session volume, restore those into the source, then start only the source API. Simply restarting the old source can lose post-cutover messages or require WhatsApp to be paired again. Never run both APIs with the same WhatsApp session at once.

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
