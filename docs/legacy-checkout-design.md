# Historical checkout design — not the current product

The document below is preserved for reference, not as a description of working capabilities. Its autonomous rails, saved-wallet requirement, automatic holds, simulated fallback, passkey payment execution, capture endpoints, and judge fast-lane wallet claims do not describe the current checkout. See the root README for the active flow.

---

# Kues: Autonomous Commerce Agent
> **PayPal AI Hackathon 2026 Submission**  
> *PayPal Sandbox Authorization Pipeline & Multi-Tier Autonomous Checkout Engine with Channel3 Product Discovery & Transaction-Bound Passkeys*

[![Tests](https://img.shields.io/badge/tests-236%2F236%20passing-32d583.svg)](./tests)
[![PayPal](https://img.shields.io/badge/PayPal-Sandbox%20Authorize%20Hold-0079c1.svg)](https://developer.paypal.com)
[![WebAuthn](https://img.shields.io/badge/WebAuthn-ES256%20Passkeys-4c8dff.svg)](https://w3c.github.io/webauthn/)
[![Channel3](https://img.shields.io/badge/Channel3-Product%20Discovery-6366f1.svg)](https://trychannel3.com)
[![Platform](https://img.shields.io/badge/platform-Desktop--first%20Workspace-f5b942.svg)](./apps/web)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

---

## 1. Executive Summary

**Kues** is an autonomous desktop procurement agent designed to solve the **Agentic Commerce Trilemma**:
1. How does an AI agent safely discover and purchase physical products across disparate web retailers without brittle web scraping or hardcoded payment forms?
2. How do you protect user funds so an autonomous model cannot hallucinate or overspend?
3. How do you cryptographically bind authorization ceremonies to the user's hardware biometric authenticator (**WebAuthn Passkeys**) and anchor all fund flows to a secure financial rail (**PayPal**)?

Kues combines **Channel3 live product discovery**, a **deterministic spend policy engine**, a **transaction-bound WebAuthn passkey ceremony**, and a **three-tier autonomous checkout engine** backed 100% by **PayPal Sandbox `AUTHORIZE` holds**.

---

## 2. End-to-End System Architecture

The full vector architecture diagram is available in [`agent-commerce-architecture.svg`](./agent-commerce-architecture.svg).

```
                                  [ User / Agent Chat Request ]
                                                │
                                                ▼
                                 [ Channel3 Product Discovery ]
                              Discovers Target, Wayfair, or Shopify
                                                │
                                                ▼
                                [ Spend Policy & Audit Evaluation ]
                              Per-order cap ($150), daily budget ($500)
                                                │
                                                ▼
                               [ Cryptographic Mandate Formulator ]
                              sha256(ws:run:amount:curr:domain:evidence)
                                                │
                                                ▼
                       [ Transaction-Bound WebAuthn Passkey Ceremony ]
                       Biometric Touch ID / Windows Hello / YubiKey (ES256)
                                                │
                                                ▼
                         [ Autonomous Brain: evaluateCheckoutRail() ]
                  Analyses Merchant Domain, Channel3 Offer ID & Capabilities
                         │                      │                      │
                         ▼                      ▼                      ▼
                    [ Tier 1 ]              [ Tier 2 ]             [ Tier 3 ]
                  PayPal Native           Channel3 UCP          Virtual Card Bridge
                 (Shopify/PCP/Fastlane)  (Partner API Order)   (Web Card Retailers e.g. Target)
                         │                      │                      │
                         └──────────────────────┼──────────────────────┘
                                                │
                                                ▼
                          [ Root Funding Source: 100% PayPal ]
                         PayPal Sandbox `AUTHORIZE` Order Hold
                           (Funds locked on PayPal; never auto-captured)
                                                │
                          ┌─────────────────────┴─────────────────────┐
                          ▼                                           ▼
             [ Active Execution / Dispatch ]               [ User Void / Cancellation ]
            • Tier 1: Direct Vault Order               • Void PayPal Authorization Hold
            • Tier 2: Direct UCP Order Ref             • Burn / Void Virtual Card Proxy
            • Tier 3: Merchant-Locked VCard Proxy      • Cancel Channel3 Partner Order
```

---

## 3. The Three Autonomous Checkout Tiers

The agent acts as the autonomous brain inspecting retailer capabilities and selecting the optimal rail:

### Tier 1: PayPal Web Native / Fastlane Vault
* **Target Merchants:** Shopify stores (`*.myshopify.com`) and direct PayPal Commerce Platform (PCP) merchants.
* **Mechanism:** Direct Vault v3 order token authorization linked to the workspace's pre-approved PayPal wallet token (`workspace_wallets`).
* **Advantage:** Fastlane/Vault tokens allow autonomous, zero-friction checkout with zero subsequent PayPal logins.

### Tier 2: Channel3 Universal Commerce Protocol (UCP)
* **Target Merchants:** Direct API partners integrated via Channel3's standardized commerce bridge.
* **Mechanism:** Server-to-server authenticated order submission (`POST /v1/orders`) backed by a PayPal Sandbox authorization hold ID.
* **Advantage:** Synchronous inventory reservation, standardized order tracking, and programmatic cancellations.

### Tier 3: Virtual Card Bridge (PayPal JIT Drawdown)
* **Target Merchants:** Legacy web card retailers (e.g. `target.com`, `bestbuy.com`, `amazon.com`) that only accept credit card PANs.
* **Mechanism:** Mints an ephemeral, single-use virtual card proxy tied 1:1 to an active PayPal authorization hold. The card is locked strictly to the merchant's domain and the exact authorized order amount.
* **Safety Invariant:** In production, an issuing partner (e.g., Lithic, Marqeta) draws down against the PayPal hold via webhook; if voided, the card is burned immediately and the PayPal hold is released.

---

## 4. Transaction-Bound WebAuthn / Passkey Approvals

Kues enforces hardware-rooted transaction approvals using the W3C WebAuthn standard and native ECDSA P-256 (`ES256`) cryptographic verification:

```
[ Purchase Mandate Generated ]
       │
       ├─► challenge_hash = sha256(workspaceId:runId:amount:curr:domain:evidence)
       │
[ WebAuthn Ceremony: navigator.credentials.get() ]
       │
       ├─► Hardware Authenticator (Touch ID, Face ID, Windows Hello, YubiKey)
       ├─► Client signs: authenticatorData || sha256(clientDataJSON)
       │
[ Server Signature Verification (node:crypto) ]
       │
       ├─► Verify clientDataJSON.challenge === mandate.challenge_hash
       ├─► Verify ECDSA P-256 signature using stored public_key
       ├─► Record credential_id, timestamp, and sign_count in mandate_approvals
       │
[ Deterministic State Transition ]
       ▼
Mandate Status = 'authorized' ──► Triggers PayPal Sandbox Hold & Rail Execution
```

### Key Passkey Endpoints
* `GET /api/commerce/passkeys`: Lists registered biometric passkeys for the signed-in user.
* `POST /api/commerce/passkeys/register/options`: Generates WebAuthn registration options with cryptographic challenge.
* `POST /api/commerce/passkeys/register/verify`: Verifies authenticator attestation and persists public key in `passkey_credentials`.
* `DELETE /api/commerce/passkeys/:credentialId`: Revokes a registered passkey.
* `GET /api/commerce/mandates/:mandateId/passkey-challenge`: Retrieves the transaction-bound challenge hash for WebAuthn assertion.
* `POST /api/commerce/mandates/:mandateId/passkey-approve`: Verifies the WebAuthn signature and executes the checkout mandate.
* `POST /api/chat/tool-approval`: Accepts `passkey: { credentialId, signature }` for instant biometric chat approvals.

### Key Commerce, Flight-Recorder & Refund Endpoints
* `POST /api/commerce/paypal/authorize`: Creates an `AUTHORIZE` hold in PayPal Sandbox for an approved mandate.
* `POST /api/commerce/paypal/void`: Immediately voids an active PayPal authorization hold and burns any linked proxy card.
* `POST /api/commerce/paypal/capture`: Manually captures an active hold for settlement.
* `POST /api/commerce/paypal/refund`: Issues a full or partial refund against a captured PayPal Sandbox payment and updates receipt status.
* `GET /api/commerce/receipts/:id`: Fetches the immutable Flight Recorder receipt with SHA-256 integrity hash.
* `POST /api/commerce/skills/export`: Exports a cryptographically-bound `SKILL.md` specification with deterministic spend limits and approved domains.

---

## 5. PayPal Developer Sandbox Setup Guide

### Step 1: Create a PayPal Developer Account
1. Visit the [PayPal Developer Portal](https://developer.paypal.com) and log in with your PayPal account.
2. Navigate to **Dashboard** > **Sandbox** > **Accounts**.
3. PayPal automatically provisions two default sandbox accounts:
   - **Personal Account** (Buyer): e.g. `sb-buyer@personal.example.com`
   - **Business Account** (Merchant): e.g. `sb-merchant@business.example.com`

### Step 2: Create a REST API App for Sandbox Credentials
1. In the Developer Dashboard, navigate to **Apps & Credentials**.
2. Toggle the switch to **Sandbox** mode at the top.
3. Click **Create App**:
   - **App Name:** `Kues Agent Commerce`
   - **App Type:** `Merchant`
   - **Sandbox Business Account:** Select your sandbox business account.
4. Click **Create App** and copy your credentials:
   - **Client ID:** `A21AA...`
   - **Secret:** `EK...`

### Step 3: Configure Environment Variables
Create or update `.env` in the project root:

```env
# PayPal Sandbox Credentials
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=your_sandbox_client_id_here
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret_here
PAYPAL_TEST_PAYEE_EMAIL=sb-merchant@business.example.com

# Channel3 Live Product Discovery (Optional - offline fixtures used if omitted)
CHANNEL3_API_KEY=your_channel3_api_key_here

# WorkOS Authentication & Database
AUTH_PROVIDER=workos
TURSO_DATABASE_URL=file:./local.db
```

> **Safety Invariant:** If `PAYPAL_CLIENT_ID` or `PAYPAL_CLIENT_SECRET` are not provided, Kues automatically uses deterministic Sandbox mocks (`ORD-SANDBOX-...`, `AUTH-SANDBOX-...`, `VAULT-SANDBOX-...`) so all unit tests and offline previews function flawlessly without live credentials.

---

## 6. Testing Instructions for Judges & Reviewers

Kues provides **two testing paths**:

### Mode A: 1-Click Judge Fast-Lane (Recommended for Evaluation)
1. Start the server:
   ```bash
   npm start
   ```
2. Open `http://localhost:3100/login` in your browser.
3. Under the login box, click **"Judge Fast-Lane Demo Access (Instant)"**.
4. The system will automatically:
   - Create an authenticated evaluation session.
   - Seed a pre-configured workspace with the **Procure Scout** agent.
   - Pre-link a distinct **PayPal Sandbox Vault** payment token.
   - Redirect you directly into the desktop workspace at `/app`.

### Mode B: Full Self-Service Onboarding Flow
1. Open `http://localhost:3100/login` and sign up with your email and password.
2. Complete the 5-screen interactive onboarding wizard at `/onboarding`:
   - Screen 1: Welcome & Mission
   - Screen 2: Scout Agent Persona & Role
   - Screen 3: Approval Protocol Selection (Desktop vs Mobile)
   - Screen 4: Deterministic Spend Policy Limits (Order Cap & Daily Budget)
   - Screen 5: Summary & Workspace Provisioning
3. In `/app`, navigate to **Settings** > **Autonomous Purchasing Wallet** and click **"One-Time Link Sandbox Wallet"**.
4. Register a biometric passkey under **Settings** > **Transaction-Bound Passkeys**.

---

## 7. Autonomous Shopping & Approval Walkthrough

1. In the chat composer, ask the agent to find a product:
   ```
   "Find ergonomic office chairs under $150 on Target"
   ```
2. The agent executes `search_products` via Channel3 and renders rich visual product cards with live prices, merchant badges, and product photos.
3. Tell the agent:
   ```
   "Please purchase the ErgoChair Pro"
   ```
4. The agent:
   - Evaluates your spend policy against its order cap.
   - Formulates a cryptographic purchase mandate.
   - Autonomously determines the execution rail (Tier 1, Tier 2, or Tier 3).
   - Generates an interactive confirmation card with two options:
     - **"Approve with Passkey"**: Triggers biometric WebAuthn verification.
     - **"Authorize Standard"**: Executes policy authorization.
5. Upon approval:
   - The server places a **PayPal Sandbox `AUTHORIZE` hold** (funds locked, not captured).
   - The autonomous rail is dispatched (e.g. Tier 3 single-use virtual card proxy minted).
   - The card dynamically displays the **PayPal Sandbox Hold ID** and a persistent **"Void Sandbox Hold"** button.
6. Click **"Void Sandbox Hold"** at any time to safely cancel the hold without moving funds.

---

## 8. Test Suite Verification

Run the comprehensive unit test suite:

```bash
npm test
```

Results: **234 unit tests pass cleanly across 30 test suites** covering:
* WebAuthn passkey registration, assertion challenge, and ES256 verification (`passkey-mandate-approval.test.mjs`)
* Multi-tier autonomous checkout engine and virtual card bridge (`agent-checkout-rails.test.mjs`)
* PayPal Sandbox authorization holds, voids, captures, and vault wallets (`paypal-sandbox-pipeline.test.mjs`)
* Channel3 live discovery, price filtering, and offline fallbacks (`channel3-discovery.test.mjs`)
* Deterministic spend policies and order cap rejection (`mandate-policy.test.mjs`)
* Desktop chat progressive streaming, UI state, and safe DOM rendering (`desktop-chat-stream.test.mjs`)
* Judge Fast-Lane session creation and onboarding redirects (`workos-endpoints.test.mjs`)

---

## 9. Project Structure

```
apps/web/
├── lib/
│   ├── auth/
│   │   ├── passkey-service.mjs   # WebAuthn ES256 registration & mandate-bound verification
│   │   └── service.mjs           # WorkOS session authentication & cookies
│   ├── commerce/
│   │   ├── checkout-engine.mjs   # Autonomous rail evaluator, orchestrator, & void handler
│   │   └── card-bridge.mjs       # PayPal-backed single-use virtual card minting & burning
│   ├── channel3/
│   │   ├── client.mjs            # Channel3 Search API client (POST /v1/search)
│   │   ├── discovery.mjs         # Product catalog normalization & Markdown image renderer
│   │   ├── checkout.mjs          # Channel3 Universal Commerce Protocol (UCP) orders
│   │   └── mandate-service.mjs   # Deterministic spend policy engine & SHA-256 mandates
│   ├── paypal/
│   │   ├── service.mjs           # Sandbox Authorize, Void, Capture, & Vault Wallets
│   │   ├── endpoints.mjs         # PayPal v2 Orders/Payments & v3 Vault REST client
│   │   └── idempotency.mjs       # Deterministic PayPal-Request-Id generator
│   └── ai-agent/
│       └── workspace-tools.mjs   # Server-enforced workspace agent tool instructions
├── migrations/                   # SQLite / Turso schema migrations (0001 - 0012)
├── public/
│   ├── desktop-preview.html      # Desktop workspace with hold badges, passkeys, & void button
│   ├── onboarding.html           # 5-screen interactive agent setup & spend policy wizard
│   └── login.html                # Authentication panel with 1-click Judge Fast-Lane
└── server.mjs                    # HTTP server routing commerce, passkey, & wallet endpoints
```

---

## 10. License

MIT License. See [LICENSE](./LICENSE) for details.
