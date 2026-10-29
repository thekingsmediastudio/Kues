import crypto from 'node:crypto';
import { withWriteTransaction, withReadTransaction } from '../db/transaction.mjs';
import { makePayPalRequestId } from './idempotency.mjs';
import {
  createSetupToken,
  createPaymentToken,
  createAuthorizedOrder,
  voidAuthorization,
  captureAuthorization,
} from './endpoints.mjs';

export class PayPalSandboxError extends Error {
  constructor(code, statusCode, message, details = {}) {
    super(message);
    this.name = 'PayPalSandboxError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

function assertSandboxMode(env = process.env) {
  const mode = String(env.PAYPAL_ENV || 'sandbox').trim().toLowerCase();
  if (mode !== 'sandbox') {
    throw new PayPalSandboxError(
      'live_payments_disabled',
      403,
      'Live payment mode is strictly disabled. Keus builds are Sandbox-only.'
    );
  }
}

function hasLivePayPalCredentials(env = process.env) {
  const clientId = String(env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(env.PAYPAL_CLIENT_SECRET || '').trim();
  return Boolean(clientId && clientSecret);
}

/**
 * Initiates a one-time setup token for linking a user's PayPal Sandbox wallet.
 */
export async function createWalletSetupToken({
  workspaceId,
  userId,
  returnUrl = 'https://example.com/vault/return',
  cancelUrl = 'https://example.com/vault/cancel',
  simulate = false,
  now = Date.now(),
}) {
  assertSandboxMode();

  if (!workspaceId) throw new PayPalSandboxError('workspace_id_required', 400, 'Workspace ID is required');

  const runId = `setup_${workspaceId.slice(0, 12)}`;
  const canUseLive = hasLivePayPalCredentials() && !simulate;

  if (canUseLive) {
    try {
      const res = await createSetupToken({
        runId,
        returnUrl,
        cancelUrl,
      });
      const approveLink = res.data?.links?.find((l) => l.rel === 'approve')?.href;
      return {
        setupTokenId: res.data.id,
        approveUrl: approveLink || null,
        provider: 'paypal_sandbox',
        simulated: false,
      };
    } catch (err) {
      throw new PayPalSandboxError(
        'paypal_setup_token_failed',
        502,
        `PayPal Sandbox setup token generation failed: ${err.message}`,
        { error: err.message }
      );
    }
  }

  // Deterministic Sandbox simulation
  const hash = crypto.createHash('sha256').update(`${workspaceId}:${userId}:${now}`).digest('hex').toUpperCase();
  const setupTokenId = `ST-SANDBOX-${hash.slice(0, 16)}`;
  return {
    setupTokenId,
    approveUrl: `https://www.sandbox.paypal.com/agreements/approve?ba_token=BA-SANDBOX-${hash.slice(0, 12)}`,
    provider: 'paypal_sandbox',
    simulated: true,
  };
}

/**
 * Links a user's PayPal Sandbox wallet to their workspace by saving their distinct Vault ID.
 * Once linked, the autonomous agent can place pre-authorized holds with zero subsequent logins.
 */
export async function linkWorkspaceWallet({
  db,
  workspaceId,
  userId,
  setupTokenId = null,
  vaultTokenId = null,
  payerEmail = null,
  payerId = null,
  simulate = false,
  now = Date.now(),
}) {
  assertSandboxMode();

  if (!db) throw new PayPalSandboxError('database_required', 500, 'Database is required');
  if (!workspaceId) throw new PayPalSandboxError('workspace_id_required', 400, 'Workspace ID is required');
  if (!userId) throw new PayPalSandboxError('user_id_required', 400, 'User ID is required');

  const timestamp = isoNow(now);
  let effectiveVaultTokenId = vaultTokenId;
  let effectivePayerEmail = payerEmail;
  let effectivePayerId = payerId;

  const canUseLive = hasLivePayPalCredentials() && !simulate && setupTokenId && !setupTokenId.startsWith('ST-SANDBOX-');

  if (canUseLive) {
    try {
      const runId = `link_${workspaceId.slice(0, 12)}`;
      const res = await createPaymentToken(setupTokenId, runId);
      effectiveVaultTokenId = res.vaultId;
      effectivePayerEmail = res.data?.payment_source?.paypal?.email_address || payerEmail;
      effectivePayerId = res.data?.payment_source?.paypal?.account_id || payerId;
    } catch (err) {
      throw new PayPalSandboxError(
        'paypal_payment_token_failed',
        502,
        `Failed to exchange setup token for vault token: ${err.message}`,
        { error: err.message }
      );
    }
  } else if (!effectiveVaultTokenId) {
    const seed = `${workspaceId}:${userId}:${setupTokenId || timestamp}`;
    const hash = crypto.createHash('sha256').update(seed).digest('hex').toUpperCase();
    effectiveVaultTokenId = `VAULT-SANDBOX-${hash.slice(0, 16)}`;
    effectivePayerEmail = payerEmail || 'sandbox-buyer@personal.example.com';
    effectivePayerId = payerId || `PAYER-${hash.slice(16, 26)}`;
  }

  const walletId = `wlt_${crypto.randomUUID().replaceAll('-', '')}`;

  await withWriteTransaction(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO workspace_wallets (
              id, workspace_id, user_id, provider, vault_token_id,
              payer_email, payer_id, status, created_at, updated_at
            ) VALUES (?, ?, ?, 'paypal_sandbox', ?, ?, ?, 'active', ?, ?)
            ON CONFLICT(workspace_id, provider) DO UPDATE SET
              vault_token_id = excluded.vault_token_id,
              payer_email = excluded.payer_email,
              payer_id = excluded.payer_id,
              status = 'active',
              updated_at = excluded.updated_at`,
      args: [
        walletId,
        workspaceId,
        userId,
        effectiveVaultTokenId,
        effectivePayerEmail,
        effectivePayerId,
        timestamp,
        timestamp,
      ],
    });
  });

  return {
    id: walletId,
    workspaceId,
    userId,
    provider: 'paypal_sandbox',
    vaultTokenId: effectiveVaultTokenId,
    payerEmail: effectivePayerEmail,
    status: 'active',
    linkedAt: timestamp,
    sandboxNotice: 'One-time PayPal Sandbox wallet linked. Autonomous agents can now formulate and hold mandates without subsequent logins.',
  };
}

/**
 * Retrieves the currently active linked wallet for a workspace.
 */
export async function getWorkspaceWallet({ db, workspaceId }) {
  if (!db) throw new PayPalSandboxError('database_required', 500, 'Database is required');
  if (!workspaceId) throw new PayPalSandboxError('workspace_id_required', 400, 'Workspace ID is required');

  return withReadTransaction(db, async (tx) => {
    const res = await tx.execute({
      sql: `SELECT id, workspace_id, user_id, provider, vault_token_id,
                   payer_email, payer_id, status, created_at, updated_at
            FROM workspace_wallets
            WHERE workspace_id = ? AND provider = 'paypal_sandbox' AND status = 'active'`,
      args: [workspaceId],
    });

    const row = res.rows[0];
    if (!row) return null;

    const rawId = String(row.vault_token_id || '');
    const maskedVaultId = rawId.length > 4 ? `****${rawId.slice(-4)}` : rawId;

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      provider: row.provider,
      vaultTokenId: row.vault_token_id,
      maskedVaultId,
      payerEmail: row.payer_email,
      payerId: row.payer_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

/**
 * Revokes / unlinks a workspace's saved wallet.
 */
export async function unlinkWorkspaceWallet({ db, workspaceId, userId, now = Date.now() }) {
  if (!db) throw new PayPalSandboxError('database_required', 500, 'Database is required');
  if (!workspaceId) throw new PayPalSandboxError('workspace_id_required', 400, 'Workspace ID is required');

  const timestamp = isoNow(now);

  await withWriteTransaction(db, async (tx) => {
    await tx.execute({
      sql: `UPDATE workspace_wallets
            SET status = 'revoked', updated_at = ?
            WHERE workspace_id = ? AND provider = 'paypal_sandbox'`,
      args: [timestamp, workspaceId],
    });
  });

  return { ok: true, unlinked: true, unlinkedAt: timestamp };
}

/**
 * Creates an AUTHORIZE order in PayPal Sandbox bound to an authorized purchase mandate.
 * Adheres to Roadmap Step 6:
 * - Deterministic policy checks must pass (mandate status === 'authorized').
 * - Do not capture automatically (intent: 'AUTHORIZE' only).
 * - Uses workspace's saved distinct vault_id if linked.
 * - Keep PayPal test payee configurable and explicitly distinct from Channel3 merchant discovery.
 * - Stable PayPal request IDs and safe void path.
 */
export async function createSandboxPaymentAuthorization({
  db,
  workspaceId,
  userId,
  mandateId,
  testPayeeEmail = null,
  vaultId = null,
  simulate = false,
  now = Date.now(),
}) {
  assertSandboxMode();

  if (!db) throw new PayPalSandboxError('database_required', 500, 'Database is required');
  if (!workspaceId) throw new PayPalSandboxError('workspace_id_required', 400, 'Workspace ID is required');
  if (!userId) throw new PayPalSandboxError('user_id_required', 400, 'User ID is required');
  if (!mandateId) throw new PayPalSandboxError('mandate_id_required', 400, 'Mandate ID is required');

  const timestamp = isoNow(now);

  // 1. Fetch and validate mandate
  const mandate = await withReadTransaction(db, async (tx) => {
    const res = await tx.execute({
      sql: `SELECT id, workspace_id, run_id, amount_minor, currency, payee,
                   merchant_domain, evidence_hash, status, expires_at
            FROM mandates
            WHERE workspace_id = ? AND id = ?`,
      args: [workspaceId, mandateId],
    });
    return res.rows[0] || null;
  });

  if (!mandate) {
    throw new PayPalSandboxError('mandate_not_found', 404, 'Purchase mandate not found');
  }

  if (mandate.status !== 'authorized') {
    throw new PayPalSandboxError(
      'mandate_not_authorized',
      409,
      `Mandate must be authorized by user before creating payment hold. Current status: ${mandate.status}`
    );
  }

  // 2. Check for existing payment transaction (idempotency)
  const existing = await withReadTransaction(db, async (tx) => {
    const res = await tx.execute({
      sql: `SELECT id, workspace_id, run_id, mandate_id, provider, amount_minor,
                   currency, external_order_id, authorization_id, capture_id,
                   status, created_at, updated_at
            FROM agent_payment_transactions
            WHERE workspace_id = ? AND mandate_id = ?`,
      args: [workspaceId, mandateId],
    });
    return res.rows[0] || null;
  });

  const amountValue = (mandate.amount_minor / 100).toFixed(2);
  const currencyCode = mandate.currency || 'USD';
  const effectivePayee = testPayeeEmail
    || process.env.PAYPAL_TEST_PAYEE_EMAIL
    || 'sandbox-merchant@kues.test';

  if (existing) {
    return {
      id: existing.id,
      workspaceId: existing.workspace_id,
      runId: existing.run_id,
      mandateId: existing.mandate_id,
      provider: existing.provider,
      amountMinor: existing.amount_minor,
      amountFormatted: `$${(existing.amount_minor / 100).toFixed(2)} ${existing.currency}`,
      currency: existing.currency,
      externalOrderId: existing.external_order_id,
      authorizationId: existing.authorization_id,
      status: existing.status,
      testPayeeEmail: effectivePayee,
      merchantDomain: mandate.merchant_domain,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
      sandboxNotice: 'PayPal Sandbox test authorization only; no real money moved and test payee is separate from merchant.',
      idempotent: true,
    };
  }

  // 3. Resolve user/workspace distinct vault token
  const workspaceWallet = await getWorkspaceWallet({ db, workspaceId });
  const effectiveVaultId = vaultId
    || workspaceWallet?.vaultTokenId
    || process.env.PAYPAL_VAULT_ID
    || null;

  const requestId = makePayPalRequestId('ord', mandate.run_id, `${mandate.id}:${amountValue}`);

  let externalOrderId;
  let authorizationId;
  let orderData = null;

  const canUseLiveCredentials = hasLivePayPalCredentials() && !simulate && effectiveVaultId && !effectiveVaultId.startsWith('VAULT-SANDBOX-');

  if (canUseLiveCredentials) {
    try {
      const order = await createAuthorizedOrder({
        runId: mandate.run_id,
        vaultId: effectiveVaultId,
        amountValue,
        currencyCode,
        description: `Kues Autonomous Purchase Mandate: ${mandate.id}`,
      });
      externalOrderId = order.orderId;
      authorizationId = order.authorizationId;
      orderData = order.data;
    } catch (err) {
      throw new PayPalSandboxError(
        'paypal_order_creation_failed',
        502,
        `PayPal Sandbox order authorization failed: ${err.message}`,
        { error: err.message }
      );
    }
  } else {
    // Deterministic Sandbox simulation
    const seed = `${mandate.id}:${mandate.amount_minor}:${effectiveVaultId || requestId}`;
    const hash = crypto.createHash('sha256').update(seed).digest('hex').toUpperCase();
    externalOrderId = `ORD-SANDBOX-${hash.slice(0, 16)}`;
    authorizationId = `AUTH-SANDBOX-${hash.slice(16, 32)}`;
    orderData = {
      id: externalOrderId,
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      payer: {
        email_address: workspaceWallet?.payerEmail || 'sandbox-buyer@kues.test',
        vault_id: effectiveVaultId,
      },
      purchase_units: [
        {
          reference_id: mandate.run_id,
          payments: {
            authorizations: [
              {
                id: authorizationId,
                status: 'CREATED',
                amount: { currency_code: currencyCode, value: amountValue },
              },
            ],
          },
        },
      ],
    };
  }

  const transactionId = `apt_${crypto.randomUUID().replaceAll('-', '')}`;

  // 4. Persist transaction and run event atomically
  await withWriteTransaction(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO agent_payment_transactions (
              id, workspace_id, run_id, mandate_id, provider, amount_minor,
              currency, external_order_id, authorization_id, status,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'paypal_sandbox', ?, ?, ?, ?, 'authorized', ?, ?)`,
      args: [
        transactionId,
        workspaceId,
        mandate.run_id,
        mandate.id,
        mandate.amount_minor,
        currencyCode,
        externalOrderId,
        authorizationId,
        timestamp,
        timestamp,
      ],
    });

    await tx.execute({
      sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
            VALUES (?, ?, ?, 'payment_authorized', ?, ?)`,
      args: [
        `evt_${crypto.randomUUID().replaceAll('-', '')}`,
        workspaceId,
        mandate.run_id,
        JSON.stringify({
          transactionId,
          mandateId: mandate.id,
          vaultId: effectiveVaultId,
          externalOrderId,
          authorizationId,
          amountMinor: mandate.amount_minor,
          currency: currencyCode,
          testPayeeEmail: effectivePayee,
          merchantDomain: mandate.merchant_domain,
          provider: 'paypal_sandbox',
          simulated: !canUseLiveCredentials,
        }),
        timestamp,
      ],
    });
  });

  return {
    id: transactionId,
    workspaceId,
    runId: mandate.run_id,
    mandateId: mandate.id,
    provider: 'paypal_sandbox',
    vaultId: effectiveVaultId,
    amountMinor: mandate.amount_minor,
    amountFormatted: `$${amountValue} ${currencyCode}`,
    currency: currencyCode,
    externalOrderId,
    authorizationId,
    status: 'authorized',
    testPayeeEmail: effectivePayee,
    merchantDomain: mandate.merchant_domain,
    createdAt: timestamp,
    updatedAt: timestamp,
    sandboxNotice: 'PayPal Sandbox test authorization only; no real money moved and test payee is separate from merchant.',
    orderData,
  };
}

/**
 * Safely voids an active PayPal Sandbox authorization hold.
 */
export async function voidSandboxPaymentAuthorization({
  db,
  workspaceId,
  userId,
  mandateId = null,
  transactionId = null,
  reason = 'User requested void of test hold',
  simulate = false,
  now = Date.now(),
}) {
  assertSandboxMode();

  if (!db) throw new PayPalSandboxError('database_required', 500, 'Database is required');
  if (!workspaceId) throw new PayPalSandboxError('workspace_id_required', 400, 'Workspace ID is required');
  if (!mandateId && !transactionId) {
    throw new PayPalSandboxError('target_required', 400, 'mandateId or transactionId must be provided');
  }

  const timestamp = isoNow(now);

  const txRecord = await withReadTransaction(db, async (tx) => {
    let query;
    let args;
    if (transactionId) {
      query = `SELECT id, workspace_id, run_id, mandate_id, external_order_id,
                      authorization_id, status, amount_minor, currency
               FROM agent_payment_transactions
               WHERE workspace_id = ? AND id = ?`;
      args = [workspaceId, transactionId];
    } else {
      query = `SELECT id, workspace_id, run_id, mandate_id, external_order_id,
                      authorization_id, status, amount_minor, currency
               FROM agent_payment_transactions
               WHERE workspace_id = ? AND mandate_id = ?`;
      args = [workspaceId, mandateId];
    }
    const res = await tx.execute({ sql: query, args });
    return res.rows[0] || null;
  });

  if (!txRecord) {
    throw new PayPalSandboxError('transaction_not_found', 404, 'Payment transaction not found');
  }

  if (txRecord.status === 'voided') {
    return {
      id: txRecord.id,
      mandateId: txRecord.mandate_id,
      authorizationId: txRecord.authorization_id,
      status: 'voided',
      reason,
      voidedAt: timestamp,
      idempotent: true,
    };
  }

  if (txRecord.status !== 'authorized') {
    throw new PayPalSandboxError(
      'transaction_not_voidable',
      409,
      `Cannot void transaction in status: ${txRecord.status}. Only authorized holds can be voided.`
    );
  }

  const canUseLiveCredentials = hasLivePayPalCredentials() && !simulate && !txRecord.authorization_id.startsWith('AUTH-SANDBOX-');

  if (canUseLiveCredentials) {
    try {
      await voidAuthorization({
        runId: txRecord.run_id,
        authorizationId: txRecord.authorization_id,
      });
    } catch (err) {
      throw new PayPalSandboxError(
        'paypal_void_failed',
        502,
        `PayPal Sandbox void failed: ${err.message}`,
        { error: err.message }
      );
    }
  }

  await withWriteTransaction(db, async (tx) => {
    await tx.execute({
      sql: `UPDATE agent_payment_transactions
            SET status = 'voided', updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
      args: [timestamp, workspaceId, txRecord.id],
    });

    await tx.execute({
      sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
            VALUES (?, ?, ?, 'payment_voided', ?, ?)`,
      args: [
        `evt_${crypto.randomUUID().replaceAll('-', '')}`,
        workspaceId,
        txRecord.run_id,
        JSON.stringify({
          transactionId: txRecord.id,
          mandateId: txRecord.mandate_id,
          authorizationId: txRecord.authorization_id,
          reason,
        }),
        timestamp,
      ],
    });
  });

  return {
    id: txRecord.id,
    mandateId: txRecord.mandate_id,
    authorizationId: txRecord.authorization_id,
    status: 'voided',
    reason,
    voidedAt: timestamp,
  };
}

/**
 * Captures an authorized PayPal Sandbox payment hold (explicitly manual, never automatic).
 */
export async function captureSandboxPaymentAuthorization({
  db,
  workspaceId,
  userId,
  mandateId = null,
  transactionId = null,
  note = 'Approved via Kues Autonomous Commerce Mandate',
  simulate = false,
  now = Date.now(),
}) {
  assertSandboxMode();

  if (!db) throw new PayPalSandboxError('database_required', 500, 'Database is required');
  if (!workspaceId) throw new PayPalSandboxError('workspace_id_required', 400, 'Workspace ID is required');

  const timestamp = isoNow(now);

  const txRecord = await withReadTransaction(db, async (tx) => {
    let query;
    let args;
    if (transactionId) {
      query = `SELECT id, workspace_id, run_id, mandate_id, external_order_id,
                      authorization_id, status, amount_minor, currency
               FROM agent_payment_transactions
               WHERE workspace_id = ? AND id = ?`;
      args = [workspaceId, transactionId];
    } else {
      query = `SELECT id, workspace_id, run_id, mandate_id, external_order_id,
                      authorization_id, status, amount_minor, currency
               FROM agent_payment_transactions
               WHERE workspace_id = ? AND mandate_id = ?`;
      args = [workspaceId, mandateId];
    }
    const res = await tx.execute({ sql: query, args });
    return res.rows[0] || null;
  });

  if (!txRecord) {
    throw new PayPalSandboxError('transaction_not_found', 404, 'Payment transaction not found');
  }

  if (txRecord.status === 'captured') {
    return {
      id: txRecord.id,
      mandateId: txRecord.mandate_id,
      authorizationId: txRecord.authorization_id,
      status: 'captured',
      idempotent: true,
    };
  }

  if (txRecord.status !== 'authorized') {
    throw new PayPalSandboxError(
      'transaction_not_capturable',
      409,
      `Cannot capture transaction in status: ${txRecord.status}. Only authorized holds can be captured.`
    );
  }

  let captureId;
  const canUseLiveCredentials = hasLivePayPalCredentials() && !simulate && !txRecord.authorization_id.startsWith('AUTH-SANDBOX-');

  if (canUseLiveCredentials) {
    try {
      const cap = await captureAuthorization({
        runId: txRecord.run_id,
        authorizationId: txRecord.authorization_id,
        note,
      });
      captureId = cap.captureId;
    } catch (err) {
      throw new PayPalSandboxError(
        'paypal_capture_failed',
        502,
        `PayPal Sandbox capture failed: ${err.message}`,
        { error: err.message }
      );
    }
  } else {
    captureId = `CAP-SANDBOX-${crypto.randomUUID().slice(0, 16).toUpperCase()}`;
  }

  const receiptId = `rcpt_${crypto.randomUUID().replaceAll('-', '')}`;
  const receiptHash = `sha256:${crypto.createHash('sha256').update(`${receiptId}:${captureId}:${timestamp}`).digest('hex')}`;
  const receiptJson = JSON.stringify({
    receiptId,
    workspaceId,
    runId: txRecord.run_id,
    mandateId: txRecord.mandate_id,
    authorizationId: txRecord.authorization_id,
    captureId,
    amountMinor: txRecord.amount_minor,
    currency: txRecord.currency,
    status: 'captured',
    capturedAt: timestamp,
    provider: 'paypal_sandbox',
    sandboxNotice: 'Sandbox simulation test capture; no real funds moved.',
  });

  await withWriteTransaction(db, async (tx) => {
    await tx.execute({
      sql: `UPDATE agent_payment_transactions
            SET status = 'captured', capture_id = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
      args: [captureId, timestamp, workspaceId, txRecord.id],
    });

    await tx.execute({
      sql: `INSERT INTO receipts (id, workspace_id, run_id, mandate_id, status, receipt_hash, receipt_json, created_at)
            VALUES (?, ?, ?, ?, 'captured', ?, ?, ?)`,
      args: [receiptId, workspaceId, txRecord.run_id, txRecord.mandate_id, receiptHash, receiptJson, timestamp],
    });

    await tx.execute({
      sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
            VALUES (?, ?, ?, 'payment_captured', ?, ?)`,
      args: [
        `evt_${crypto.randomUUID().replaceAll('-', '')}`,
        workspaceId,
        txRecord.run_id,
        JSON.stringify({
          transactionId: txRecord.id,
          mandateId: txRecord.mandate_id,
          authorizationId: txRecord.authorization_id,
          captureId,
          receiptId,
        }),
        timestamp,
      ],
    });
  });

  return {
    id: txRecord.id,
    mandateId: txRecord.mandate_id,
    authorizationId: txRecord.authorization_id,
    captureId,
    status: 'captured',
    receiptId,
    receiptHash,
    capturedAt: timestamp,
  };
}

/**
 * Retrieves payment transaction and receipt details for a mandate.
 */
export async function getSandboxPaymentTransaction({ db, workspaceId, mandateId }) {
  if (!db) throw new PayPalSandboxError('database_required', 500, 'Database is required');
  if (!workspaceId) throw new PayPalSandboxError('workspace_id_required', 400, 'Workspace ID is required');
  if (!mandateId) throw new PayPalSandboxError('mandate_id_required', 400, 'Mandate ID is required');

  return withReadTransaction(db, async (tx) => {
    const res = await tx.execute({
      sql: `SELECT t.id, t.workspace_id, t.run_id, t.mandate_id, t.provider,
                   t.amount_minor, t.currency, t.external_order_id, t.authorization_id,
                   t.capture_id, t.status, t.created_at, t.updated_at,
                   r.id AS receipt_id, r.receipt_hash, r.receipt_json
            FROM agent_payment_transactions t
            LEFT JOIN receipts r ON r.mandate_id = t.mandate_id
            WHERE t.workspace_id = ? AND t.mandate_id = ?`,
      args: [workspaceId, mandateId],
    });

    const row = res.rows[0];
    if (!row) return null;

    let receiptData = null;
    if (row.receipt_json) {
      try {
        receiptData = JSON.parse(row.receipt_json);
      } catch {}
    }

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      mandateId: row.mandate_id,
      provider: row.provider,
      amountMinor: row.amount_minor,
      amountFormatted: `$${(row.amount_minor / 100).toFixed(2)} ${row.currency}`,
      currency: row.currency,
      externalOrderId: row.external_order_id,
      authorizationId: row.authorization_id,
      captureId: row.capture_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      receipt: receiptData ? { id: row.receipt_id, hash: row.receipt_hash, ...receiptData } : null,
      sandboxNotice: 'PayPal Sandbox test transaction only; no real money moved.',
    };
  });
}
