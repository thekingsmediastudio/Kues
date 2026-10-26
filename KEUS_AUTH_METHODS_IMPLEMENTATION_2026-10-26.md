# Keus sign-in and sign-up foundation — 2026-10-26

## Implemented

- Added explicit **Sign in** and **Create account** modes on `/login`.
- Email remains passwordless WorkOS Magic Auth: request a six-digit code, verify it server-side, then create or link a Keus user and issue the Keus-local HttpOnly session.
- Replaced the combined social method with separate Google and GitHub buttons.
- Added provider-specific `/auth/start?provider=GoogleOAuth` and `/auth/start?provider=GitHubOAuth` routes. Both use the existing HttpOnly/SameSite state cookie and `/auth/callback` validation. Unsupported provider values are rejected before a WorkOS request.
- First verified provider identities create local Keus users; matching verified emails link to their existing account. The provider-specific WorkOS OAuth API rejects AuthKit-only `screen_hint`; no unsupported parameter is sent.
- Added `WORKOS_GOOGLE_OAUTH_ENABLED` and `WORKOS_GITHUB_OAUTH_ENABLED` server flags. They default to disabled. The corresponding UI buttons remain disabled until the flag is set to `1` and WorkOS itself is configured. The isolated browser-preview mode keeps social OAuth disabled because its localhost callback is not reachable through that preview.
- Sign-in/account-creation copy and provider availability are exposed from `/api/auth/config`; no secrets are returned.
- Verified WorkOS identities now report whether Keus created a new account. First-time email or OAuth sign-ups are directed to `/onboarding`, while existing users go to `/app`; production access to onboarding requires a valid Keus session.

## Registration policy and setup still required

**Registration policy selected by the user: open self-service sign-up.** Any person who verifies an eligible email or completes an enabled Google/GitHub flow may create a Keus account. Keep self-service sign-up enabled in the matching WorkOS environment; no invite-only gate is implemented.

Enable Google and/or GitHub in the matching WorkOS Dashboard environment, register the exact `/auth/callback` URL, then set the corresponding server-side flag. WorkOS social-provider configuration is managed in its Dashboard ([Social Login](https://workos.com/docs/authkit/social-login)). Never put WorkOS API keys or provider secrets in browser code or chat. WorkOS test-mode email-code login is user-confirmed; production email delivery, Google/GitHub OAuth, and any deployed service are not yet claimed live.

Detailed setup instructions: `AUTH_SETUP.md`. Example variables: `.env.example`.

## Verification

- Unit tests after the registration handoff update: **56/56 passed**.
- Prior sign-in UI browser QA: **8 viewport widths passed**, no page errors; mocked email-code create-account flow and mock GitHub OAuth intent routing passed without contacting WorkOS. The new first-time-user redirect was not browser-tested in that run.
- Inline JavaScript syntax: **6/6 passed**.
- `npm audit --omit=dev`: **0 vulnerabilities**.
- Provider authorization URL behavior was tested against the installed WorkOS SDK. No live Google/GitHub OAuth flow was performed.
- On 2026-10-26, the user reported successful WorkOS test-mode email-code login and that Create account successfully registered an account, but did not show a clear next screen. First-time account detection and the onboarding redirect were then implemented. The redirect fix is covered by server/service tests; it has not yet been retested by the user in a restarted preview or deployed service.

## Test-setup preview CORS follow-up — 2026-10-26

The temporary WorkOS test-setup form now reports blocked-origin and unavailable-local-storage errors with actionable, non-secret messages. Its one-time `X-Keus-Setup-Token` header is permitted by CORS, and the live preview origin is explicitly allowlisted in the current preview process. A server restart clears in-memory test credentials and setup tokens; reload the form before retrying. The user subsequently reported the test-mode email-code login succeeded. Google/GitHub OAuth and production email delivery remain unverified.

- CORS preflight with `content-type,x-keus-setup-token`: **204**, correct `Access-Control-Allow-Origin` and setup-token header observed.
- Safe validation probe with deliberately invalid test-key format returned the expected validation error without contacting WorkOS.
- Full unit suite after the registration handoff update: **56/56 passed**; inline JavaScript syntax: **6/6 passed**.


## Registration handoff and free-hosting preparation — 2026-10-26

The user reported a successful registration that appeared to stop without a next step. Keus now returns an `isNewUser` flag from local identity provisioning; newly created email or social identities go to `/onboarding`, existing identities go to `/app`, and production onboarding access is session-protected. Render Free + Turso Free is the proposed public demo/staging stack. The deployment blueprint and setup notes are prepared, but no Git repository, Render service, or Turso database is connected or deployed. Render Free is not appropriate for production; it sleeps while idle and has ephemeral local storage.

- Full unit suite: **56/56 passed**.
- Inline JavaScript syntax: **6/6 passed**.
- `render.yaml` parsed successfully; service name is `keus-staging`.
- Current port-3100 WorkOS credentials are process-memory-only; a server restart requires re-entering the test key/client ID.
- The registration redirect still needs a fresh-inbox test after restarting the preview or on the hosted staging service.
