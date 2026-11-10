# Keus — guide for PayPal AI Hackathon judges

Everything below runs against the **PayPal sandbox only**. Capture is disabled server-side; holds (authorizations) are the only money movement, and you can void them yourself from the UI. No real goods are ordered.

## 1. Fastest look (one click, ~2 minutes)

1. Open the hosted staging app: **https://keus-staging.onrender.com**
2. Click **Sign in**, then **Launch Judge Workspace (1-Click)** in the "Hackathon demo fast lane" box (no email needed).
3. You land in the workspace with a pre-created agent. Try prompts such as:
   - `Find a hardcover A5 notebook under $30 and compare the top three`
   - `Buy 2 of the second one`
4. The agent searches, grounds its comparison in retrieved product data, and when you ask it to buy it produces a **purchase review** (amount, merchant reference, quantity, line totals) that waits for a human. Spending limits are enforced server-side in integer cents.

The judge fast-lane identity is shared, so **PayPal checkout and wallet actions are intentionally disabled for it** (`403 checkout_personal_account_required`). To run the full PayPal flow, use a personal account as described next.

## 2. Full PayPal flow (~5 minutes)

### 2a. Create your own Keus account

On the sign-in page choose **Create account** with any email you control. You will receive a verification code by email (sent through WorkOS); enter it and you are signed in. Google and GitHub sign-in are also available. Brand-new accounts walk through a 3-step onboarding (agent → spending limits → review); **Skip** is fine.

### 2b. Have a PayPal sandbox *buyer* ready

Any PayPal sandbox **personal** account works. If you do not have one: log in at https://developer.paypal.com → *Testing Tools → Sandbox Accounts* → create a Personal account, and note its email/password. (The Devpost submission's testing instructions also include a ready-made buyer login.)

### 2c. Run the loop

1. Ask the agent to find a product and then **buy it** (optionally with a quantity, e.g. "buy 3").
2. In the purchase review card click **Review checkout**. This records your consent in Keus only; nothing is sent to PayPal yet.
3. Open **PayPal checkout** in the right-hand panel and click **Get PayPal approval link**. Keus creates an `AUTHORIZE`-intent PayPal order (Orders v2) from the reviewed mandate — never from client-supplied amounts.
4. Open the link, log in with the sandbox buyer and approve that one purchase.
5. PayPal returns to Keus. The server re-verifies the order: amount, currency, merchant reference, quantity breakdown, user/session binding and the *current* spending limits — then requests the authorization hold. The return page drops you back in the originating agent conversation, which now contains a verified checkout message; the agent receives that result as server-side context on its next turn.
6. Inspect the hold in **PayPal checkout** and click **Void sandbox hold** to release it. Use **Recheck PayPal status** (reconcile) if a result is ever uncertain — the app never invents success and never silently replaces a hold.

What to notice: cancellation and unconfirmed results are never labelled successful; a reload mid-flow recovers state; changing quantity or limits requires a fresh review; the legacy `/paypal/capture` style routes reject requests (`payment_capture_disabled`).

## 3. Run it locally instead

Requirements: Node 24 (`.node-version`).

```sh
npm ci
cp .env.example .env.local   # fill in the values below
npm run dev                  # http://localhost:3100/workspace
npm test                     # 537 tests, no network required
```

Minimum configuration for an authenticated demo with real sandbox payments:

| Purpose | Variables |
|---|---|
| PayPal sandbox business app | `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` |
| Authentication (WorkOS) | `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI` |
| Database | local SQLite by default; or `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` |
| Product discovery (Channel3) | `CHANNEL3_API_KEY` — without it the catalog falls back to a built-in sample set so the flow still runs |
| LLM provider | configured in-app by an admin listed in `AI_PROVIDER_ADMIN_EMAILS` (OpenAI-compatible chat/responses or Anthropic Messages protocols); `AI_PROVIDER_ENCRYPTION_KEY` encrypts stored keys |

Migrations run automatically on startup (`0001` – `0016`). Never commit `.env.local`; it is git-ignored.

## 4. Where the PayPal and AI integration lives

| Area | Path |
|---|---|
| Standard checkout service (order creation, verification, authorize, reconcile, void) | `apps/web/lib/paypal/standard-checkout.mjs` |
| PayPal REST client, idempotency, chat events | `apps/web/lib/paypal/service.mjs`, `idempotency.mjs`, `chat-events.mjs` |
| Checkout HTTP endpoints (`/api/commerce/paypal/checkout/*`) | `apps/web/server.mjs` |
| Agent tools, purchase mandates, basket, grounded comparison | `apps/web/lib/ai-agent/` |
| Provider-agnostic LLM layer and admin provider management | `apps/web/lib/ai-providers/` |
| Product discovery (Channel3) | `apps/web/lib/channel3/` |
| Tests | `tests/unit/*.test.mjs` (537 passing) |

## 5. Safety properties judges can verify

- Server computes every total; the PayPal order carries matching item quantities and breakdown, and authorization verifies them against the stored mandate.
- Every checkout action is bound to the signed-in user, workspace and session; other users get `404` on your mandate IDs.
- Missing credentials or provider failures fail **closed** — there is no simulated-success path.
- Secrets are only ever read server-side; the browser never receives PayPal credentials.
- Hosted on Render (`render.yaml`); encrypted backup and restore of the Turso database, rollback and roll-forward deploys have been rehearsed.

## 6. Scope limits (so there are no surprises)

- Sandbox only; the payee is the app's own sandbox business account, not the catalog merchant. No shipment, no card issuance, no merchant fulfilment.
- Capture is disabled; refunds are therefore out of scope.
- The shared demo fast-lane identity cannot check out (by design).
- Hardware/mobile-specific surfaces were removed before submission; the product is the desktop web workspace.
