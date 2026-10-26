# Keus sign-in and sign-up — email, Google, and GitHub

## Current implementation status

The Keus `/login` page now offers separate **Sign in** and **Create account** modes. Registration is **open self-service** (confirmed by the user): anyone who verifies an eligible email or completes an enabled social login can create a Keus account. Email uses WorkOS Magic Auth six-digit codes; new verified identities create a Keus account on successful verification, while an existing verified email is linked to its existing account. Email-code requests are rate-limited locally and by WorkOS; codes are never returned to the browser or stored in Keus.

Google and GitHub now have separate, provider-specific WorkOS OAuth start routes and share the same CSRF-protected callback and Keus-local session creation. The Create account mode uses the same provider flow: a first verified identity creates a Keus account, while an existing identity is linked to its existing account. The provider-specific WorkOS OAuth endpoint does not accept AuthKit's screen hint; Keus keeps the account mode in its own UI and avoids sending unsupported parameters. Each social button remains disabled until its matching WorkOS provider is configured and its server-side `WORKOS_*_OAUTH_ENABLED=1` flag is set. Passkey sign-in is not part of this first login build.

The user reports that WorkOS test-mode email-code login succeeded in the port-3100 preview and that Create account did create an account, but the flow did not show an obvious next step. The app now marks first-time Keus identities and sends new users to `/onboarding`; existing users go to `/app`. The route fix is implemented and covered by tests, but has not yet been confirmed by the user in a restarted preview or hosted deployment. This is still a test-mode result—not production email delivery. Google/GitHub OAuth remain unverified and require their WorkOS provider connections, server-side flags, and an exact reachable callback. The temporary WorkOS test key/client ID are held only in the preview server's process memory and are cleared when it stops; do not put credentials or one-time codes in chat or tracked files.

**Test-mode email-code login was reported successful by the user on 2026-10-26.** The isolated agent preview has an opt-in development setup page at `/__dev/workos-setup` for entering a WorkOS `sk_test_` key directly in the browser. The key is held only in server-process memory, never written to a file or logged, and disappears when the preview server stops. The route is development-only and rejects live keys. This is not a production email-delivery test; do not use a WorkOS test credential in production.

WorkOS Magic Auth uses a six-digit code, not a clickable link. Codes expire after 10 minutes. WorkOS’s default sender is WorkOS-branded; no Keus sending domain is required for this pilot. Shared-sender delivery remains subject to WorkOS’s safeguards and is not guaranteed.

## Create and configure the WorkOS project

1. In the WorkOS Dashboard, open the Keus staging application. The local redirect URI `http://localhost:3100/auth/callback` is already registered.
2. In the WorkOS Dashboard, open **Authentication**, enable **Magic Auth**, and keep self-service sign-up enabled for this public-registration policy. Do not add an invite-only gate unless the product decision changes.
3. In **Authentication → OAuth providers**, configure and enable Google and/or GitHub for the same staging environment. Set `WORKOS_GOOGLE_OAUTH_ENABLED=1` and/or `WORKOS_GITHUB_OAUTH_ENABLED=1` only after confirming each provider is enabled in that WorkOS environment. WorkOS staging credentials are for testing only. [Google setup](https://workos.com/docs/integrations/google-oauth) · [GitHub setup](https://workos.com/docs/integrations/github-oauth)
4. Register the exact callback URI for the app in WorkOS. For deployment, use the service’s HTTPS callback, e.g. `https://<your-render-service>.onrender.com/auth/callback`, and set `WORKOS_REDIRECT_URI` to the same value.
5. Keep test credentials in the staging environment only; never use a test key in production.

## Ephemeral staging test in the agent preview

The current preview server has the development setup enabled and initializes a temporary SQLite database automatically. The live preview root (`/`) serves the Connect WorkOS page directly; `/__dev/workos-setup` is an alias. Enter the WorkOS **test** API key (`sk_test_…`) and matching client ID, then return to `/login` and request a code. The page posts credentials over HTTPS with a short-lived setup token; the key is held only in server memory, never logged or written to disk. The setup endpoint accepts only test-key prefixes. The preview's exact origin is explicitly allowlisted for the setup POST/preflight; reload the setup form after a server restart because the token and any in-memory credentials are reset. Google and GitHub remain disabled in this preview because OAuth cannot return through the proxy using the registered localhost callback. Do not register the e2b preview URL as the WorkOS callback. Email-code sign-in can be tested here; OAuth end-to-end needs a callback reachable by both the browser and WorkOS.

## Configure Keus server environment

For local development, create a root-level `.env.local` (it is git-ignored) using these values; the Keus `dev` and `start` scripts load that file. For deployment, use the host’s private environment/secrets manager. Do **not** put secrets in browser code, tracked files, or chat:

```dotenv
AUTH_PROVIDER=workos
WORKOS_API_KEY=<replacement server-side WorkOS API key>
WORKOS_CLIENT_ID=<WorkOS client ID>
WORKOS_REDIRECT_URI=http://localhost:3100/auth/callback
# Turn each flag on only after enabling that OAuth provider in this WorkOS environment.
WORKOS_GOOGLE_OAUTH_ENABLED=0
WORKOS_GITHUB_OAUTH_ENABLED=0
TURSO_DATABASE_URL=file:./keus.local.db
# Required only for remote Turso:
TURSO_AUTH_TOKEN=
PORT=3100
```

The root `npm run dev` and the `apps/web` workspace `dev`/`start` scripts load the root `.env.local` automatically; deployments should inject values through the host’s private environment settings. The database is required to preserve Keus account IDs and sessions. Startup applies migrations including `0002_workos_identity.sql` and `0003_workos_email_code_requests.sql` without editing the checksum-protected first migration.

## Local test flow

1. Run Keus on port 3100 with the private environment above.
2. Open `/login`. Enter an inbox you control and request a code. The UI shows a generic confirmation and never reveals whether an address is registered.
3. Enter the six-digit code. On success, Keus sets an HttpOnly session cookie and opens `/app`.
4. Check `GET /api/auth/session` and sign out to confirm the Keus-local session is revoked.
5. Use **Google** or **GitHub** when the matching WorkOS provider is enabled and its server-side flag is set. Both routes use the same state-validated callback and create or link a Keus account after WorkOS verifies the identity.

The WorkOS callback verifies OAuth `state` using a short-lived HttpOnly/SameSite cookie. Email-code authentication calls WorkOS directly, then links the verified WorkOS user ID to a Keus user; a matching normalized verified email reuses the existing Keus ID and its usage/ownership rows.

## Boundaries

- Do not claim email delivery, Google, or GitHub are live until configured and tested with valid private credentials. Buttons default to disabled until the matching OAuth enable flag is explicitly set.
- Signing out revokes the Keus session; it does not necessarily sign the user out of a separate WorkOS browser session.
- In the current working copy, production workspace aliases (`/`, `/app`, `/desktop`, `/desktop.html`) and `/onboarding` are guarded by a valid Keus session. This does not gate every product/API route; protect any future data/action API separately before connecting product behavior.
- Passkeys should be enabled only after choosing a stable relying-party domain; changing the domain later can require re-enrollment.
- Transaction-bound desktop WebAuthn approval remains separate from account sign-in.
- No custom domain purchase is authorized. WorkOS’s default email sender is used for the pilot.
