import { makePayPalRequestId } from './idempotency.mjs';

const PAYPAL_ENV = String(process.env.PAYPAL_ENV || 'sandbox').trim().toLowerCase();
if (PAYPAL_ENV !== 'sandbox') {
  throw new Error('LIVE_PAYMENTS_DISABLED: Keus review builds are Sandbox-only');
}
const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';

let cachedToken = null;

export async function getAccessToken() {
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
  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAtMs: now + data.expires_in * 1000 * 0.9,
  };
  return cachedToken.accessToken;
}

export async function createSetupToken(params) {
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

export async function createPaymentToken(setupTokenId, runId = 'onboard') {
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
  return { requestId: reqId, vaultId: body.id, data: body };
}

export async function createAuthorizedOrder(params) {
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
    orderId: body.id,
    status: body.status,
    authorizationId: authObj?.id ?? null,
    data: body,
  };
}

export async function captureAuthorization(params) {
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
  return { requestId: reqId, captureId: body.id, status: body.status, data: body };
}

export async function voidAuthorization(params) {
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
  return { requestId: reqId, authorizationId: params.authorizationId, status: 'VOIDED' };
}

export async function refundCapture(params) {
  const token = await getAccessToken();
  const reqId = makePayPalRequestId('ref', params.runId, `${params.captureId}:${params.amountValue ?? 'FULL'}`);
  const payload = {
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
  return { requestId: reqId, refundId: body.id, status: body.status, data: body };
}
