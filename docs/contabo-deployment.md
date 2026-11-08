# Contabo deployment

## Current setup

The repository is public and the deployer does not depend on a GitHub SSH secret, GitHub environment, or repository Admin permission. A root-owned systemd timer on the VPS checks public `main` every five minutes. It builds only when the latest GitHub Actions check suite for the exact `main` commit has successful `validate` and `database` checks; missing, pending, failed, or unavailable checks stop the deploy.

The host-side poller is `ops/contabo/shalom-deploy-poller.py`. It keeps its Git checkout root-owned, exports the checked commit into a separate build directory, and runs `npm ci && npm run build` in a pinned Node 24 container as UID 1001. The container has no Docker socket or host secrets; it receives only the public Supabase URL and publishable client key. The poller rejects links and special files in the output, writes a versioned release, atomically switches `/var/www/shalom-releases/current`, and retains the five newest versions for rollback.

The active Caddy configuration serves `/var/www/shalom-releases/current` at `https://45.13.235.147`. Caddy obtained a publicly trusted Let's Encrypt IP certificate using the `shortlived` profile. These certificates last 160 hours; Caddy manages renewals. HTTP redirects to HTTPS. The VPS firewall allows SSH (22), HTTP (80), and HTTPS (443); keep database, Redis, and application container ports closed.

The production environment file belongs at `/etc/shalom-deploy.env`, owned by root with mode `0600`; it contains `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and a verified, digest-pinned `NODE_IMAGE`. Never add a service-role key, database password, Evolution API key, or SSH private key to that file or the repository.

GitHub Actions still contains an optional direct deployment job gated by `CONTABO_DEPLOY_ENABLED` and a production environment. That path needs Admin permission to configure its variables and SSH secret. The VPS timer is the active fallback for this public repository. It polls `main` over HTTPS and needs no deploy key.

## Supabase deployment

Supabase remains hosted separately. CI's `database` job starts a local Supabase database; it does not deploy Edge Functions. The hosted database now has the repository's 55 migration versions: ten previously missing migrations were applied in order, and twelve timestamp aliases were reconciled after their stored SQL was verified equivalent to the repository files. The deployment used the repository's additive customer, order, finance, and Evolution migrations. Do not run `supabase db push` against another project without checking that project's migration history first.

## Evolution API status

The Vite frontend is live on Contabo, but the Evolution API itself has not been moved there. The connected Vault configuration still points at the prior temporary Cloudflare tunnel, and the local Evolution service remains on the development machine. Its PostgreSQL database and `/evolution/instances` volume may contain customer conversations and WhatsApp session credentials. Do not copy them to Contabo without the account owner's approval. A production Evolution deployment needs a separate Compose profile, loopback-only container binding behind HTTPS, private Postgres/Redis volumes, fresh server secrets, a Supabase Vault URL update, and either an approved data/session transfer or a new WhatsApp pairing.

## Managing the poller

The versioned unit files are `ops/contabo/shalom-deploy.service` and `ops/contabo/shalom-deploy.timer`. The timer can be inspected with:

```sh
systemctl status shalom-deploy.timer
systemctl list-timers shalom-deploy.timer
journalctl -u shalom-deploy.service --since today
```

The root-installed poller is not replaced automatically when its source file changes. Review changes to `ops/contabo/shalom-deploy-poller.py`, install the reviewed file as `/usr/local/sbin/shalom-deploy-poller.py`, then restart the timer. To roll back, point `/var/www/shalom-releases/current` to one of the retained release directories and verify Caddy still returns HTTP 200.
