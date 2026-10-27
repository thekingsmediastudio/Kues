# Keus Main Project — Desktop-First Roadmap

**Status (reviewed 2026-10-27):** Keus has an active Render staging service at `https://keus-staging.onrender.com`; the last verified staging health version is **2.2.1**. This staging release still uses the earlier email-code flow. A WorkOS email/password implementation is in the local source change, with **86/86 unit tests passing**, `npm audit --omit=dev` reporting **0 vulnerabilities**, and JavaScript syntax checks passing. The password-auth release has not yet been live-tested; no WorkOS email was sent. The temporary browser credential-entry setup was removed. Google/GitHub remain disabled; remote Turso is configured for staging.

**Scope:** Desktop-first main product. Mobile companion and F3 Android side-app control are deferred.

## Product and implementation boundaries

- **Canonical app name: Keus.** Use “Keus” in all product-facing copy and documentation; the green Keus cloud remains the product mark.
- Register Keus service accounts with `thekingsmedia.studio@gmail.com` wherever the provider permits; see `SERVICE_REGISTRATION_CHECKLIST.md`. This does not make the address the customer-facing sender email.
- Keep the approved dark, chat-first desktop experience, agent sidebar, onboarding flow, centered settings modal, and New Agent form.
- Keep the green Keus cloud as the product mark. Agent object avatars remain separate.
- Use desktop WebAuthn for transaction-bound approval. Do not require a phone companion.
- Use Channel3 for live product discovery. Keep product evidence separate from a PayPal Sandbox test payee.
- PayPal activity is Sandbox-only for review. Do not claim a retailer was paid or that live funds moved.
- Use Render Free, Channel3 live search, Turso Free, and Workers AI only for minimal synthetic shopping prompts/product facts. Use KERNEL only if the no-charge/hackathon-credit boundary is verified.
- Label sample/demo integrations and data clearly. Never represent a prototype as a connected service.
- Keep online account access, usage records, plan entitlements, subscriptions, and payments separate from agent shopping payments.
- Competition-period staging allowance is 7,000,000 AI tokens per verified account per UTC day, aggregated across that account’s authorized workspaces; different users sharing one workspace have separate buckets. PayPal is the selected future subscription provider. SaaS billing remains separate from agent purchase payments; checkout/webhooks are not implemented.
- Do not introduce a shared password for existing users. Existing email-code accounts set a private password using their own WorkOS reset link.

## Repository audit — working-copy status

The 2026-10-26 review repairs are implemented and locally verified in the extracted working copy: input validation, receipt authenticity, policy/skill binding, production desktop page access, strict origin handling, explicit static routes, onboarding persistence, and sample-data labels. This is not a production release. Older milestone totals are historical; the current source test suite is rerun before publication and its latest result is recorded in this roadmap and `RENDER_DEPLOYMENT.md`.

- The web app is a small Node.js HTTP server. It uses `@libsql/client`; desktop/onboarding remain static HTML, and the API seam exposes `/api/health` plus consistent JSON 404s for routes not yet implemented.
- The desktop page is a roughly 3,200-line interactive mockup. It uses illustrative/sample state and browser storage; many buttons explicitly identify themselves as previews.
- The onboarding page is a separate static HTML journey. Its “connected app” and PayPal choices are labelled as illustrative.
- Shared JavaScript modules implement mandate hashing, evidence hashing, policy checks, agent identity/envelopes, Sentinel checks, watch goals, SKILL.md verification, and Flight-Box receipt hashing.
- A PayPal client helper has OAuth, Vault, authorization, capture, void, and refund request functions. No PayPal request was made for this staging auth release.
- There is no implemented Channel3 client, Workers AI service, production AI-call route, or server-side WebAuthn verification route. A remote Turso database is configured for staging; production is out of scope.
- `.env.example` has placeholders for server-side services; placeholders do not mean integrations are connected. Mobile bridge variables were removed from the desktop setup template.
- There is no Git repository metadata in this working copy. A `render.yaml` staging blueprint is present; the existing Render staging deployment and its last verified version are documented in `RENDER_DEPLOYMENT.md`.

## Ordered implementation steps and gates

### 0. Lock the desktop-only scope — **Agreed**
- Keep mobile companion and F3 Android control deferred.
- Treat the existing desktop mockup as the visual/product reference, not proof that integrations work.
- Keep sandbox and demo boundaries visible in UX and logs.

**Gate:** No new mobile/ADB work is added to the main implementation plan.

