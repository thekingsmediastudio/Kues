# Keus staging deployment blueprint for Render Free

**Status: the existing Render staging service is live at `https://keus-staging.onrender.com`; the account-provisioning update is not deployed yet.** On 2026-10-26, `/api/health` returned HTTP 200 and `/api/auth/config` reported WorkOS email sign-in enabled, with Google and GitHub disabled. Before this source update, unauthenticated `GET /api/workspace/bootstrap` returned 404, confirming that the new workspace/onboarding routes are not yet live. Turso is configured for the service, but migration `0005_workspace_onboarding.sql` has not been applied to the live database. This is a public demo/staging environment, not production. Render Free instances sleep after inactivity and have ephemeral filesystems; persistent account data stays in Turso. For free-tier limits, see [Turso pricing](https://turso.tech/pricing) and [Render Free](https://render.com/docs/free).

## Blueprint settings

`render.yaml` describes a Node web service in Frankfurt with:

- Free plan, `npm ci` build, and the Keus web server start command.
- `/api/health` health check.
- WorkOS configured only after valid staging secrets are supplied through Render's private environment settings; its presence in the blueprint does not mean sign-in is live.
- Remote Turso URL/token supplied through private environment settings.
- Owner-only API Hub with a WorkOS email allowlist and a Render-generated 256-bit credential-encryption key.
- Production cookie behavior and PayPal Sandbox mode.
- Competition window and 7,000,000-token daily allowance selected by the owner; values are present in the source Blueprint but are not active on staging until a successful Blueprint sync/deploy.

## Initial deployment and remaining verification

1. **Repo target confirmed:** the user switched the fixed publishing destination to `thekingsmediastudio/Kues` after `thekingsmedia/Kues` returned 404. Publish only to `thekingsmediastudio/Kues`, then verify whether that exact commit reaches the existing Render staging service; if it does not, stop and ask before changing the Render repository connection.
2. **Turso:** a database was created and configured in Render. Migration `0005_workspace_onboarding.sql` remains unapplied until the new source starts on staging. After deployment, verify the migration and a real authenticated signup/bootstrap/onboarding flow without disclosing credentials.
3. **WorkOS:** staging email sign-in is active, and the owner has accessed the Hub console. Keep `API_HUB_ADMIN_EMAILS` limited to the exact verified WorkOS email. Preserve the Render-generated `API_HUB_ENCRYPTION_KEY`; never commit secrets or send them in chat.
4. **Service origin:** `https://keus-staging.onrender.com`. WorkOS derives the Keus callback as `<service-origin>/auth/callback` from Render's `RENDER_EXTERNAL_URL` unless `WORKOS_REDIRECT_URI` is explicitly overridden.
5. **Competition allowance:** the source Blueprint configures the official PayPal AI Hackathon period from 1 Oct 2026 5:15 PM WAT through the end of judging on 15 Dec 2026 5:00 PM WAT, with 7,000,000 AI tokens per default workspace/account per UTC day. These values are not live until the Blueprint/source deploy succeeds. This is not a global service budget, and no production AI-call route currently invokes the reservation layer.
6. **Google/GitHub sign-in:** both remain disabled. Follow `KEUS_SOCIAL_SIGNIN_PLAN_2026-10-26.md`: configure providers in the staging WorkOS environment first, then enable both provider flags and test new-user and existing-user linking.
7. After the workspace deployment, verify `/api/hub/manifest` and the authorized read-only Hub call. Keep any write checks separate, explicitly scoped, and limited to a non-sensitive test resource.

## Important boundaries

- Use the Render service's public URL for this staging callback, not the agent preview proxy URL.
- Keep staging keys in Render's secret environment settings. Do not put them in `render.yaml`, `.env` files committed to source control, or client-side code.
- Render Free services may sleep while idle. The first request after idle can be slow.
- Keus applies its database migrations during startup; keep Turso credentials configured before the first deployment.
- The existing Render service auto-deploys from its configured repository branch. Confirm it matches the required fixed repository `thekingsmediastudio/Kues` after the source merge; do not redirect it to another owner/repository without explicit approval.
- Production workspace aliases and `/onboarding` require a valid Keus session. This does not imply all product APIs or commerce actions are implemented or authorized.
