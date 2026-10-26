import { makePayPalRequestId } from './idempotency.ts';

const PAYPAL_BASE =
  process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

let cachedToken: { accessToken: string; expiresAtMs: number } | null = null;

/**
 * 3.1 OAuth2 Client Credentials token with 90%-TTL caching (doc 03 §3.1)
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAtMs) {
    return cachedToken.accessToken;
  }
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('MISSING_PAYPAL_CREDENTIALS: Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
  }
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PAYPAL_AUTH_FAILED (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: data.access_token,
    expiresAtMs: now + data.expires_in * 1000 * 0.9,
  };
  return cachedToken.accessToken;
}

/**
 * 3.2 Onboarding Step 1: Create Vault v3 Setup Token (POST /v3/vault/setup-tokens)
 */
export async function createSetupToken(params: {
  runId: string;
  returnUrl: string;
  cancelUrl: string;
}) {
  const token = await getAccessToken();
  const reqId = makePayPalRequestId('setup', params.runId, 'setup');
  const res = await fetch(`${PAYPAL_BASE}/v3/vault/setup-tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': reqId,
    },
    body: JSON.stringify({
      payment_source: {
        paypal: {
          description: 'Keus — human-mandated agent purchasing',
          usage_pattern: 'IMMEDIATE',
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          permit_multiple_payment_tokens: true,
          experience_context: {
            brand_name: 'Keus',
            locale: 'en-US',
            return_url: params.returnUrl,
            cancel_url: params.cancelUrl,
            user_action: 'CONTINUE',
          },
        },
      },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`SETUP_TOKEN_FAILED (${res.status}): ${JSON.stringify(body)}`);
  return { requestId: reqId, data: body };
}

/**
 * 3.3 Onboarding Step 2: Exchange Setup Token -> Reusable Vault ID (POST /v3/vault/payment-tokens)
 */
export async function createPaymentToken(setupTokenId: string, runId = 'onboard') {
  const token = await getAccessToken();
  const reqId = makePayPalRequestId('ptok', runId, setupTokenId);
  const res = await fetch(`${PAYPAL_BASE}/v3/vault/payment-tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': reqId,
    },
    body: JSON.stringify({
      payment_source: {
        token: {
          id: setupTokenId,
          type: 'SETUP_TOKEN',
        },
      },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`PAYMENT_TOKEN_FAILED (${res.status}): ${JSON.stringify(body)}`);
  return { requestId: reqId, vaultId: body.id as string, data: body };
}

/**
 * 3.4 Hold Stage: Create Authorized Order using Vault ID (POST /v2/checkout/orders)
 */
export async function createAuthorizedOrder(params: {
  runId: string;
  vaultId: string;
  amountValue: string;
  currencyCode?: string;
  description: string;
}) {
  const token = await getAccessToken();
  const reqId = makePayPalRequestId('ord', params.runId, `${params.vaultId}:${params.amountValue}`);
  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': reqId,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: params.runId,
          description: params.description,
          amount: {
            currency_code: params.currencyCode ?? 'USD',
            value: params.amountValue,
          },
        },
      ],
      payment_source: {
        paypal: {
          vault_id: params.vaultId,
        },
      },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`CREATE_ORDER_FAILED (${res.status}): ${JSON.stringify(body)}`);
  const authObj = body?.purchase_units?.[0]?.payments?.authorizations?.[0];
  return {
    requestId: reqId,
    orderId: body.id as string,
    status: body.status as string,
    authorizationId: (authObj?.id ?? null) as string | null,
    data: body,
  };
}

/**
 * 3.5A Settlement Approve: Capture Authorization via Payments v2 (POST /v2/payments/authorizations/{auth_id}/capture)
 */
export async function captureAuthorization(params: {
  runId: string;
  authorizationId: string;
  note?: string;
}) {
  const token = await getAccessToken();
  const reqId = makePayPalRequestId('cap', params.runId, params.authorizationId);
  const res = await fetch(
    `${PAYPAL_BASE}/v2/payments/authorizations/${encodeURIComponent(params.authorizationId)}/capture`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': reqId,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        final_capture: true,
        note_to_payer: params.note ?? 'Approved on separate device via WebAuthn passkey mandate',
      }),
    }
  );
  const body = await res.json();
  if (!res.ok) throw new Error(`CAPTURE_FAILED (${res.status}): ${JSON.stringify(body)}`);
  return { requestId: reqId, captureId: body.id as string, status: body.status as string, data: body };
}

/**
 * 3.5B Settlement Reject / Policy Block: Void Authorization via Payments v2 (POST /v2/payments/authorizations/{auth_id}/void)
 */
export async function voidAuthorization(params: {
  runId: string;
  authorizationId: string;
}) {
  const token = await getAccessToken();
  const reqId = makePayPalRequestId('void', params.runId, params.authorizationId);
  const res = await fetch(
    `${PAYPAL_BASE}/v2/payments/authorizations/${encodeURIComponent(params.authorizationId)}/void`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': reqId,
      },
    }
  );
  if (res.status !== 204 && !res.ok) {
    const text = await res.text();
    throw new Error(`VOID_FAILED (${res.status}): ${text}`);
  }
  return { requestId: reqId, authorizationId: params.authorizationId, status: 'VOIDED' as const };
}

/**
 * 3.6 Dispute Defense: 1-Click Partial or Full Refund via Payments v2 (POST /v2/payments/captures/{capture_id}/refund)
 */
export async function refundCapture(params: {
  runId: string;
  captureId: string;
  amountValue?: string;
  currencyCode?: string;
  note?: string;
}) {
  const token = await getAccessToken();
  const reqId = makePayPalRequestId('ref', params.runId, `${params.captureId}:${params.amountValue ?? 'FULL'}`);
  const payload: Record<string, unknown> = {
    note_to_payer: params.note ?? 'Refunded from Keus Flight-Recorder receipt',
  };
  if (params.amountValue) {
    payload.amount = {
      currency_code: params.currencyCode ?? 'USD',
      value: params.amountValue,
    };
  }
  const res = await fetch(
    `${PAYPAL_BASE}/v2/payments/captures/${encodeURIComponent(params.captureId)}/refund`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': reqId,
      },
      body: JSON.stringify(payload),
    }
  );
  const body = await res.json();
  if (!res.ok) throw new Error(`REFUND_FAILED (${res.status}): ${JSON.stringify(body)}`);
  return { requestId: reqId, refundId: body.id as string, status: body.status as string, data: body };
}
