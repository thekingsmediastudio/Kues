# Keus architecture

How an AI shopping agent, a human approval gate and PayPal sandbox checkout fit together. Diagrams are Mermaid and render directly on GitHub. Everything described here runs against the PayPal **sandbox** only; capture is disabled server-side.

Contents

1. [System overview](#1-system-overview)
2. [Purchase flow, step by step](#2-purchase-flow-step-by-step)
3. [Checkout state machine](#3-checkout-state-machine)
4. [Trust model: what the agent can and cannot do](#4-trust-model-what-the-agent-can-and-cannot-do)
5. [Repository map](#5-repository-map)

![How Keus works](images/how-keus-works.png)

## 1. System overview

The browser talks only to the Keus server. Every external service (PayPal, Channel3, the AI provider, WorkOS, Turso) is called from the server with server-held credentials. The agent never sees a payment credential and never calls PayPal.

```mermaid
flowchart TB
    U["You<br/>browser, /workspace"]

    AUTH["Auth<br/>lib/auth"]
    CHAT["Agent runtime<br/>lib/ai-agent"]
    PP["PayPal standard checkout<br/>lib/paypal/standard-checkout"]
    GATE["Policy gate<br/>lib/commerce/checkout-engine"]
    DB[("Turso / libSQL<br/>migrations 0001 to 0016")]

    WOS["WorkOS<br/>email code, password, Google, GitHub"]
    AI["AI provider<br/>OpenAI-compatible or Anthropic protocol"]
    C3["Channel3 API<br/>live product offers"]
    PAY["PayPal Orders v2<br/>sandbox, intent AUTHORIZE"]

    U -->|"sign in"| AUTH
    U -->|"chat"| CHAT
    U -->|"Review checkout, approval link, Void"| PP
    AUTH --> WOS
    CHAT -->|"LLM calls"| AI
    CHAT -->|"search, compare"| C3
    CHAT -->|"purchase review"| GATE
    GATE --> DB
    PP -->|"mandate, status"| DB
    PP -->|"create order, get order, authorize, void"| PAY

    classDef server fill:#eef7f1,stroke:#1ca866,color:#173026
    classDef ext fill:#f4f4f6,stroke:#8a8f99,color:#222
    classDef you fill:#ffffff,stroke:#173026,color:#173026,stroke-width:2px
    class AUTH,CHAT,PP,GATE,DB server
    class WOS,AI,C3,PAY ext
    class U you
```

Green nodes run inside the Keus server (`apps/web`, Node 24, hosted on Render). Grey nodes are external services, called only from the server with server-held credentials. The buyer approves the order on PayPal in a separate tab and is sent back to `GET /api/commerce/paypal/checkout/return`, which hands the result to the signed-in session for verification.

Hosting: `render.yaml` with health endpoints; the database is Turso (libSQL) with numbered migrations applied on startup.

## 2. Purchase flow, step by step

The agent prepares; the human approves; the server verifies twice (before creating the order and again after PayPal returns). Amounts always come from the stored, reviewed mandate, never from the client.

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant Agent as Scout (AI agent)
    participant Server as Keus server
    participant DB as Turso
    participant PayPal as PayPal Orders v2 (sandbox)

    You->>Agent: "Buy 2 of the second one"
    Agent->>Server: purchase review (items, quantities, unit prices)
    Server->>Server: totals in integer cents, spending limits, merchant reference
    Server->>DB: store mandate (amount, items, evidence hash)
    Server-->>You: review card in chat (waits for a human)

    You->>Server: Review checkout (records Keus consent only)
    You->>Server: POST /api/commerce/paypal/checkout/begin
    Server->>DB: load mandate, re-check limits and ownership
    Server->>PayPal: create order, intent AUTHORIZE, itemized breakdown
    PayPal-->>Server: order id + approval link
    Server-->>You: approval link (opens in a separate tab)

    You->>PayPal: sign in with a sandbox buyer, approve this exact order
    PayPal-->>You: redirect to GET /api/commerce/paypal/checkout/return
    You->>Server: POST .../complete (signed-in session)
    Server->>PayPal: get order
    Server->>Server: verify amount, currency, merchant, quantities, session binding, current limits
    Server->>PayPal: authorize (hold only, capture disabled)
    PayPal-->>Server: authorization id
    Server->>DB: status authorized
    Server-->>You: verified checkout message in the originating conversation
    Server-->>Agent: verified result as separate server context on the next turn

    You->>Server: POST .../void
    Server->>PayPal: void authorization
    Server->>DB: status voided
    Server-->>You: "Sandbox hold voided" in chat and in PayPal checkout
```

Uncertain results (network interruption, provider timeout) are never shown as success. `POST .../reconcile` reads provider state and resolves `uncertain` without requesting a second authorization.

## 3. Checkout state machine

States are the `status` column of `paypal_standard_checkouts` (migration `0015`); `expired` is derived when a `pending` checkout passes `expires_at` (the API answers `410 purchase_approval_expired`). `voided`, `cancelled`, `failed` and `expired` are terminal. There is no path to capture.

```mermaid
stateDiagram-v2
    [*] --> creating: begin (reviewed mandate)
    creating --> pending: PayPal order created
    creating --> failed: provider error
    pending --> authorizing: buyer approved, return verified
    pending --> cancelled: buyer cancelled
    pending --> expired: expires_at passed (derived)
    authorizing --> authorized: AUTHORIZE accepted (hold)
    authorizing --> uncertain: result not confirmed
    authorizing --> failed: verification mismatch
    uncertain --> authorized: reconcile confirms hold
    uncertain --> failed: reconcile finds no hold
    authorized --> voiding: void requested
    voiding --> voided: PayPal confirms void
    voiding --> void_uncertain: result not confirmed
    void_uncertain --> voided: reconcile confirms
    void_uncertain --> authorized: reconcile finds hold still open

    note right of authorized
        Capture is disabled server-side.
        Legacy /paypal/capture rejects every request.
    end note
```

Budget accounting: `authorizing`, `authorized`, `voiding`, `uncertain` and `void_uncertain` all count against the agent's spending limit, so an unresolved hold can never be used to exceed the cap.

## 4. Trust model: what the agent can and cannot do

```mermaid
flowchart LR
    subgraph A["Agent can"]
        a1["Search and compare live offers via Channel3"] ~~~ a2["Prepare a purchase review: items, quantities, prices"] ~~~ a3["Read the verified checkout result on its next turn"]
    end

    subgraph H["Only you can"]
        h1["Click Review checkout"] ~~~ h2["Approve the exact order on PayPal with a sandbox buyer"] ~~~ h3["Void the hold"]
    end

    subgraph S["Only the server can"]
        s1["Compute totals in integer cents"] ~~~ s2["Enforce the per-purchase cap and budget"] ~~~ s3["Create the PayPal order from the stored mandate"] ~~~ s4["Verify amount, merchant, quantities and session after PayPal returns"] ~~~ s5["Authorize, reconcile and void"]
    end

    A -->|"review"| H
    H -->|"consent"| S
    S -->|"verified status"| A

    classDef agent fill:#f4f4f6,stroke:#8a8f99,color:#222
    classDef human fill:#ffffff,stroke:#173026,color:#173026,stroke-width:2px
    classDef server fill:#eef7f1,stroke:#1ca866,color:#173026
    class a1,a2,a3 agent
    class h1,h2,h3 human
    class s1,s2,s3,s4,s5 server
```

Guarantees enforced in code and covered by tests (`npm test`, 539 passing):

| Guarantee | Where |
|---|---|
| Amount, currency and merchant reference come from the stored mandate, never from the request body | `lib/paypal/standard-checkout.mjs` |
| Spending limits re-checked at `begin` and again at `complete` | `lib/commerce/checkout-engine.mjs` |
| Checkout bound to the signed-in user, workspace and session; other users get 404 on your mandate ids | `lib/paypal/standard-checkout.mjs`, `lib/auth` |
| Mandate challenge hash binds workspace, run, amount, currency, merchant and the `sha256:` evidence hash of the reviewed offer | `lib/channel3/mandate-service.mjs`, `packages/shared/src/mandate.mjs` |
| Capture disabled; legacy authorize/capture/refund routes reject | `lib/paypal/endpoints.mjs` |
| Fail closed: missing credentials or provider errors never become simulated success | checkout suite in `tests/unit` |
| Shared judge identity cannot check out (`403 checkout_personal_account_required`) | `lib/auth`, `lib/paypal/standard-checkout.mjs` |

## 5. Repository map

```text
Kues/                         npm workspaces monorepo, Node 24, MIT
  apps/web/                   the application
    server.mjs                HTTP server, routes, static UI
    lib/auth/                 WorkOS (email code, password, Google, GitHub), judge fast lane, sessions
    lib/ai-agent/             agent runtime, tools, purchase reviews, baskets
    lib/ai-providers/         OpenAI-compatible and Anthropic protocols, encrypted admin-managed keys
    lib/channel3/             product discovery, mandate service (challenge and evidence hash)
    lib/commerce/             checkout-engine (limits, integer-cent totals), purchase-items
    lib/paypal/               standard-checkout (begin, complete, reconcile, void), endpoints, idempotency
    lib/db/ + migrations/     Turso / libSQL client, numbered migrations 0001 to 0016
    public/                   workspace UI, login page, PayPal return page
  apps/bridge/                Android device bridge doctor (legacy, not in the checkout path)
  packages/shared/            mandate.mjs, goals.mjs, agent-identity.mjs, flight-box.mjs
  tests/unit/                 539 tests: mock PayPal provider, real HTTP, SQLite
  docs/                       JUDGING.md, ARCHITECTURE.md, legacy-checkout-design.md
  render.yaml                 Render deployment
```

Related reading: [JUDGING.md](JUDGING.md) for the step-by-step judge walkthrough and local setup, [legacy-checkout-design.md](legacy-checkout-design.md) for the first in-hackathon iteration (a saved-wallet design from October 2026, not current behaviour).
