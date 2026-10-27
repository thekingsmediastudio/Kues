# Keus WorkOS email/password authentication — 2026-10-27

## Scope and safety decision

This source change replaces passwordless WorkOS email sign-in with password authentication for the existing staging app. It preserves open email registration, verified WorkOS identity linking, Keus-local sessions, workspace/onboarding routing, and the account-scoped quota model. Google/GitHub stay disabled; production is not changed.

Existing email-code-only users are not assigned a common password. If a WorkOS email already exists, Keus sends a WorkOS password-reset link so the account owner chooses a private password. The existing WorkOS subject and Keus user/workspace remain intact. Keus does not persist passwords.

## Flow

1. Signup submits email and password to WorkOS, then starts WorkOS email verification. The user enters the six-digit code before Keus issues a local session.
2. Sign-in authenticates the email/password with WorkOS. An unverified account must finish verification before a session is issued.
3. Password reset uses WorkOS and returns a generic response to avoid revealing whether an address exists.
4. After verification, Keus links the verified WorkOS subject to the existing Keus identity when possible. New accounts continue to `/onboarding`; existing users continue to `/app`.

The pending WorkOS verification challenge is held in a short-lived `HttpOnly` cookie. The old Magic Auth request/verify/consume routes return `410 password_auth_required`; the hosted AuthKit sign-in entry is blocked and a Magic Auth callback is rejected. The development-only credential form and server endpoint that accepted WorkOS keys were removed, along with the setup-token CORS allowance. The former public HTML path now contains only an inert retirement notice, so even a static-file host cannot collect credentials.

## Key source changes

- `apps/web/lib/auth/workos-auth.mjs`: WorkOS password signup/sign-in, email verification, reset, and existing-account linking behavior.
- `apps/web/server.mjs`: password endpoints, generic reset responses, pending-auth cookie handling, disabled legacy flow, removed temporary credential setup, and health version marker **2.2.2**.
- `apps/web/public/login.html`: password, verification-code, and password-reset UI.
- `AUTH_SETUP.md`, `.env.example`, `PROJECT_ROADMAP.md`, and `RENDER_DEPLOYMENT.md`: current password-auth configuration and release boundaries; the 2026-10-26 Magic Auth implementation record is explicitly marked historical.
- Unit tests cover password signup/sign-in, unverified email, reset and account enumeration, identity/workspace preservation, Magic Auth blocking, same-origin checks, and the removed test-credential route.

## Verification

- `npm test`: **86/86 passed**.
- `npm audit --omit=dev`: **0 vulnerabilities**.
- `node --check` passed for the server, WorkOS adapter, and affected tests; the inline login script syntax check passed.
- These are local, mocked/code-level checks. No new WorkOS API request or email was sent during this verification.

## Staging release status

At the time of this implementation record, the last independently verified staging health version is **2.2.1**. Version **2.2.2** is prepared in the local source but has not yet been published or verified on Render. After the authorized merge to the fixed `thekingsmediastudio/Kues` `main` branch, wait for `https://keus-staging.onrender.com/api/health` to report 2.2.2 before live email-flow checks. Use an inbox controlled by the account owner; do not paste WorkOS credentials into chat or use a temporary verifier/key-entry form.

The 7,000,000-token per-account daily UTC allowance remains unchanged. PayPal checkout/webhooks are not implemented, and no production AI route currently invokes the quota reservation ledger.