### 1. Backend seam and configuration — **Base complete**
- Added `apps/web/lib/config.mjs` with server-only configuration parsing, paired PayPal credential validation, Sandbox-only enforcement, and explicit non-wildcard CORS origin validation.
- Refactored `apps/web/server.mjs` to expose a testable `createServer`, return JSON for API misses, remove the mobile route from the advertised health surface, and restrict page delivery to explicit routes/assets.
- Updated `.env.example` for desktop WebAuthn, optional CORS origins, Sandbox test payee, and deferred/unused partner integrations.
- Guarded the PayPal helper so `PAYPAL_ENV=live` fails closed even when imported outside the web server.
- Added server/config tests; historical milestone counts are not current-tree results.

**Gate:** Passed locally with no credentials; secrets are not returned by health/config; desktop and onboarding routes return 200; `/api/health` returns 200; unknown API routes return JSON 404; wildcard CORS and live PayPal mode are rejected.

### 2. Persistence and core domain — **Local adapter/migrations/token quota base complete**
- Drafted `apps/web/migrations/0001_core.sql` with Turso/SQLite-compatible tables for users, linked auth identities/sessions/passkeys, workspaces/agents/spend policies, plan entitlements/subscriptions, token usage and reservations, product offers/evidence, runs/decisions/mandates/approvals, separate SaaS billing records and Sandbox agent-payment records, and receipts.
- Added `@libsql/client`, a server-only client factory (`apps/web/lib/db/client.mjs`), and `npm run db:migrate` (`scripts/migrate.mjs`). The runner records migration checksums and fails on edits to already-applied migrations.
- Added `reserveTokens`, `settleTokenReservation`, and `releaseTokenReservation` with write transactions, idempotency, expiry/release handling, bounded lock retries, conditional quota updates, and multi-client contention coverage.
- Meter AI token usage as the primary free allowance: record input/output tokens with provider, model, user/workspace, run, and timestamp; deduplicate usage events. Keep search/run limits as operational cost controls.
- Keep identity/session secrets out of browser storage; keep SaaS account billing distinct from Sandbox agent-purchase payments.
- Keep money in integer minor units; record currency, source, timestamps, state transitions, and idempotency keys.
- Configure staging's competition allowance at 7,000,000 tokens per verified account per UTC day; subscription pricing/tiers remain configurable until separately approved. PayPal is the selected future subscription provider, but checkout/webhooks are not implemented.
- Define a repository/service boundary so unit tests do not need a live database.

**Gate:** Local migration, repeat-run/drift detection, quota reservation/settlement/release, idempotent retries, and multi-client contention tests pass. The remote Turso database is configured for staging; production persistence testing is outside this release.

### 3. Online account access and desktop workspace — **WorkOS email/password source flow implemented; live staging verification pending**
- `apps/web/lib/auth/service.mjs` retains normalized identities, Keus-local hashed session tokens, session lookup/revocation, and account/workspace ownership. Durable throttling for WorkOS verification/reset requests remains in place.
- WorkOS owns passwords and verifies email. Keus signup collects email and password, creates the WorkOS user, and requires WorkOS email-code verification before issuing a Keus session.
- Password sign-in uses WorkOS password authentication. Pending verification data is held in a short-lived HttpOnly cookie; passwords are never persisted in Keus or returned to the browser.
- A verified WorkOS subject is linked to the existing Keus identity. Matching normalized, verified emails reuse the existing Keus user and preserve workspace, onboarding, and usage ownership. New accounts go to `/onboarding`; existing accounts go to `/app`.
- Existing passwordless/email-code accounts use a WorkOS password-reset link to choose their own password. The account is not duplicated and no shared default password is assigned.
- The app's previous Magic Auth request/verify/consume paths are retired; the hosted AuthKit sign-in entry is blocked and Magic Auth callbacks are rejected. Email codes are used only for WorkOS email verification. Google/GitHub remain disabled.
- The development browser form and server endpoint that accepted WorkOS keys were removed. WorkOS secrets belong only in the host's private environment/secret manager; never paste keys into chat or the browser.
- Automated verification: **86/86 unit tests passed**, `npm audit --omit=dev` reported **0 vulnerabilities**, and JavaScript syntax checks passed. These mocked/code-level checks do not prove live WorkOS email delivery.
- Staging currently remains at its last verified health version **2.2.1** until the pending source release deploys version **2.2.2**. No live password signup, verification email, or password-reset email has yet been tested. After deployment, use an owner-controlled staging inbox for live checks.
- The account-authentication ceremony remains separate from transaction-bound desktop WebAuthn approval. Not all future product/API routes are gated by auth; protect each new data/action API before connecting product behavior.

**Gate:** Source and mocked tests complete. Publish to the fixed staging source branch, wait for Render health to identify version 2.2.2, then validate new-user signup/verification, password sign-in, and password reset for an existing account. Do not change production, assign a shared password, or use a temporary key-entry/verifier flow. Google/GitHub, passkeys, and a production-wide authorization review remain separate work.

