# Keus — human-approved shopping with PayPal sandbox checkout

Keus combines AI-assisted product discovery, purchase reviews and spending limits with **per-purchase PayPal sandbox approval**. A saved wallet or PayPal Vault grant is not required.

## Current payment flow

1. Ask your shopping agent to find and review a product.
2. Request a purchase and review the amount and merchant reference shown in chat.
3. Click **Review checkout**. This records Keus consent only; it does not place a PayPal hold.
4. In **PayPal checkout**, click **Get PayPal approval link**, then open the displayed link and approve that specific purchase using a sandbox buyer account. If opening a new tab is blocked, use **Copy approval address** and paste it into a new browser tab.
5. The server verifies the PayPal order, amount, merchant, user/session binding and current spending limits before requesting an `AUTHORIZE` hold.
6. Return to Keus to refresh, inspect or **Void sandbox hold**. Checkout status survives page reloads.

**Sandbox only. Capture is disabled server-side. No real product seller order, shipment, card issuance or merchant fulfillment occurs.** The payment recipient is the app's sandbox business account, not the catalog merchant. Shipping information is not requested by checkout.

The shared demo identity cannot execute checkout: use your own Keus account and a PayPal sandbox buyer. Missing credentials and provider failures never fall back to simulated success in this flow.

## Development

Use Node 24 (see `.node-version`).

```sh
npm ci
cp .env.example .env.local
# Configure the private .env.local values before starting.
npm run dev
```

Open `/desktop-preview` on the configured server (default port 3100). Configure the existing database, authentication and AI-provider services for a functional authenticated shopping demo. The desktop uses WorkOS authentication and libSQL/Turso storage; product discovery configuration remains separate from payment configuration. The server applies numbered database migrations on startup; back up an existing database before deploying migration `0015_paypal_standard_checkouts.sql`.

For payments configure only server-side sandbox credentials:

- `PAYPAL_ENV=sandbox`
- `PAYPAL_CLIENT_ID` — the sandbox business app Client ID
- `PAYPAL_CLIENT_SECRET` — that app's secret

Use a public HTTPS origin for the PayPal return flow (localhost HTTP is accepted for local fixtures). Never commit credentials, use live credentials, or paste secrets into chat. Vault IDs, buyer emails, passkeys and saved-wallet setup are not prerequisites for standard checkout.

## Verification and limitations

```sh
npm test
```

Local verification: **346 passing tests**, including 14 standard-checkout tests covering provider verification, ownership/session binding, expiry, spending-limit changes, duplicate requests, uncertain-result reconciliation, voiding, sandbox gates and HTTP CSRF checks. Desktop browser checks at 1440px and 390px exercise chat review, the separate approval tab, authorization, reload recovery, cancellation and voiding with a **mock provider**, real application HTTP and SQLite.

Actual PayPal sandbox testing on 2026-11-02 confirmed order creation, buyer approval, a $10.00 USD authorization (HTTP 201), authorization lookup and successful void (HTTP 200). This used the real standard-checkout service with a local test identity/database and manual approval verification in the original helper tab. No capture or Vault calls occurred. **Deployed Keus authentication and the automatic PayPal return callback remain externally unverified.** The local browser checks use mocks and are separate from this real provider evidence. Nothing here claims deployment.

If authorization is uncertain, use **Recheck PayPal status**, not a replacement purchase. Reconciliation reads provider state without requesting another authorization. Unresolved states remain reserved against the spending budget. A process interruption during order creation, a provider-expired hold, or an unconfirmed authorization with no retrievable provider result may need operator investigation; the application does not invent success or silently release that reservation.

## Payment interfaces

- `GET /api/commerce/paypal/checkout` — user/workspace-scoped checkout history.
- `POST /api/commerce/paypal/checkout/begin` — creates an unapproved AUTHORIZE order from a reviewed mandate, never client-supplied amounts.
- `GET /api/commerce/paypal/checkout/return` — no-store return page; strips callback query parameters and submits verification with the signed-in session.
- `POST .../complete`, `.../cancel` — session-bound callback completion/cancellation.
- `POST .../reconcile`, `.../void` — provider verification or explicit void of this user's hold.

Legacy `/paypal/authorize`, `/paypal/capture`, `/paypal/refund`, `/paypal/void`, and mandate passkey payment-execution routes reject requests. The saved-wallet and old rail implementations are retained outside the active payment path. Their presence is not a claim of real merchant-order support.

[Historical design, explicitly not current behavior](docs/legacy-checkout-design.md). License: MIT.
