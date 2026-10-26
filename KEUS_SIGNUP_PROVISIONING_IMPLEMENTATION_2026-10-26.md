# Keus account provisioning and onboarding persistence — 2026-10-26

## Implemented in this source tree

- Added migration `0005_workspace_onboarding.sql` for one default-workspace pointer per account and an account-workspace onboarding record. It also makes competition grants idempotent per configured time window.
- Verified WorkOS and legacy verified-email account flows now create or repair an owner membership and a default workspace in the same transaction as the Keus session. A deterministic workspace ID and unique pointer make repeated sign-ins idempotent. Existing owned workspaces are reused.
- Added authenticated `GET /api/workspace/bootstrap` and same-origin-only `POST /api/onboarding/complete` routes. Both use the signed-in Keus session and derive the owner workspace from the account; clients cannot select a workspace ID.
- Onboarding profile and a paused preview agent are persisted in the shared database. Desktop loads the completed onboarding profile from the authenticated workspace bootstrap endpoint. Browser storage is retained only for account-scoped, unfinished form drafts and optional preview-only agent state; it is not authoritative for completed onboarding.
- Order and daily spend controls are stored as `preview_only` purchase limits and are not written to `spend_policies`. The current form does not define enough currency/per-run semantics for those example controls to become live purchase policy.
- Added competition configuration: `KEUS_COMPETITION_START_AT`, `KEUS_COMPETITION_END_AT`, and `KEUS_COMPETITION_DAILY_TOKEN_LIMIT`. All three must be supplied together; timestamps require an explicit timezone. A configured competition creates a free entitlement for each provisioned workspace before the competition end.
- The usage-repository reservation seam now requires an active entitlement, a current competition grant or an active paid subscription, a daily UTC competition quota (or subscription billing-period quota), workspace membership, and ownership of the referenced run. After the competition entitlement expires, a paid subscription must be `active` with a current billing period. The current project has no production AI-call route wired to `reserveTokens`; any future metered model path must reserve through this gate before calling its provider. This pass does not add an AI provider runtime.
- No per-user database or per-user copy of the platform integrations is created. Workspace rows remain tenant-scoped in the existing shared Turso database.

## Owner-confirmed competition and billing decisions

The owner confirmed a competition allowance of **7,000,000 AI tokens per account per day** and selected **PayPal** as the intended post-competition subscription provider. The official PayPal AI Hackathon schedule recorded in the project materials opens submissions on 1 October 2026 at 9:15 AM Pacific and ends judging on 15 December 2026 at 8:00 AM Pacific. The staging Blueprint is configured to cover the event through the end of judging: `2026-10-01T17:15:00+01:00` through `2026-12-15T17:00:00+01:00`, with a daily 7,000,000-token limit. The allowance resets at UTC midnight. The current account journey provisions one default workspace per account, which is the quota boundary; if multiple independently usable workspaces per account are introduced, the cap must be aggregated across them or moved to an account-level quota before that feature launches.

These settings are declared in the source and staging Blueprint, and the new source has now been deployed to staging. The usage reservation repository supports the cap, but no production AI-call route is currently wired to `reserveTokens`, so this is not a claim that AI usage is live. The server's startup migration runner runs before listening; the updated staging routes now respond. A real verified signup and database read-back are still needed to confirm workspace and competition-entitlement rows for an account.

PayPal is selected only as the future subscription provider. The current PayPal code/configuration is not a subscription checkout or billing webhook. Paid `subscriptions` and `entitlements` must not be created from a browser redirect; a provider-verified subscription lifecycle/webhook and idempotency tests remain to be implemented. Competition entitlements expire at the configured end; usage must then fail closed until a valid active paid subscription entitlement exists.

## Verification

- `npm test`: **75/75 passed** across the full unit suite.
- Coverage includes account provisioning idempotency, owner membership, competition entitlement creation/expiry, UTC daily reset, paid-subscription enforcement, workspace/run authorization, API authentication/same-origin checks, onboarding validation, database persistence, and reload from the account workspace.
- Inline JavaScript syntax: **5/5 passed** for desktop, onboarding, login, auth-verify, and pocket.
- `npm audit --omit=dev`: **0 vulnerabilities**.
- No full browser/UI smoke test or authenticated signup was performed after this implementation pass.
- Staging deployment completed on 2026-10-26 from `thekingsmediastudio/Kues` / `main`, merge commit `0d52d6a383fbf77595653f9570429f0fa3bc9acb`. After deployment, `/api/health` returned 200, anonymous `GET /api/workspace/bootstrap` returned the expected 401 `authentication_required` (it returned 404 before deployment), and anonymous same-origin `POST /api/onboarding/complete` returned 401. This verifies the code and authentication guard are live. A real signup and persisted-row/read-back test remain outstanding.
