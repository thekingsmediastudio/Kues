# Keus Google and GitHub sign-in rollout plan, 2026-10-26

## Current state

- Keus staging is `https://keus-staging.onrender.com`; WorkOS email sign-in is already enabled there.
- Google and GitHub social sign-in are implemented in the application but disabled. `GET /api/auth/config` reports the flags, and the login page keeps each corresponding button disabled until the provider is enabled.
- The server starts WorkOS authorization with `GoogleOAuth` or `GitHubOAuth`, validates the OAuth `state` cookie on `/auth/callback`, and completes the login through the same WorkOS account-provisioning path as email authentication.
- WorkOS account completion requires a verified email. Keus links the WorkOS provider subject to an existing account with the same normalized email, or creates a user if none exists. It then reuses/provisions that user's default workspace and owner membership. There is no separate Google or GitHub user database.
- These are *sign-in* providers, separate from the private GitHub source repository and the API Hub's GitHub connector.

## Staging setup

1. In the **staging WorkOS environment**, enable Google OAuth and GitHub OAuth under Authentication / OAuth providers. Create or select the provider OAuth apps and enter their client credentials directly in WorkOS. Do not put provider secrets in chat, source control, browser code, or `render.yaml`.
2. For each provider, copy the provider-specific **Redirect URI shown in WorkOS** into the provider's OAuth app settings. Do not substitute the Keus callback there: WorkOS documents a WorkOS redirect URI for each provider.
3. In the WorkOS application Redirects settings, allow the Keus callback `https://keus-staging.onrender.com/auth/callback` (or the exact callback shown by the staging Render environment). The application already derives this callback from `RENDER_EXTERNAL_URL` unless `WORKOS_REDIRECT_URI` is explicitly set.
4. Only after both providers are enabled and their redirect settings are saved, change `WORKOS_GOOGLE_OAUTH_ENABLED` and `WORKOS_GITHUB_OAUTH_ENABLED` to `1` for staging and redeploy. The current Blueprint intentionally leaves both at `0` until provider setup is complete.
5. Verify `GET /api/auth/config` reports each provider enabled; confirm the login buttons become available and start the correct provider flow.

## Verification matrix

- New Google user with a verified email: one Keus user, one Google-linked WorkOS identity, one session, one default workspace, one owner membership, and onboarding shown.
- New GitHub user with a verified email: the same expected records and redirect behavior.
- Existing email-authenticated account using a verified matching Google or GitHub email: attach the provider subject to the existing Keus user; do not create a duplicate user, workspace, or onboarding profile.
- Provider email missing, unverified, or mismatched: fail closed; do not silently link an identity based solely on a display name or browser data.
- Invalid, absent, or replayed `state`; denied consent; provider outage; and callback without a code: return to login with an actionable error and do not create a session.
- Existing email sign-in remains functional while social providers are enabled. Check session cookies, logout/revocation, `/api/workspace/bootstrap`, onboarding completion, and reload after each provider sign-in.
- Run the existing unit suite and add/retain endpoint tests for both provider flags, disabled-provider rejection, state validation, verified-email handling, identity linking, and idempotent workspace provisioning. Do a real browser smoke test on staging before announcing the feature.

## Rollback and production separation

- To disable one provider, set its WorkOS flag back to `0` and redeploy. Email sign-in remains available.
- Keep staging and production as separate WorkOS environments/provider credentials. Do not enable production sign-in by changing staging flags.
- Before a production rollout, register the production Keus callback with the production WorkOS application, repeat provider setup and the test matrix against production configuration, and confirm the production domain/cookie settings.

## External setup references

- WorkOS Google OAuth setup: https://workos.com/docs/integrations/google-oauth
- WorkOS GitHub OAuth setup: https://workos.com/docs/integrations/github-oauth
- WorkOS application redirect URIs: https://workos.com/docs/integrations/redirect-uri-tutorial
