# Keus service registration checklist

## Registration account

Use **thekingsmedia.studio@gmail.com** as the account/registration email for Keus-related service accounts wherever the provider permits. This is the registration contact only; it is **not** automatically the customer-facing sender address (`EMAIL_FROM`) and should not be used as one unless it is verified and intentionally selected.

Do not put passwords, one-time codes, recovery codes, API keys, or billing details in this file or in source control. Account ownership, email verification, MFA, and acceptance of provider terms remain under the account owner's control. No service account has been registered or connected by this checklist.

## Services and status

| Service | Purpose | Status | Notes |
| --- | --- | --- | --- |
| Keus domain | App website and optional custom AuthKit/email domain | Not selected/purchased; user chose free/local development | No purchase authorized. WorkOS default sender/domain supports the pilot without an owned domain. Revisit a stable app/AuthKit domain before production passkeys or custom branding. |
| WorkOS | Keus-owned email-code sign-in, plus optional hosted AuthKit social/passkey methods | Selected; staging AuthKit was reached in a headless browser and `http://localhost:3100/auth/callback` was registered. Keus email/code UI/API and a memory-only test setup page are implemented; no key is currently loaded and no real email was sent. | Use the dev-only same-origin preview form for an `sk_test_` staging smoke test; user plans to rotate the test key before production. Confirm Magic Auth. Google is optional; passkeys need a stable relying-party domain before production. |
| Brevo | Legacy transactional email adapter | Account created/verified; not selected for active sign-in; sender/domain deferred | No real delivery. Adapter retained for tests/rollback; do not combine with `AUTH_PROVIDER=workos`. |
| Turso | Remote libSQL persistence | Pending | Use designated email where supported; create a database and keep URL/token in the server secret manager. Local file-backed tests do not require a Turso account. |
| Render | Web deployment | Pending | Use designated email where supported; configure HTTPS app origin, WorkOS redirect URI, and database secrets. No deployment is claimed live. |
| Google Cloud | Google OAuth sign-in | Not needed for the initial WorkOS connection | Google is configured as a WorkOS social connection if/when enabled; no separate Keus OAuth credentials have been added. |
| Channel3 | Product discovery | Deferred | Register/configure when beginning the Channel3 integration; use live search only as scoped in the roadmap. |
| PayPal Developer / Sandbox | Agent-purchase Sandbox tests | Separate and gated | Use the designated email if creating project-owned Sandbox accounts. Keep this completely separate from SaaS billing; Sandbox only, and never imply live funds moved. |
| SaaS billing processor | Subscription payments | Deferred | Do not register or enable checkout until provider coverage, pricing, quotas, currency, and competition timing are confirmed. |
| KERNEL / Workers AI | Optional supporting integrations | Deferred | Workers AI only for minimal synthetic prompts/product facts. Use KERNEL only after verifying the no-charge/hackathon-credit boundary. |

Update each status only after the account is actually created/configured and verified. Never treat a planned registration as an active integration.
