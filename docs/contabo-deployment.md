# Contabo web deployment

## Current setup

The repository is public and the deployer does not depend on a GitHub SSH secret, GitHub environment, or repository Admin permission. A root-owned systemd timer on the VPS checks public `main` every five minutes. It builds only when the latest GitHub Actions check suite for the exact `main` commit has successful `validate` and `database` checks; missing, pending, failed, or unavailable checks stop the deploy.

The host-side poller is `ops/contabo/shalom-deploy-poller.py`. It keeps its Git checkout root-owned, exports the checked commit into a separate build directory, and runs `npm ci && npm run build` in a pinned Node 24 container as UID 1001. The container has no Docker socket or host secrets; it receives only the public Supabase URL and publishable client key. The poller rejects links and special files in the output, writes a versioned release, atomically switches `/var/www/shalom-releases/current`, and retains the five newest versions for rollback.

The active Caddy configuration serves `/var/www/shalom-releases/current`. The production environment file belongs at `/etc/shalom-deploy.env`, owned by root with mode `0600`; it contains `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and a verified, digest-pinned `NODE_IMAGE`. Never add a service-role key, database password, Evolution API key, or SSH private key to that file or the repository.

GitHub Actions still contains an optional direct deployment job gated by `CONTABO_DEPLOY_ENABLED` and a production environment. That path needs Admin permission to configure its variables and SSH secret. The VPS timer is the active fallback for this public repository. It polls `main` over HTTPS and needs no deploy key.

## Public release prerequisites

Caddy returns HTTP to local checks on the VPS. Its firewall allows inbound SSH (port 22) only, so the website is not reachable from the public internet. The selected `shalomadonai.online` domain has not yet been registered or pointed to this server. Before opening it publicly:

1. Register and control the chosen domain, then point its DNS records to the VPS IP.
2. Change the Caddy site address in `ops/contabo/Caddyfile` to the registered hostname so Caddy can issue and renew HTTPS certificates.
3. Validate and reload Caddy, then allow inbound TCP ports 80 and 443 in the firewall.
4. Verify HTTP-to-HTTPS redirection, certificate issuance, and the deployed app from an external network.

The deployment contains only the Vite frontend. Supabase remains hosted separately. CI's `database` job starts a local Supabase database; it does not migrate the hosted database or deploy Edge Functions. The hosted migration history does not exactly match the repository: several same-named migrations use different timestamps and ten repository migration names are not recorded as applied. Reconcile the history and inspect existing objects before applying any production migration; do not use `db push` blindly. Some pending migrations backfill customer addresses or replace order and financial RPCs, so run aggregate preflight checks and obtain approval for the hosted database rollout.

Evolution API is a separate service and is not part of this static web deploy. `ops/evolution/compose.yaml` is for local use and must not be exposed as-is. Production Evolution needs its own HTTPS endpoint, credentials stored on the server/Supabase, firewall and access controls, and an approved migration/function rollout.

## Managing the poller

The versioned unit files are `ops/contabo/shalom-deploy.service` and `ops/contabo/shalom-deploy.timer`. The timer can be inspected with:

```sh
systemctl status shalom-deploy.timer
systemctl list-timers shalom-deploy.timer
journalctl -u shalom-deploy.service --since today
```

The root-installed poller is not replaced automatically when its source file changes. Review changes to `ops/contabo/shalom-deploy-poller.py`, install the reviewed file as `/usr/local/sbin/shalom-deploy-poller.py`, then restart the timer. To roll back, point `/var/www/shalom-releases/current` to one of the retained release directories and verify Caddy still returns HTTP 200.