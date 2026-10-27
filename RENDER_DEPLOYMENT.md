# Keus staging deployment blueprint for Render Free

**WorkOS email/password is live on staging as version 2.2.2.** The source was merged to `thekingsmediastudio/Kues/main` in commit `33499ecf3150451c1b447b1fb81bf2f66397d284`; a follow-up restored checksum-protected migration `0003_workos_email_code_requests.sql` byte-for-byte to its archived original and was merged as `5e2339bf359d2482a4833c7591629f0e8f563b4a`. Render health now returns 200/version **2.2.2**. `/api/auth/config` reports `emailPasswordEnabled: true`, `emailAuthMethod: "password"`, `magicAuthEnabled: false`; Google/GitHub remain disabled. The old email Magic Auth endpoint returns 410, and the retired setup paths return 404. Invalid-email probes returned 400 without contacting WorkOS. **No real verification or password-reset email has been sent yet; live inbox testing is pending owner confirmation.**

Earlier account-provisioning routes and the 7,000,000-token account quota remain deployed. The initial signup routes were published as `0d52d6a383fbf77595653f9570429f0fa3bc9acb`; account-wide quota changes were merged as `5f5f8e02743058c7dc41f7d7cd5c7bc4b46834cc`, followed by health marker commit `1adc2cc172dc335be829396e2a4bc06d50a1e815`. The local password-auth source passes 86/86 tests, `npm audit --omit=dev` reports 0 vulnerabilities, and JavaScript syntax checks pass. The temporary browser credential-entry route has been removed; keep WorkOS secrets only in Render's private environment settings.

The server awaits its startup migration runner before listening; staging version 2.2.2 reached health-ready after the exact checksum-protected migration was restored, confirming startup migrations completed. The owner reported that staging onboarding persistence and quota bootstrap passed; the agent has not directly read back live database records. The repository has no production AI-call route wired to `reserveTokens`, so the account-level quota gate is implemented but no live model usage path has yet exercised it. This is a public demo/staging environment, not production. Render Free can sleep after inactivity and uses an ephemeral filesystem; persistent account data stays in Turso. See [Turso pricing](https://turso.tech/pricing) and [Render Free](https://render.com/docs/free).

## Blueprint settings

`render.yaml` describes a Node web service in Frankfurt with:

- Free plan, `npm ci` build, and the Keus web server start command.
- `/api/health` health check.
- WorkOS credentials and remote Turso URL/token supplied through Render's private environment settings.
- Owner-only API Hub with a WorkOS email allowlist and Render-generated 256-bit credential-encryption key.
- Production cookie behavior and PayPal Sandbox mode.
- The owner-selected competition window from 1 Oct 2026, 5:15 PM WAT through the end of judging on 15 Dec 2026, 5:00 PM WAT, with a 7,000,000-token daily cap per verified account and UTC-midnight reset. The reservation ledger aggregates a user's competition usage across all authorized workspaces while keeping other accounts' usage separate. This is not a global service budget, and no production AI-call route currently invokes the reservation layer.

## Deployment and remaining verification

1. **Repository and deploy:** the fixed target is `thekingsmediastudio/Kues` / `main`. The password-auth source and checksum-safe migration correction are published; staging health is **2.2.2**. Production was not changed.
2. **Turso/migration:** the shared database is configured in Render, and staging version 2.2.2 reached health-ready after the checksum-protected migrations were validated. The owner reported onboarding persistence and quota bootstrap success; the agent has not independently read back account rows.
3. **WorkOS:** staging `/api/auth/config` now reports password authentication and Magic Auth disabled. Live email delivery, new-user verification, and existing-user reset are not yet tested; choose an owner-controlled inbox before sending test mail. Keep `API_HUB_ADMIN_EMAILS` limited to the exact verified WorkOS email and preserve the Render-generated `API_HUB_ENCRYPTION_KEY`. Never commit secrets or send them in chat.
4. **Service origin:** `https://keus-staging.onrender.com`. WorkOS derives the Keus callback as `<service-origin>/auth/callback` from `RENDER_EXTERNAL_URL` unless `WORKOS_REDIRECT_URI` is explicitly overridden.
5. **Competition allowance:** the staging Blueprint configures the dates and 7,000,000-token daily cap above. Migration `0006_account_usage_quota.sql` creates the shared account/day ledger; reservation, settlement, release, stale-reservation cleanup, and backfill all preserve the per-account boundary across workspaces. This enforcement applies when an AI-call route uses `reserveTokens`; there is currently no production AI-call route connected to it.
6. **Google/GitHub sign-in:** both remain disabled. Follow `KEUS_SOCIAL_SIGNIN_PLAN_2026-10-26.md`: configure providers in the staging WorkOS environment first, then enable both provider flags and test new-user and existing-user linking.
7. Verify `/api/hub/manifest` and an authorized read-only Hub call separately. Keep write checks explicitly scoped and limited to a non-sensitive test resource.

## Important boundaries

- Use the Render service's public URL for the WorkOS staging callback, not the agent preview proxy URL.
- Keep staging secrets in Render's private environment settings. Do not put them in `render.yaml`, `.env` files committed to source control, or client-side code.
- Render Free services may sleep while idle; the first request can be slow.
- The existing Render service auto-deploys from its configured repository branch. The update reached staging from the fixed repository `thekingsmediastudio/Kues`; do not redirect to another owner/repository without explicit approval.
- Production workspace aliases and `/onboarding` require a valid Keus session. This does not imply all product APIs or commerce actions are implemented or authorized.
