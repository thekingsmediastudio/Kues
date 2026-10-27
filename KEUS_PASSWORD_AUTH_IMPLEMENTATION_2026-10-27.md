# Keus WorkOS email/password authentication — 2026-10-27

## Scope and recovery decision

This implementation keeps first-party sign-in on WorkOS email/password for staging. It preserves identity linking, Keus-local sessions, workspace/onboarding routing, and the per-account quota behavior. Google/GitHub and production remain untouched.

Password recovery is a separate form with a six-digit email code and a new-password/confirmation pair. WorkOS's native reset API creates a reset token/URL, so Keus does not call it. Instead, the server uses WorkOS Magic Auth only as a one-time mailbox-ownership proof, then updates the existing WorkOS user's password through `updateUser`. No Keus login session or WorkOS token is returned from the recovery endpoint; the user must sign in with the new password. The normal app Magic Auth sign-in routes remain retired/blocked.

Existing email-code users are not assigned a common password. An already-registered address submitted in Create account does not create a duplicate WorkOS/Keus identity or send a reset link; the user can choose the explicit Forgot password form and set a private password with a code.

## Flow

1. Signup creates a WorkOS email/password user and starts email verification. The user enters the six-digit verification code before Keus issues a local session.
2. Sign-in authenticates the email/password with WorkOS. An unverified account must finish email-code verification before a Keus session is issued.
3. Forgot password opens its own form. The user enters an email; the server only requests a WorkOS Magic Auth code for an existing user and always returns a generic accepted response. The email and short-lived reset challenge are held in an `HttpOnly`, `SameSite=Strict` cookie.
4. The recovery form submits the six-digit code plus a new password. The server verifies the code with `authenticateWithMagicAuth`, checks that the returned WorkOS identity matches the challenge email, and updates that user's password. It creates no Keus session and exposes neither the code nor WorkOS auth tokens.
5. The user signs in with the new password. Existing WorkOS/Keus identity and workspace data remain associated; new accounts still go to `/onboarding`, existing users to `/app`.

The old Magic Auth request/verify/consume app routes return `410 password_auth_required`; hosted AuthKit sign-in is blocked and Magic Auth callbacks are rejected. Magic Auth is called only behind the recovery API, never as an app sign-in route. The temporary development credential-entry form and server endpoint that accepted WorkOS keys remain removed.

## Key source changes

- `apps/web/lib/auth/workos-auth.mjs`: WorkOS password signup/sign-in, verification, recovery-only code issuance/verification, password update, and existing-account handling.
- `apps/web/server.mjs`: recovery start/verify endpoints, short-lived reset cookie, no-session reset response, same-origin checks, and health version marker **2.2.3**.
- `apps/web/public/login.html`: a separate Forgot password form with email, six-digit recovery code, new password, and confirmation fields; no reset-link UI.
- `tests/unit/workos-auth.test.mjs`, `tests/unit/workos-endpoints.test.mjs`, and `tests/unit/password-reset-ui.test.mjs`: code-only recovery, identity matching, generic responses, no-session behavior, cookie scope, invalid-code rejection, and recovery UI coverage.
- `AUTH_SETUP.md`, `PROJECT_ROADMAP.md`, `RENDER_DEPLOYMENT.md`, and `SERVICE_REGISTRATION_CHECKLIST.md`: recovery-only use of Magic Auth is distinguished from passwordless sign-in.

## Verification

- `npm test`: **89/89 passed**.
- Inline login script and affected JavaScript files pass `node --check`.
- The recovery endpoint tests verify that invalid codes do not update passwords, account lookup only sends codes to existing accounts, and successful recovery does not issue a Keus session.
- Mocked tests do not prove WorkOS email delivery. No email was sent during code implementation or local verification. Live recovery testing still requires an owner-controlled inbox.

## Staging release status

The 2.2.3 recovery source was published to the fixed `thekingsmediastudio/Kues/main` target in merge commit `40cdc3cf9be431f14bdbee9c4dca44c923ec11dd`. Render staging is health-ready at 2.2.3; `/api/auth/config` reports email/password enabled, `emailAuthMethod: "password"`, Magic Auth/Google/GitHub disabled. The login page contains the separate recovery form; retired sign-in routes return 410; invalid-email and missing-challenge recovery probes return 400; cross-origin recovery returns 403. No migration changed, and checksum-protected migration `0003_workos_email_code_requests.sql` remains byte-identical to the archive. No WorkOS verification or recovery email has been sent; obtain owner confirmation before live inbox testing. Never paste WorkOS credentials into chat or use a temporary verifier/key-entry form.

The 7,000,000-token per-account daily UTC allowance remains unchanged. PayPal checkout/webhooks are not implemented, and no production AI route currently invokes the quota reservation ledger.