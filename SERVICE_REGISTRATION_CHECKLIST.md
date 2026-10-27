# Keus service registration checklist

## Registration account

Use **thekingsmedia.studio@gmail.com** as the account/registration email for Keus-related service accounts wherever the provider permits. This is the registration contact only; it is **not** automatically the customer-facing sender address (`EMAIL_FROM`) and should not be used as one unless it is verified and intentionally selected.

Do not put passwords, one-time codes, recovery codes, API keys, or billing details in this file or in source control. Account ownership, email verification, MFA, and acceptance of provider terms remain under the account owner's control. No service account has been registered or connected by this checklist.

## Services and status

| Service | Purpose | Status | Notes |
| --- | --- | --- | --- |
| Keus domain | App website and optional custom AuthKit/email domain | Not selected/purchased; user chose free/local development | No purchase authorized. WorkOS default sender/domain supports the pilot without an owned domain. Revisit a stable app/AuthKit domain before production passkeys or custom branding. |
| WorkOS | Keus-owned email/password sign-in with email verification and code-based recovery | Selected; WorkOS staging is configured for Keus, and the HTTPS callback is `https://keus-staging.onrender.com/auth/callback`. Email/password is live on staging health version 2.2.2; code-recovery source is in the 2.2.3 release pending staging health confirmation, and live email checks require an owner-controlled inbox. | Keep WorkOS credentials only in the host's private secret settings. The temporary browser key-entry setup has been removed. WorkOS Magic Auth code delivery is used only behind the recovery endpoint; normal Magic Auth/passwordless app sign-in remains retired. Do not use the native reset-link flow. Google/GitHub remain disabled; passkeys need a stable relying-party domain before production. |
| Brevo | Legacy transactional email adapter | Account created/verified; not selected for active sign-in; sender/domain deferred | No real delivery. Adapter retained for tests/rollback; do not combine with `AUTH_PROVIDER=workos`. |
| Turso | Remote libSQL persistence | Pending | Use designated email where supported; create a database and keep URL/token in the server secret manager. Local file-backed tests do not require a Turso account. |
| Render | Web deployment | Existing staging service active; current release status is tracked in `RENDER_DEPLOYMENT.md` | Keep HTTPS origin, WorkOS callback, and database secrets in the service's private settings. Staging only; production is not in scope. |
| Google Cloud | Google OAuth sign-in | Not needed for the initial WorkOS connection | Google is configured as a WorkOS social connection if/when enabled; no separate Keus OAuth credentials have been added. |
| Channel3 | Product discovery | Deferred | Register/configure when beginning the Channel3 integration; use live search only as scoped in the roadmap. |
| PayPal Developer / Sandbox | Agent-purchase Sandbox tests | Separate and gated | Use the designated email if creating project-owned Sandbox accounts. Keep this completely separate from SaaS billing; Sandbox only, and never imply live funds moved. |
| SaaS billing processor | Subscription payments | PayPal selected as intended provider; implementation deferred | PayPal checkout and webhooks are not implemented. Keep subscription billing separate from Sandbox agent-purchase payments; do not enable checkout until pricing and eligibility are specified. |
| KERNEL / Workers AI | Optional supporting integrations | Deferred | Workers AI only for minimal synthetic prompts/product facts. Use KERNEL only after verifying the no-charge/hackathon-credit boundary. |

Update each status only after the account is actually created/configured and verified. Never treat a planned registration as an active integration.
