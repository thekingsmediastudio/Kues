# Keus staging deployment blueprint for Render Free

**Status: source is in the private GitHub repository; the Render service and Turso database are not deployed yet.** This guide and `render.yaml` describe the staging deployment, not evidence of a live service, connected WorkOS tenant, or remote database. They do not include credentials or provision external accounts. The proposed free stack is Render Free web service + Turso Free database, with the owner-only Keus API Hub included in the app. Treat it as a public demo/staging environment only: Render explicitly says its Free instances are not for production, sleep after 15 minutes idle (first wake can take about a minute), and have ephemeral filesystems. The SQLite file must never be used as the hosted database; persist auth/users/sessions in Turso. Turso's current Free plan advertises 100 databases, 5 GB storage, 500 million monthly rows read, and 10 million monthly rows written ([plan details](https://turso.tech/pricing)). Render limits are documented at [Deploy for Free](https://render.com/docs/free).

## Blueprint settings

`render.yaml` describes a Node web service in Frankfurt with:

- Free plan, `npm ci` build, and the Keus web server start command.
- `/api/health` health check.
- WorkOS configured only after valid staging secrets are supplied through Render's private environment settings; its presence in the blueprint does not mean sign-in is live.
- Remote Turso URL/token supplied through private environment settings.
- Owner-only API Hub with a WorkOS email allowlist and a Render-generated 256-bit credential-encryption key.
- Production cookie behavior and PayPal Sandbox mode.

## One-time setup

1. In the Render Dashboard, choose **New → Blueprint**, connect the private repository `https://github.com/thekingsmediastudio/Kues`, and select branch `main`. The repo already contains the source and root-level `render.yaml`. If Render cannot see the repo, install/authorize Render's GitHub app for this repository. Never paste a Git access token into chat.
2. Create or select a **Turso Free** database for this staging environment. Copy its database URL and create a database auth token.
3. In the Blueprint form or Render service environment settings, provide `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `API_HUB_ADMIN_EMAILS` as private values. Use the WorkOS **staging/test** key and its matching client ID; enter the exact WorkOS email that will administer the API Hub. Render generates `API_HUB_ENCRYPTION_KEY` from the Blueprint. Preserve that generated key securely: changing or losing it makes stored API credentials unreadable. Never commit credentials or send them in chat.
4. Deploy once, then copy the public service origin from Render, for example `https://keus-staging.onrender.com`. Keus derives the callback as `<service-origin>/auth/callback` from Render's `RENDER_EXTERNAL_URL` unless an explicit `WORKOS_REDIRECT_URI` override is provided.
5. Add that exact callback URI to the WorkOS application's allowed redirects. The Keus callback is the destination after WorkOS completes sign-in.
6. In the same WorkOS staging environment, enable Google and GitHub under **Authentication → OAuth providers**. Follow the provider configuration instructions in WorkOS. If using your own Google/GitHub OAuth app credentials, configure the provider callback URI shown by WorkOS in the respective provider console; that is distinct from Keus's `/auth/callback`.
7. After the staging secrets are set, open `/login` on the Render service and test email-code sign-in using a controlled inbox. A first-time verified user should receive a Keus session and go to `/onboarding`; an existing user should go to `/app`. The user confirmed the email-code flow in the local WorkOS test preview, but this does not test the deployed Render environment. Do not claim the hosted deployment works until you test it there.
8. Sign in using the email configured in `API_HUB_ADMIN_EMAILS` and open `/api-hub`. Register a test API with read-only access first, create a short-lived agent key with only that read operation, and verify the `/api/hub/manifest` and `/api/hub/invoke` endpoints. Test write actions only with a non-sensitive test resource and an explicitly scoped key.

## Important boundaries

- Use the Render service's public URL for this staging callback, not the agent preview proxy URL.
- Keep staging keys in Render's secret environment settings. Do not put them in `render.yaml`, `.env` files committed to source control, or client-side code.
- Render Free services may sleep while idle. The first request after idle can be slow.
- Keus applies its database migrations during startup; keep Turso credentials configured before the first deployment.
- The current source is in the private GitHub repository, but the Render Blueprint still must be connected and applied. Once linked, commits to the configured branch can trigger automatic deploys.
- Production workspace aliases and `/onboarding` require a valid Keus session. This does not imply all product APIs or commerce actions are implemented or authorized.
