/**
 * Gate G0: Executable Proof of Money (docs/05_MILESTONES.md)
 *
 * When PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_VAULT_ID are set:
 *   1. Authenticates against https://api-m.sandbox.paypal.com/v1/oauth2/token
 *   2. Places a real $1.00 AUTHORIZE hold via POST /v2/checkout/orders using PAYPAL_VAULT_ID
 *   3. Prints the order_id and authorization_id
 *   4. Voids the hold via POST /v2/payments/authorizations/{auth_id}/void
 *
 * When PAYPAL_VAULT_ID is not yet set (Step 1 of onboarding):
 *   Creates a Vault v3 setup token (POST /v3/vault/setup-tokens) and prints the buyer approval URL.
 */

import {
  getAccessToken,
  createSetupToken,
  createAuthorizedOrder,
  voidAuthorization,
} from '../apps/web/lib/paypal/endpoints.ts';
import { computeMandateChallenge, computeEvidenceHash, type MandatePayload } from '../packages/shared/src/mandate.ts';
import { evaluatePolicy } from '../packages/shared/src/policy.ts';

async function main() {
  console.log('=== KUES // GATE G0 PROOF OF MONEY ===');
  const runId = 'run_01JBCUECLAWG0';

  // 1. Always verify local cryptographic mandate & policy gate first
  const sampleEvidence = Buffer.from('CUECLAW_PRE_CHECKOUT_FRAME_PNG_BYTES');
  const mandate: MandatePayload = {
    v: 1,
    runId,
    orderId: '5O190127TN364715T',
    authorizationId: '0AW1234567890',
    amountCents: 100,
    currency: 'USD',
    payee: 'merchant-sandbox@example.com',
    merchantDomain: 'store.example.com',
    evidenceHash: computeEvidenceHash(sampleEvidence),
    policyCeilingCents: 10000,
    issuedAt: new Date().toISOString(),
    nonce: 'b64u_test_nonce_20261024',
  };
  const challenge = computeMandateChallenge(mandate);
  const policyCheck = evaluatePolicy(
    {
      maxPerOrderCents: 10000,
      maxPerRunCents: 15000,
      expectedCurrency: 'USD',
      allowedDomains: ['store.example.com'],
      blockedPayees: [],
    },
    mandate
  );
  console.log('[LOCAL GATE CHECK] WebAuthn Challenge (SHA-256 base64url):', challenge);
  console.log('[LOCAL GATE CHECK] Policy Evaluation:', policyCheck);

  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    console.log('\n[DRY-RUN MODE] PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set in environment.');
    console.log('To execute live against api-m.sandbox.paypal.com:');
    console.log('  export PAYPAL_CLIENT_ID="..." PAYPAL_CLIENT_SECRET="..." PAYPAL_VAULT_ID="..."');
    console.log('  npm run prove:money');
    return;
  }

  const token = await getAccessToken();
  console.log('[LIVE SANDBOX] OAuth2 token acquired (length:', token.length, ')');

  const vaultId = process.env.PAYPAL_VAULT_ID;
  if (!vaultId) {
    const configuredBase = process.env.APP_BASE_URL;
    if (!configuredBase) throw new Error('APP_BASE_URL must be set to the deployed Keus origin before requesting a PayPal setup token.');
    const appOrigin = new URL(configuredBase).origin;
    const setup = await createSetupToken({
      runId,
      returnUrl: new URL('/api/paypal/vault/return', appOrigin).toString(),
      cancelUrl: new URL('/app?onboarding=cancelled', appOrigin).toString(),
    });
    console.log('[ONBOARDING] Created Vault v3 Setup Token:', setup.data.id);
    console.log('[ONBOARDING] Approve URL:', setup.data.links?.find((l: { rel: string }) => l.rel === 'approve')?.href);
    return;
  }

  const order = await createAuthorizedOrder({
    runId,
    vaultId,
    amountValue: '1.00',
    currencyCode: 'USD',
    description: 'Keus Gate G0 $1.00 Hold Verification',
  });
  console.log(`[HOLD CREATED] status=${order.status} order_id=${order.orderId} auth_id=${order.authorizationId}`);

  if (order.authorizationId) {
    const voidRes = await voidAuthorization({
      runId,
      authorizationId: order.authorizationId,
    });
    console.log(`[HOLD VOIDED]  status=${voidRes.status} auth_id=${voidRes.authorizationId} req_id=${voidRes.requestId}`);
  }
}

main().catch((err) => {
  console.error('[G0 ERROR]', err);
  process.exit(1);
});
