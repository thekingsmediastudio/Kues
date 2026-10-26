# Keus Main Project — Desktop-First Roadmap

**Status (reviewed 2026-10-26):** Keus remains a prototype/backend foundation; no hosted deployment, live commerce integration, or real payment flow is claimed. Post-review source repairs passed 51/51 unit tests under Node 24.22.1, `npm audit --omit=dev` reported 0 vulnerabilities, and Chromium local-preview checks passed at desktop and narrow widths. The earlier milestone totals below are historical pre-repair results. WorkOS Magic Auth/email-code seams and a development-only, memory-held staging setup exist in source; no key is loaded and no real email has been sent. Google/passkeys and remote Turso still require setup and testing.
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
- Existing `/pocket`, ADB, or phone-oriented code/tests may remain in the repository, but are outside this build scope and must not be expanded or presented as shipped functionality.
- Add a separate online account and monetization layer: user authentication, workspace/user usage records, plan entitlements, subscription state, and payment records. This is distinct from agent shopping payments.
- Competition-period offer is a free base allowance with server-enforced usage limits; users may subscribe for extended usage. SaaS subscription billing is separate from agent purchase payments. Payment provider, exact limits, pricing, and competition rules still need confirmation.

## Repository audit — working-copy status

The 2026-10-26 review repairs are implemented and locally verified in the extracted working copy: input validation, receipt authenticity, policy/skill binding, production desktop page access, strict origin handling, explicit static routes, onboarding persistence, and sample-data labels. This is not a production release. Numerical test counts in older milestone sections are historical; the current repair verification is 51/51 tests under Node 24.22.1.


- The web app is a small Node.js HTTP server. It now has `@libsql/client` as its first runtime dependency; desktop/onboarding remain static HTML, and the API seam exposes `/api/health` plus consistent JSON 404s for routes not yet implemented.
- The desktop page is a roughly 3,200-line interactive mockup. It uses illustrative/sample state and browser storage; many buttons explicitly identify themselves as previews.
- The onboarding page is a separate static HTML journey. Its “connected app” and PayPal choices are labelled as illustrative.
- Shared JavaScript modules already implement mandate hashing, evidence hashing, policy checks, agent identity/envelopes, Sentinel checks, watch goals, SKILL.md verification, and Flight-Box receipt hashing.
- A PayPal client helper has OAuth, Vault, authorization, capture, void, and refund request functions. No PayPal credentials were present, so no PayPal request was made.
- There is no implemented Channel3 client, Workers AI service, remote Turso connection, or server-side WebAuthn verification route. The initial migration and repository layer are now tested locally through `@libsql/client` against SQLite; remote Turso credentials remain unset.
- `.env.example` has placeholders for server-side services; placeholders do not mean integrations are connected. Mobile bridge variables were removed from the desktop setup template.
- A prior milestone recorded 44/44 unit tests and a local policy/challenge dry run; that result predates this review patch. Re-run the full suite on the current tree before treating it as verified.
- There is no Git repository metadata in this working copy. A `render.yaml` staging blueprint and setup guide are present, but no Render deployment is claimed live.

## Ordered implementation steps and gates

### 0. Lock the desktop-only scope — **Agreed**
- Keep mobile companion and F3 Android control deferred.
- Treat the existing desktop mockup as the visual/product reference, not proof that integrations work.
- Keep sandbox and demo boundaries visible in UX and logs.

**Gate:** No new mobile/ADB work is added to the main implementation plan.

### 1. Backend seam and configuration — **Base complete**
- Added `apps/web/lib/config.mjs` with server-only configuration parsing, paired PayPal credential validation, Sandbox-only enforcement, and explicit non-wildcard CORS origin validation.
- Refactored `apps/web/server.mjs` to expose a testable `createServer`, return JSON for API misses, remove the mobile route from the advertised health surface, and restrict page delivery to explicit routes/assets. Review follow-up adds production session checks for desktop workspace aliases and stricter Origin validation; these changes require post-edit QA.
- Updated `.env.example` for desktop WebAuthn, optional CORS origins, Sandbox test payee, and deferred/unused partner integrations.
- Guarded the PayPal helper so `PAYPAL_ENV=live` fails closed even when imported outside the web server.
- Added server/config tests. The original 14/14 count is a historical milestone, not a current-tree result.
- Request-body limits and authenticated write-route checks will be added with the first write API, rather than leaving unused parser code in the server.

