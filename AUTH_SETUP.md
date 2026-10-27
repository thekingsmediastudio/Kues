# Keus WorkOS email/password authentication

This guide describes Keus’s first-party email/password flow. The current staging release and live verification status are tracked in [`RENDER_DEPLOYMENT.md`](./RENDER_DEPLOYMENT.md).

## User flows

- **Create account:** enter an email address and password. Keus creates the WorkOS user, then requests WorkOS email verification. The user enters the six-digit code sent to that address before Keus creates a local session and routes the new account to `/onboarding`.
- **Sign in:** enter email and password. WorkOS authenticates the credentials; an unverified account must complete email-code verification before Keus issues a session. A returning verified user goes to `/app`.
- **Existing email-code account:** use **Forgot password?** to receive a WorkOS password-reset link and choose a private password. Reusing an existing email during sign-up also triggers a reset message rather than creating a duplicate WorkOS or Keus identity.
- **Password reset:** the app responds generically whether or not an account exists, preventing email-address enumeration. The account owner sets their own password using WorkOS.

WorkOS stores and verifies passwords. Keus does **not** store passwords or assign a shared default password. In particular, never set all existing users to the literal `password`. The reset flow preserves the WorkOS user ID and existing Keus account, sessions/ownership data, and workspace association.

WorkOS Magic Auth/passwordless sign-in is not an app sign-in method: the old email-code API routes return `410 password_auth_required`, the hosted AuthKit sign-in entry is blocked, and a Magic Auth callback is rejected. Email codes are used only to verify an email during password authentication/registration. Google and GitHub remain disabled.

## WorkOS and staging configuration

1. Use the existing **Keus staging** WorkOS environment. Keep self-service sign-up enabled. Enable email/password authentication, email verification, and password reset in that environment.
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
3. For an existing email-code account, request a reset, complete the WorkOS reset link, then sign in with the password chosen by that account owner; confirm the same Keus identity/workspace is retained.
4. Confirm passwordless email sign-in stays unavailable. Do not use a shared password or create/delete accounts merely to test without the account owner’s authorization.

Automated mock tests do not prove WorkOS delivery. Do not claim live signup, verification email, reset delivery, or completed staging testing until those checks have actually succeeded. Production is outside this release.