### 4. Live Channel3 product discovery
- Implement a server-side Channel3 client, with credentials held only on the server.
- Normalize listing, seller, price, currency, availability, and source evidence. Keep source attribution visible.
- Treat Workers AI, if used, only as a minimal synthetic prompt/product-fact helper—not as source-of-truth for price, seller, policy, or approval.

**Gate:** Live results are distinguishable from fixtures; unavailable service fails honestly; evidence can be tied to a run.

### 5. Deterministic purchase policy and run state
- Define the run state machine and enforce allowlist, blocked payee, currency, per-order/per-day limits, exact amount, and quote-to-checkout fee creep.
- Bind a proposed mandate to amount, payee, domain, currency, evidence hash, run ID, expiry, and one-time nonce.
- Fail closed on missing/ambiguous evidence, policy mismatch, replay, or altered transaction fields.

**Gate:** Unit/integration tests cover allowed purchase, over-cap, blocked payee/domain, currency mismatch, evidence mismatch, expiry, and replay.

### 6. Configurable PayPal Sandbox authorization
- Keep the PayPal test payee configurable and explicitly separate from Channel3 product discovery.
- Create an `AUTHORIZE` order only after deterministic policy checks pass. Do not capture automatically.
- Use stable PayPal request IDs, record external IDs/status, and provide a safe void path for test authorizations.
- Keep Sandbox credentials on the server; make no live-mode path part of this review milestone.

**Gate:** Sandbox-only test order can be authorized and safely voided; UI clearly says test/sandbox; no retailer payment is claimed.

### 7. Desktop transaction-bound WebAuthn
- Register/authenticate a desktop WebAuthn credential over HTTPS with RP ID/origin validation.
- Bind the challenge to the exact mandate and evidence hash; enforce one-time use and short expiry.
- Verify assertions server-side before capture is even considered. No virtual-keyfob or phone-based substitute is represented as real approval.

**Gate:** A replayed or modified assertion is rejected; no signature is accepted from browser-only logic.

### 8. Usage, account, and subscription visibility
- Show the free token allowance, usage window, current plan, and subscription state without conflating them with agent-purchase spend.
- Use server-side plan/usage APIs and clear empty/loading/error states; do not trust client-side quota state.
- Implement PayPal subscription checkout, webhooks, reconciliation, and cancellation only in a separately approved billing milestone.

**Gate:** User-facing usage agrees with the account-scoped database ledger, and billing state is auditable independently of agent purchases.

### 9. Production authorization and deployment hardening
- Protect each data/action API with Keus session and workspace/account authorization; production page gating alone is insufficient.
- Review origin/CSRF, session lifetime/revocation, WorkOS settings, secret handling, Turso migrations/backups, rate limits, and dependency posture.
- Keep production changes out of the current staging password-auth release.

**Gate:** Security review and independent staging verification complete before any production authorization is requested.

### 10. Deployment, security review, and demo readiness
- Keep the current public deployment staging-only; document environment setup and migrations.
- Verify KERNEL cost/credit eligibility before enabling it; otherwise keep it disabled and labelled.
- Run unit, integration, and route/security checks; test browser behavior on the preview origin and deployed HTTPS origin.
- Provide a demo script that distinguishes live Channel3 results, Sandbox payment state, and any remaining illustrative screens.

**Gate:** A reviewer can reproduce the demo from setup instructions; no secrets are exposed; no mobile path is required; all prototype boundaries are explicit.

## Current decisions and remaining subscription work

- **Authentication:** WorkOS email/password with email verification, password reset, and open self-service registration. Google/GitHub and passkeys are not enabled.
- **Competition model:** 7,000,000 tokens per account per UTC day during the configured staging window; usage aggregates across that account's authorized workspaces and remains isolated from another user sharing a workspace.
- **Primary usage meter:** AI token usage, with input and output recorded separately. Search/run throttles remain operational safeguards.
- **Subscription:** PayPal is the selected intended provider; exact paid-tier prices, billing currency, and checkout/webhooks remain to be implemented. Checkout stays disabled.

## Immediate next action

Publish the password-auth source to the fixed `thekingsmediastudio/Kues` `main` branch, wait for the staging health marker to report version 2.2.2, then run the live WorkOS signup/verification/password-sign-in flow with an inbox controlled by the account owner. Separately use a reset link for an existing email-code account so its owner chooses a private password. Do not change production, ask for secrets in chat, add a temporary key-entry flow, or create/delete test accounts without owner authorization. Keep Google/GitHub and passkeys disabled; keep Channel3, agent-purchase PayPal, transaction WebAuthn, and KERNEL behind their planned service boundaries.