**Gate:** Passed locally with no credentials; secrets are not returned by health/config; desktop and onboarding routes return 200; `/api/health` returns 200; unknown API routes return JSON 404; wildcard CORS and live PayPal mode are rejected.

### 2. Persistence and core domain — **Local adapter/migrations/token quota base complete**
- Drafted `apps/web/migrations/0001_core.sql` with Turso/SQLite-compatible tables for users, linked auth identities/sessions/passkeys, workspaces/agents/spend policies, plan entitlements/subscriptions, token usage and reservations, product offers/evidence, runs/decisions/mandates/approvals, separate SaaS billing records and Sandbox agent-payment records, and receipts.
- Added `@libsql/client`, a server-only client factory (`apps/web/lib/db/client.mjs`), and `npm run db:migrate` (`scripts/migrate.mjs`). The runner records migration checksums and fails on edits to already-applied migrations.
- Applied the migration twice against a local file-backed libSQL database; the second run reported up-to-date. Representative auth, usage, subscription, and Sandbox purchase rows passed local SQLite checks.
- Added `reserveTokens`, `settleTokenReservation`, and `releaseTokenReservation` with write transactions, idempotency, expiry/release handling, bounded lock retries, and conditional quota updates. Usage counts preserve input/output separately; concurrent reservations are tested across a shared client and independent local DB clients.
- Meter AI token usage as the primary free allowance: record input/output tokens with provider, model, user/workspace, run, and timestamp; deduplicate usage events. Keep configurable rate limits for searches/runs to control third-party costs even if they are not quota meters.
- Keep identity/session secrets out of browser storage; keep SaaS account billing distinct from the Sandbox test-payee flow for agent purchases.
- Keep money in integer minor units; record currency, source, timestamps, state transitions, and idempotency keys.
- Represent the competition offer as a configurable free token allowance with subscription tiers for extended usage. Do not hard-code final limits or prices until agreed.
- Define a repository/service boundary so unit tests do not need a live database.

**Gate:** Local file-backed migration, repeat-run/drift detection, quota reservation/settlement/release, idempotent retries, and multi-client contention tests pass. A remote Turso connection and production persistence test are pending because credentials are not configured.

### 3. Online account access and desktop workspace — **WorkOS email-code UI/API implemented; live email test pending**
- Retained `apps/web/lib/auth/service.mjs` for normalized identities, hashed local session tokens, session lookup/revocation, and Keus account ownership. Added durable rate limiting for WorkOS code requests (3/minute and 5/hour per normalized address); the emailed code is never stored.
- Added WorkOS Magic Auth via the Node SDK: Keus requests a code server-side, verifies it with WorkOS, requires a verified email, links the provider subject to the existing Keus user, and issues a Keus-local session.
- Added migration `0002_workos_identity.sql` for WorkOS-linked identities and `0003_workos_email_code_requests.sql` for rate-limited code-send records, without editing the checksum-protected first migration.
- Rebuilt `/login` as a first-party Keus email/code page with resend/change-email controls and a secondary hosted AuthKit route for Google/other methods. Google/passkeys remain unavailable until enabled and tested in WorkOS.
- Added `POST /api/auth/email/start`, `POST /api/auth/email/verify`, `GET /api/auth/config`, `GET /auth/start`, and `GET /auth/callback`; existing same-origin session/logout API remains. Keus session tokens are HttpOnly in the browser and stored only as hashes. WorkOS access/refresh tokens are not returned or persisted.
- Added explicit `AUTH_PROVIDER=workos` and complete credential/callback validation. Secrets are not returned in config. The old Brevo adapter remains legacy only and cannot be enabled alongside WorkOS.
- An earlier milestone recorded 42/42 tests across WorkOS seams, rate limiting, CSRF, identity linking, Keus sessions, quota, and policy. That test total predates the current repair edits; use the current QA run for present status.
- A sandbox-side smoke test registered `http://localhost:3100/auth/callback` in WorkOS staging and showed Keus redirecting to the real hosted AuthKit sign-in page; video: `test-artifacts/workos-authkit-handoff.webm`. The direct email-code API has not yet been live-tested; no real email was sent. The current preview exposes an opt-in same-origin setup form that accepts only `sk_test_` keys, holds them in server memory, and clears them on restart; no key is currently loaded. The user plans to rotate the test key before production.
- Google connection/passkeys are not yet enabled, remote Turso is unconfigured, and not all Keus product/API routes are gated by auth. This slice establishes sign-in/session handling, not whole-product authorization.
- Keep account authentication ceremonies separate from transaction-bound WebAuthn approval, even if a credential can be reused.
- Retain the chat-first shell, agent sidebar, centered settings, and New Agent flow; add account, current plan, and token-usage visibility without crowding the workspace.
- Replace demo-only state at the integration seams with API-backed state while keeping clear empty/loading/error states.
- Do not redesign the approved layout into a multi-pane dashboard or right-edge drawer.

