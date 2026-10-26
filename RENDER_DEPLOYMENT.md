# Keus staging deployment blueprint for Render Free

**Status: the account-provisioning update was published and deployed to the existing staging service on 2026-10-26.** The merge was made to `thekingsmediastudio/Kues` / `main` as commit `0d52d6a383fbf77595653f9570429f0fa3bc9acb`. After deployment, `GET /api/workspace/bootstrap` changed from 404 to **401 `authentication_required`** for an anonymous request, and `POST /api/onboarding/complete` also returned 401 without a session. Those are expected security responses and confirm that the new routes are live. `/api/health` returned 200; `/api/auth/config` reports WorkOS email sign-in enabled and Google/GitHub disabled.

The server applies SQL migrations at startup before listening. The deployed service became available after the updated migration runner ran. No authenticated signup/onboarding was performed in this check, so a real account write/reload still needs verification by signing in with an owner-controlled staging test account. This is a public demo/staging environment, not production. Render Free can sleep after inactivity and uses an ephemeral filesystem; persistent account data stays in Turso. See [Turso pricing](https://turso.tech/pricing) and [Render Free](https://render.com/docs/free).

## Blueprint settings

`render.yaml` describes a Node web service in Frankfurt with:

- Free plan, `npm ci` build, and the Keus web server start command.
- `/api/health` health check.
- WorkOS credentials and remote Turso URL/token supplied through Render's private environment settings.
- Owner-only API Hub with a WorkOS email allowlist and Render-generated 256-bit credential-encryption key.
- Production cookie behavior and PayPal Sandbox mode.
- The owner-selected competition window from 1 Oct 2026, 5:15 PM WAT through the end of judging on 15 Dec 2026, 5:00 PM WAT, with a 7,000,000-token-per-day quota per default workspace/account and UTC-midnight reset. The Blueprint declares these values; verify the authenticated bootstrap response during a staging signup before claiming the entitlement is active for a specific account. This is not a global service budget, and no production AI-call route currently invokes the reservation layer.

## Deployment and remaining verification

1. **Repository and deploy:** the user explicitly changed the fixed publishing destination to `thekingsmediastudio/Kues` after `thekingsmedia/Kues` returned 404. The source was published to the selected private repo, merged once to `main`, and the new workspace route is live on the existing Render service.
2. **Turso/migration:** a database was configured in Render. The startup runner applies ordered migrations before the service listens. The deployment reached the ready state, but no authenticated insert/read-back test has yet verified a real signup, owner workspace, or onboarding record in Turso.
3. **WorkOS:** staging email sign-in is active. Keep `API_HUB_ADMIN_EMAILS` limited to the exact verified WorkOS email and preserve the Render-generated `API_HUB_ENCRYPTION_KEY`. Never commit secrets or send them in chat.
4. **Service origin:** `https://keus-staging.onrender.com`. WorkOS derives the Keus callback as `<service-origin>/auth/callback` from `RENDER_EXTERNAL_URL` unless `WORKOS_REDIRECT_URI` is explicitly overridden.
5. **Competition allowance:** the current staging Blueprint configures the dates and 7,000,000-token daily cap above. The token reservation repository enforces this when an AI-call route uses it; there is currently no production AI-call route connected to `reserveTokens`.
6. **Google/GitHub sign-in:** both remain disabled. Follow `KEUS_SOCIAL_SIGNIN_PLAN_2026-10-26.md`: configure providers in the staging WorkOS environment first, then enable both provider flags and test new-user and existing-user linking.
7. Verify `/api/hub/manifest` and an authorized read-only Hub call separately. Keep write checks explicitly scoped and limited to a non-sensitive test resource.

## Important boundaries

- Use the Render service's public URL for the WorkOS staging callback, not the agent preview proxy URL.
- Keep staging secrets in Render's private environment settings. Do not put them in `render.yaml`, `.env` files committed to source control, or client-side code.
- Render Free services may sleep while idle; the first request can be slow.
- The existing Render service auto-deploys from its configured repository branch. The update reached staging from the fixed repository `thekingsmediastudio/Kues`; do not redirect to another owner/repository without explicit approval.
- Production workspace aliases and `/onboarding` require a valid Keus session. This does not imply all product APIs or commerce actions are implemented or authorized.
