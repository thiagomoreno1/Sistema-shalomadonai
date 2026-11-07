# Contabo automatic web deployment

A successful push to `main` runs CI first. After both `validate` and `database` pass, the `Deploy web app to Contabo` job deploys the Vite static files from `apps/web/dist`. Pull requests never deploy. This publishes only the web frontend; Supabase remains hosted separately, and Evolution API requires a separate production setup. The database job checks migrations against a local Supabase instance only; it never updates the hosted database or deploys Edge Functions. The README status dated 2026-11-03 reports newer repository migrations pending on hosted Supabase, so re-check and reconcile the hosted schema before enabling production deploys.

## One-time setup

1. Reset the Linux root credentials in the Contabo panel (the owner must set the password). Sign in to the existing Linux installation, confirm its distribution, install updates and `rsync`, then configure Caddy and create `/var/www/shalom-adonai`.
2. Create a dedicated non-root `deploy` account limited to the web root. Use a dedicated non-interactive SSH key (this workflow does not unlock passphrase-protected keys) and add only its private half as the GitHub environment secret. Keep server-side API/database credentials off the repository and out of `VITE_*`.
3. Configure Caddy to serve `/var/www/shalom-adonai` over HTTPS for the domain. The chosen hostname must be owned by the user and its DNS must point to the VPS.
4. In GitHub, open **Settings → Environments** and create the `production` environment. Add the following environment variables:
   - `VITE_SUPABASE_URL`: the hosted Supabase project URL.
   - `VITE_SUPABASE_PUBLISHABLE_KEY`: the Supabase publishable client key (never a service-role key).
   - `CONTABO_HOST`: the VPS IP or DNS hostname.
   - `CONTABO_USER`: the non-root deployment user.
   - `CONTABO_PATH`: exactly `/var/www/shalom-adonai`.
   - `CONTABO_KNOWN_HOSTS`: the verified SSH host-key line for `CONTABO_HOST`; verify the fingerprint through the server console before trusting it.
5. Add the environment secret `CONTABO_SSH_PRIVATE_KEY` with the dedicated deploy account's private key.
6. Add the repository variable `CONTABO_DEPLOY_ENABLED=true` only after the VPS account, web root, host key, and GitHub environment values are ready. Leave it unset or false until then.

The workflow does not use `ssh-keyscan` at deployment time and refuses root SSH deployment. Its rsync operation updates files in the dedicated web root without deleting other files. It writes files in place rather than swapping a versioned release; an interrupted transfer may briefly leave a mixed set of assets, so a rollback/release-retention step remains a follow-up before a high-availability release.

## Ongoing updates

When changes are committed and pushed to `main`, GitHub runs the existing checks. If those pass and `CONTABO_DEPLOY_ENABLED=true`, the workflow rebuilds the frontend with the public Supabase settings and copies the static output to Contabo. A failed check prevents deployment. Changes on other branches or pull requests do not deploy.