**Gate:** Partial. Mocked WorkOS email-code seams, memory-only test setup, state checks, identity linking, and Keus-local sessions have prior test coverage. Production session checks for the desktop page aliases now pass local fixture tests. The full product/API is not authorized end-to-end. Remaining: real staging inbox test, key rotation before production, approved Google/passkey setup, remote Turso, and route-by-route authorization for future data/action APIs.

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

**Gate:** Valid assertion for the unchanged mandate passes; replay, expiry, changed amount/payee/evidence, bad origin, or signature fails closed.

### 8. SaaS subscription billing and token entitlements
- Enforce a free competition token allowance and paid plans for extended usage; keep quotas/prices configurable.
- Choose the subscription processor only after checking coverage for the operating country and competition rules; use idempotent webhook processing and explicit subscription states.
- Keep SaaS subscription charges, invoices, and refunds fully separate from PayPal Sandbox agent-purchase authorization/capture records.
- Never grant paid entitlements from a browser redirect alone; verify payment status server-side.

**Gate:** Free quota is enforced server-side; successful subscription payment changes the entitlement exactly once; failed/expired/cancelled states do not grant extended usage; no live payment is represented as a Sandbox agent purchase.

### 9. Capture, receipt, and recovery paths
- Only after verified WebAuthn, expose the separately gated Sandbox capture action.
- Persist a tamper-evident receipt with mandate, policy/Sentinel result, evidence references/hashes, WebAuthn verification metadata, and PayPal IDs.
- Add idempotent void/refund handling and clear pending/failed states.

**Gate:** End-to-end Sandbox test demonstrates authorize → desktop approval → capture, plus void/refund paths, with a verifiable receipt and no ambiguous claims.

### 10. Deployment, security review, and demo readiness
- Deploy the web service on Render Free and data on Turso Free; document environment setup and migrations.
- Verify KERNEL cost/credit eligibility before enabling it; otherwise keep it disabled and labelled.
- Run unit, integration, and route/security checks; test browser behavior on the preview origin and deployed HTTPS origin.
- Provide a demo script that distinguishes live Channel3 results, Sandbox payment state, and any remaining illustrative screens.

**Gate:** A reviewer can reproduce the demo from setup instructions; no secrets are exposed; no mobile path is required; all prototype boundaries are explicit.

## Decisions to confirm before turning on SaaS subscription collection

- **Sign-in methods requested:** email-based passwordless, Google OAuth, and passkeys. **Provider selected: WorkOS AuthKit.** WorkOS Magic Auth uses a six-digit code (the user approved WorkOS, with this UX difference documented); enable Google/passkeys separately in its dashboard and keep them unavailable until verified.
- **Competition model:** free base allowance; subscription for extended usage.
- **Primary usage meter:** AI token usage (track input/output separately). Keep search/run throttles as operational safeguards.
- **Still to decide:** token allowance, tier prices/limits, competition start/end dates, billing currency, and a subscription processor with suitable country coverage. Keep paid checkout disabled until those are confirmed.

## Immediate next action

WorkOS staging setup remains a separate follow-up: a prior sandbox-side smoke test reached hosted AuthKit, but a real inbox code and final Keus session were not completed; no email was sent. The current review first requires completing post-edit unit/browser/security QA and packaging the corrected source. Later staging work must still use a test key only, rotate it before production, configure remote Turso, and enable Google/passkeys only after approval and testing. The current production workspace guard is limited to the desktop page aliases; API/product actions still need explicit authorization before any connected product launch. Do not request or place secrets in chat/browser code/committed files. Keep passkeys unavailable until enabled and tested against the final relying-party domain. Continue with authorization protection and account/usage visibility without changing the desktop layout. Keep subscription checkout disabled until its billing provider, competition rules, and quotas/prices are confirmed; keep Channel3, agent-purchase PayPal, transaction WebAuthn, and KERNEL behind their planned service boundaries.
