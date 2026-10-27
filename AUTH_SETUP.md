# Keus WorkOS email/password authentication

This guide describes Keus’s first-party email/password flow. The current staging release and live verification status are tracked in [`RENDER_DEPLOYMENT.md`](./RENDER_DEPLOYMENT.md).

## User flows

- **Create account:** enter an email address and password. Keus creates the WorkOS user, then requests WorkOS email verification. The user enters the six-digit code sent to that address before Keus creates a local session and routes the new account to `/onboarding`.
- **Sign in:** enter email and password. WorkOS authenticates the credentials; an unverified account must complete email-code verification before Keus issues a session. A returning verified user goes to `/app`.
- **Existing email-code account:** choose **Forgot password?** to open a separate recovery form. Enter the account email, then the six-digit code and a new private password. Reusing an existing email during sign-up does not create a duplicate identity or send a reset link; use this recovery form instead.
- **Password reset:** the app responds generically whether or not an account exists, preventing email-address enumeration. WorkOS Magic Auth’s one-time code API is used only as a mailbox-ownership proof for this recovery flow; after validation, the server updates the WorkOS password and issues no Keus login session. The user must sign in with the new password.

WorkOS stores and verifies passwords. Keus does **not** store passwords or assign a shared default password. In particular, never set all existing users to the literal `password`. Recovery preserves the WorkOS user ID and existing Keus account/workspace; successful code verification is required before a password update.

WorkOS Magic Auth/passwordless sign-in is not an app sign-in method: the old email-code API routes return `410 password_auth_required`, the hosted AuthKit sign-in entry is blocked, and a Magic Auth callback is rejected. The Magic Auth API is called only behind the password-recovery endpoints and never creates a Keus session. Email codes are also used for email verification during password authentication/registration. Google and GitHub remain disabled.

## WorkOS and staging configuration

1. Use the existing **Keus staging** WorkOS environment. Keep self-service sign-up enabled. Enable email/password authentication and email verification. The recovery implementation uses WorkOS’s Magic Auth code API only server-side; if WorkOS requires the Magic Auth capability to be enabled for code delivery, keep it strictly off the Keus sign-in UI/routes. Do not enable passwordless sign-in or use WorkOS’s native reset-link flow for Keus recovery.
2. Register the exact HTTPS staging callback `https://keus-staging.onrender.com/auth/callback` in WorkOS. The callback is for OAuth identity linking; do not register the agent preview proxy as a WorkOS callback.
3. Keep `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and Turso credentials in the staging host’s private environment/secret settings. They must not be placed in browser code, tracked files, or chat. The temporary browser form and server route that accepted WorkOS keys have been removed; there is no replacement key-entry or verifier flow.
4. Keep Google/GitHub flags at `0` unless their providers are separately configured and approved. Social sign-in is not needed for the password flow.

Example variable names for a private server-side environment (values are supplied by the host secret store):

```dotenv
AUTH_PROVIDER=workos
WORKOS_API_KEY=<private staging secret>
WORKOS_CLIENT_ID=<private staging client ID>
WORKOS_REDIRECT_URI=https://keus-staging.onrender.com/auth/callback
WORKOS_GOOGLE_OAUTH_ENABLED=0
WORKOS_GITHUB_OAUTH_ENABLED=0
TURSO_DATABASE_URL=<private Turso URL>
TURSO_AUTH_TOKEN=<private Turso token>
```

For local development, keep real values only in an untracked `.env.local` and use a WorkOS development environment. Do not use staging or production credentials in browser previews.

## Identity, sessions, and data continuity

After WorkOS verifies the user, Keus links the WorkOS subject to the local Keus user. A matching normalized, verified email reuses the existing Keus user rather than duplicating it. Keus creates its own session cookie as `HttpOnly`; password and pending verification challenge values are not stored in Keus. The short-lived pending WorkOS challenge is held in an `HttpOnly` cookie. Existing workspace, onboarding, identity-link, and account-scoped usage records remain attached to the same Keus user.

Password routes enforce same-origin request checks and server-side request throttling. Verification codes and credentials are not returned to the browser in API responses. Sign-out revokes the Keus session; it does not necessarily end a separate WorkOS browser session.

## Staging verification checklist

After the source release deploys, confirm `/api/health` reports the new release and `/api/auth/config` reports `emailPasswordEnabled: true`, `magicAuthEnabled: false`, with Google/GitHub disabled. Then test with an inbox controlled by the account owner:

1. Create a new account with email and password; receive and enter the WorkOS verification code; confirm the Keus session and onboarding route.
2. Sign out and sign in with the same password; confirm the existing account opens `/app` and retains its workspace.
3. For an existing account, use **Forgot password?** to open the separate form; request a code, enter it with a new private password, and confirm Keus returns to sign-in without issuing a session. Sign in with the new password and confirm the same Keus identity/workspace is retained.
4. Confirm Magic Auth cannot sign in to Keus outside the recovery-only code flow. Do not use a shared password or create/delete accounts merely to test without the account owner’s authorization.

Automated mock tests do not prove WorkOS delivery. Do not claim live signup, verification email, reset delivery, or completed staging testing until those checks have actually succeeded. Production is outside this release.