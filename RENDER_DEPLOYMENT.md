# Keus staging deployment blueprint for Render Free

**Existing account-provisioning and account-quota updates are deployed to staging.** The initial sign-up routes were published to `thekingsmediastudio/Kues` / `main` as commit `0d52d6a383fbf77595653f9570429f0fa3bc9acb`; the account-wide quota ledger and reservation changes were merged in `5f5f8e02743058c7dc41f7d7cd5c7bc4b46834cc`, followed by health-version marker commit `1adc2cc172dc335be829396e2a4bc06d50a1e815`. The last verified live health endpoint returned version **2.2.1** and 200. `GET /api/workspace/bootstrap` and same-origin `POST /api/onboarding/complete` returned the expected **401 `authentication_required`** without a session. `/api/auth/config` reported WorkOS email sign-in enabled and Google/GitHub disabled.

**Auth release in progress (2026-10-27):** the WorkOS email/password source was merged to `thekingsmediastudio/Kues/main` as commit `33499ecf3150451c1b447b1fb81bf2f66397d284`. After an eight-minute health check, staging still returned **2.2.1**; `/api/auth/config` still reported the old email-code behavior, so the new flow is not live and no new WorkOS email was sent. A follow-up restores the exact original comment in checksum-protected migration `0003_workos_email_code_requests.sql`—even a comment-only edit changes its checksum and can block startup on the existing database—before we retry staging deployment. Current local verification is 86/86 tests and 0 production dependency vulnerabilities. The temporary browser key-entry route has been removed; keep WorkOS secrets only in Render's private environment settings.

The server awaits its startup migration runner before listening; the deployed 2.2.1 service reached health-ready, so migration `0006_account_usage_quota.sql` completed at startup. The owner reported that staging onboarding persistence and quota bootstrap passed; the agent has not directly read back live database records. The repository has no production AI-call route wired to `reserveTokens`, so the account-level quota gate is implemented but no live model usage path has yet exercised it. This is a public demo/staging environment, not production. Render Free can sleep after inactivity and uses an ephemeral filesystem; persistent account data stays in Turso. See [Turso pricing](https://turso.tech/pricing) and [Render Free](https://render.com/docs/free).

## Blueprint settings

`render.yaml` describes a Node web service in Frankfurt with:

- Free plan, `npm ci` build, and the Keus web server start command.
- `/api/health` health check.
- WorkOS credentials and remote Turso URL/token supplied through Render's private environment settings.
- Owner-only API Hub with a WorkOS email allowlist and Render-generated 256-bit credential-encryption key.
- Production cookie behavior and PayPal Sandbox mode.
- The owner-selected competition window from 1 Oct 2026, 5:15 PM WAT through the end of judging on 15 Dec 2026, 5:00 PM WAT, with a 7,000,000-token daily cap per verified account and UTC-midnight reset. The reservation ledger aggregates a user's competition usage across all authorized workspaces while keeping other accounts' usage separate. This is not a global service budget, and no production AI-call route currently invokes the reservation layer.

## Deployment and remaining verification

1. **Repository and deploy:** the user explicitly fixed the publishing destination as `thekingsmediastudio/Kues` after `thekingsmedia/Kues` returned 404. The earlier source and quota updates were published to that private repository in scoped merges to `main`; the new workspace routes and account-quota migration are live on the existing Render service. The 2026-10-27 WorkOS password-auth source change is pending publication and Render verification.
2. **Turso/migration:** a database was configured in Render. The startup runner applies ordered migrations before the service listens. The deployment reached the ready state, but no authenticated insert/read-back test has yet verified a real signup, owner workspace, or onboarding record in Turso.
3. **WorkOS:** the last verified 2.2.1 release had email-code sign-in enabled. The pending release replaces app passwordless sign-in with email/password, email verification, and reset links; confirm the new health version and `/api/auth/config` before treating that flow as live. Keep `API_HUB_ADMIN_EMAILS` limited to the exact verified WorkOS email and preserve the Render-generated `API_HUB_ENCRYPTION_KEY`. Never commit secrets or send them in chat.
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
