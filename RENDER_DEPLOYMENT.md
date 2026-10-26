# Keus staging deployment blueprint for Render Free

**Status: the Render staging service is live at `https://keus-staging.onrender.com`.** On 2026-10-26, `/api/health` returned HTTP 200, and `/api/auth/config` reported WorkOS email sign-in enabled. The owner has accessed the API Hub and registered a GitHub read connector; the agent manifest succeeds, but the first GitHub read invocation returned `connector_request_failed`. The underlying Node `autoSelectFamily` DNS callback mismatch is fixed locally and awaits push/auto-deploy verification. Google and GitHub sign-in are still disabled. Turso setup is user-confirmed; the deployed database path still needs an end-to-end Hub call test. This is a public demo/staging environment, not production. Render Free instances are not for production, sleep after 15 minutes idle, and have ephemeral filesystems. Keus stores persistent auth/app data in Turso, not the Render filesystem. Turso Free currently includes 100 databases, 5 GB storage, 500 million monthly rows read, and 10 million monthly rows written ([plan details](https://turso.tech/pricing)); Render Free limits are documented at [Deploy for Free](https://render.com/docs/free).

## Blueprint settings

`render.yaml` describes a Node web service in Frankfurt with:

- Free plan, `npm ci` build, and the Keus web server start command.
- `/api/health` health check.
- WorkOS configured only after valid staging secrets are supplied through Render's private environment settings; its presence in the blueprint does not mean sign-in is live.
- Remote Turso URL/token supplied through private environment settings.
- Owner-only API Hub with a WorkOS email allowlist and a Render-generated 256-bit credential-encryption key.
- Production cookie behavior and PayPal Sandbox mode.

## Initial deployment and remaining verification

1. **Done:** the Render Blueprint is connected to private repo `thekingsmediastudio/Kues` on `main`; it created the `keus-staging` web service from root `render.yaml`.
2. **Done per owner:** a Turso database was created and configured in Render. Runtime persistence still needs an authenticated end-to-end check.
3. **Done:** WorkOS staging config is active, email sign-in is enabled, and the owner has accessed the Hub console. Keep `API_HUB_ADMIN_EMAILS` set to that exact verified WorkOS email. Render generated `API_HUB_ENCRYPTION_KEY`; preserve that value. Never commit secrets or send them in chat.
4. **Service origin:** `https://keus-staging.onrender.com`. The public health endpoint returned HTTP 200. WorkOS derives the callback as `<service-origin>/auth/callback` from Render's `RENDER_EXTERNAL_URL` unless `WORKOS_REDIRECT_URI` is overridden. The owner has reached an authenticated Hub route, so the deployed callback is responding.
5. **Social sign-in pending:** `/api/auth/config` currently reports Google and GitHub disabled. In WorkOS, configure the OAuth providers, then set `WORKOS_GOOGLE_OAUTH_ENABLED=1` and `WORKOS_GITHUB_OAUTH_ENABLED=1` in Render and let it redeploy.
6. After updating the admin allowlist, sign in at `/login`, open `/api-hub`, and register a read-only test API first. Create a short-lived agent key scoped only to that read operation, then verify `/api/hub/manifest` and `/api/hub/invoke`. Test writes only with a non-sensitive test resource and an explicitly scoped key.

## Important boundaries

- Use the Render service's public URL for this staging callback, not the agent preview proxy URL.
- Keep staging keys in Render's secret environment settings. Do not put them in `render.yaml`, `.env` files committed to source control, or client-side code.
- Render Free services may sleep while idle. The first request after idle can be slow.
- Keus applies its database migrations during startup; keep Turso credentials configured before the first deployment.
- The Render Blueprint is connected to the private GitHub repository and applied. Commits to the configured `main` branch can trigger automatic deploys.
- Production workspace aliases and `/onboarding` require a valid Keus session. This does not imply all product APIs or commerce actions are implemented or authorized.
