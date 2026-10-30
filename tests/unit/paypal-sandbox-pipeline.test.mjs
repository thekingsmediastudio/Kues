import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAuthService } from '../../apps/web/lib/auth/service.mjs';
import { createWorkspaceService } from '../../apps/web/lib/workspaces/service.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import { createServer } from '../../apps/web/server.mjs';
import {
  createPurchaseMandate,
  authorizePurchaseMandate,
} from '../../apps/web/lib/channel3/mandate-service.mjs';
import {
  createSandboxPaymentAuthorization,
  voidSandboxPaymentAuthorization,
  captureSandboxPaymentAuthorization,
  refundSandboxPaymentCapture,
  getSandboxPaymentTransaction,
  createWalletSetupToken,
  linkWorkspaceWallet,
  getWorkspaceWallet,
  unlinkWorkspaceWallet,
  PayPalSandboxError,
} from '../../apps/web/lib/paypal/service.mjs';

async function setupTestEnvironment() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);

  const authService = createAuthService({ db });
  const workspaceService = createWorkspaceService({ db });

  const session = await authService.createWorkOSSession({
    providerSubject: 'sub_test_buyer_paypal',
    email: 'paypal_buyer@example.test',
    emailVerified: true,
    displayName: 'PayPal Buyer',
  });

  const bootstrap = await workspaceService.getBootstrap({ userId: session.user.id });
  let agentId = bootstrap.agents[0]?.id;
  if (!agentId) {
    const created = await workspaceService.createAgent({
      userId: session.user.id,
      input: {
        name: 'Procure Scout',
        role: 'Autonomous buyer',
        avatar: 'cart',
        color: '#4c8dff',
        approvalPath: 'desktop',
        orderCap: 150,
        dailyCap: 500,
        apps: ['channel3', 'paypal'],
        memoryPills: [],
      },
    });
    agentId = created.createdAgentId || created.agents?.[0]?.id;
  }

  const wsId = bootstrap.workspace.id;
  const userId = session.user.id;

  return { db, authService, workspaceService, session, wsId, userId, agentId };
}

async function withServer(config, context, run) {
  const server = createServer({
    config,
    authService: context.authService,
    workspaceService: context.workspaceService,
    db: context.db,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('createSandboxPaymentAuthorization rejects unapproved mandates and enforces sandbox mode', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  // Create pending mandate (not authorized yet)
  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Ergonomic Desk Chair',
      merchantDomain: 'ergodesign.com',
      amountMinor: 8500,
      currency: 'USD',
      evidenceHash: 'sha256:7777777777777777777777777777777777777777777777777777777777777777',
    },
  });

  assert.equal(mandateResult.allowed, true);

  // Attempting to authorize payment before mandate approval must fail
  await assert.rejects(
    async () => {
      await createSandboxPaymentAuthorization({
        db,
        workspaceId: wsId,
        userId,
        mandateId: mandateResult.mandateId,
      });
    },
    (err) => {
      assert.ok(err instanceof PayPalSandboxError);
      assert.equal(err.code, 'mandate_not_authorized');
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
});

test('createSandboxPaymentAuthorization creates AUTHORIZE hold on approved mandate with separated test payee', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Mechanical Keyboard Q3',
      merchantDomain: 'keychron.example.com',
      amountMinor: 9500, // $95.00
      currency: 'USD',
      evidenceHash: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
    },
  });

  // User authorizes mandate
  await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  // Create PayPal Sandbox Authorization
  const tx = await createSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
    testPayeeEmail: 'test-seller@sandbox.kues.local',
  });

  assert.equal(tx.status, 'authorized');
  assert.equal(tx.provider, 'paypal_sandbox');
  assert.equal(tx.amountMinor, 9500);
  assert.equal(tx.amountFormatted, '$95.00 USD');
  assert.equal(tx.currency, 'USD');
  assert.equal(tx.testPayeeEmail, 'test-seller@sandbox.kues.local');
  assert.equal(tx.merchantDomain, 'keychron.example.com');
  assert.match(tx.externalOrderId, /^ORD-SANDBOX-[A-F0-9]{16}$/);
  assert.match(tx.authorizationId, /^AUTH-SANDBOX-[A-F0-9]{16}$/);
  assert.match(tx.sandboxNotice, /PayPal Sandbox test authorization only/);

  // Verify persistence in agent_payment_transactions table
  const lookup = await getSandboxPaymentTransaction({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
  });
  assert.ok(lookup);
  assert.equal(lookup.id, tx.id);
  assert.equal(lookup.status, 'authorized');
  assert.equal(lookup.externalOrderId, tx.externalOrderId);
  assert.equal(lookup.authorizationId, tx.authorizationId);

  // Verify idempotency
  const repeatedTx = await createSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });
  assert.equal(repeatedTx.id, tx.id);
  assert.equal(repeatedTx.idempotent, true);
});

test('voidSandboxPaymentAuthorization voids an active authorization and logs run events', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Studio Monitor Stand',
      merchantDomain: 'grovemade.com',
      amountMinor: 6000,
      currency: 'USD',
      evidenceHash: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
    },
  });

  await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  const tx = await createSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });
  assert.equal(tx.status, 'authorized');

  // Void authorization
  const voidResult = await voidSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
    reason: 'Test reviewer cancelled checkout',
  });

  assert.equal(voidResult.status, 'voided');
  assert.equal(voidResult.mandateId, mandateResult.mandateId);
  assert.equal(voidResult.authorizationId, tx.authorizationId);

  // Check database reflects voided state
  const lookup = await getSandboxPaymentTransaction({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
  });
  assert.equal(lookup.status, 'voided');

  // Check run_events contains payment_voided event
  const events = await db.execute({
    sql: `SELECT event_type, details_json FROM run_events WHERE workspace_id = ? AND run_id = ? ORDER BY created_at DESC`,
    args: [wsId, mandateResult.runId],
  });
  const eventTypes = events.rows.map((r) => r.event_type);
  assert.ok(eventTypes.includes('payment_authorized'));
  assert.ok(eventTypes.includes('payment_voided'));

  // Verify voiding directly by authorizationId is also supported
  const voidByAuthId = await voidSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    userId,
    authorizationId: tx.authorizationId,
    reason: 'Test void by authorizationId',
  });
  assert.equal(voidByAuthId.status, 'voided');
  assert.equal(voidByAuthId.idempotent, true);
});

test('captureSandboxPaymentAuthorization captures hold and records receipt', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Desk Mat XL',
      merchantDomain: 'nordic.example.com',
      amountMinor: 3500,
      currency: 'USD',
      evidenceHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  });

  await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  await createSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  // Manual capture
  const capResult = await captureSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
    note: 'Verified delivery in sandbox test',
  });

  assert.equal(capResult.status, 'captured');
  assert.match(capResult.captureId, /^CAP-SANDBOX-/);
  assert.match(capResult.receiptHash, /^sha256:[a-f0-9]{64}$/);

  // Verify lookup returns receipt data
  const lookup = await getSandboxPaymentTransaction({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
  });
  assert.equal(lookup.status, 'captured');
  assert.ok(lookup.receipt);
  assert.equal(lookup.receipt.status, 'captured');
  assert.equal(lookup.receipt.amountMinor, 3500);
});

test('HTTP Commerce Routes: /api/commerce/paypal/authorize and /void work over HTTP', async () => {
  const { db, authService, workspaceService, session, wsId, userId, agentId } = await setupTestEnvironment();

  const config = loadServerConfig({
    TURSO_DATABASE_URL: 'file:./local.db',
  });

  const ctx = {
    db,
    authService,
    workspaceService,
  };

  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Ergonomic Palm Rest',
      merchantDomain: 'grovemade.com',
      amountMinor: 2500,
      currency: 'USD',
      evidenceHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  });

  await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  await withServer(config, ctx, async (base) => {
    // 1. Authorize PayPal Sandbox Hold over HTTP
    const authRes = await fetch(`${base}/api/commerce/paypal/authorize`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mandateId: mandateResult.mandateId,
        testPayeeEmail: 'sandbox-partner@kues.test',
      }),
    });

    assert.equal(authRes.status, 201);
    const authData = await authRes.json();
    assert.equal(authData.ok, true);
    assert.equal(authData.transaction.status, 'authorized');
    assert.equal(authData.transaction.amountMinor, 2500);
    assert.match(authData.transaction.authorizationId, /^AUTH-SANDBOX-/);

    // 2. Fetch Transaction over HTTP
    const getRes = await fetch(`${base}/api/commerce/paypal/transactions/${mandateResult.mandateId}`, {
      method: 'GET',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
      },
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.ok, true);
    assert.equal(getData.transaction.authorizationId, authData.transaction.authorizationId);

    // 3. Void PayPal Sandbox Hold over HTTP
    const voidRes = await fetch(`${base}/api/commerce/paypal/void`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mandateId: mandateResult.mandateId,
        reason: 'Reviewer test cancellation',
      }),
    });
    assert.equal(voidRes.status, 200);
    const voidData = await voidRes.json();
    assert.equal(voidData.ok, true);
    assert.equal(voidData.transaction.status, 'voided');
  });
});

test('chat tool-approval flow creates PayPal Sandbox hold automatically upon mandate approval', async () => {
  const { db, authService, workspaceService, session, wsId, userId, agentId } = await setupTestEnvironment();

  const productEvidence = {
    title: 'Custom Wooden Wrist Rest',
    merchantDomain: 'grovemade.com',
    amountMinor: 4500,
    currency: 'USD',
    evidenceHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  };

  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: productEvidence,
  });

  const aiChatService = {
    isReady: async () => true,
    complete: async () => {
      const toolMarker = `[[KEUS_WORKSPACE_TOOL:{"name":"purchase_product","arguments":{"productTitle":"${productEvidence.title}","merchantDomain":"${productEvidence.merchantDomain}","amountMinor":${productEvidence.amountMinor},"currency":"USD","evidenceHash":"${productEvidence.evidenceHash}"}}]]`;
      return {
        text: toolMarker,
        provider: 'mock-provider',
        model: 'mock-model',
        inputTokens: 25,
        outputTokens: 40,
      };
    },
  };

  const usageService = {
    reserveTokens: async () => ({ allowed: true }),
    settleTokenReservation: async () => ({ settled: true }),
    releaseTokenReservation: async () => {},
  };

  const aiChatHistoryService = {
    appendExchange: async () => {},
    getRecentMessages: async () => [],
    recordPendingToolAction: async () => {},
  };

  const aiProviderService = {
    getActiveChatProvider: async () => ({
      providerKey: 'mock-provider',
      modelId: 'mock-model',
    }),
  };

  const config = loadServerConfig({
    AI_PROVIDER_CHAT_TEST_ENABLED: '1',
    AI_PROVIDER_ADMIN_EMAILS: 'paypal_buyer@example.test',
    AI_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_wos',
    WORKOS_CLIENT_ID: 'client_wos',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  });

  const ctx = {
    db,
    authService,
    workspaceService,
    aiChatService,
    aiChatHistoryService,
    aiProviderService,
    usageService,
  };

  const server = createServer({
    config,
    ...ctx,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Send chat message to trigger tool proposal
    const chatRes = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId,
        message: 'Please purchase the custom wooden wrist rest',
      }),
    });

    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.ok(chatData.pendingAction);
    const actionId = chatData.pendingAction.actionId;

    // 2. Approve proposal: verifies mandate AND creates PayPal Sandbox hold
    const approvalRes = await fetch(`${base}/api/chat/tool-approval`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        actionId,
        decision: 'approve',
      }),
    });

    assert.equal(approvalRes.status, 200);
    const approvalData = await approvalRes.json();
    assert.equal(approvalData.status, 'approved');
    assert.match(approvalData.message, /PayPal Sandbox Hold Created/);
    assert.ok(approvalData.paymentHold);
    assert.equal(approvalData.paymentHold.status, 'authorized');
    assert.match(approvalData.paymentHold.authorizationId, /^AUTH-SANDBOX-/);
    assert.equal(approvalData.paymentHold.amountMinor, 4500);

    // 3. Verify in database
    const tx = await getSandboxPaymentTransaction({
      db,
      workspaceId: wsId,
      mandateId: approvalData.paymentHold.mandateId,
    });
    assert.ok(tx);
    assert.equal(tx.status, 'authorized');
    assert.equal(tx.authorizationId, approvalData.paymentHold.authorizationId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('one-time wallet linking stores distinct Vault ID and auto-resolves in mandate hold', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  // 1. Initial state: no wallet linked
  const initialWallet = await getWorkspaceWallet({ db, workspaceId: wsId });
  assert.equal(initialWallet, null);

  // 2. Generate setup token
  const setup = await createWalletSetupToken({
    workspaceId: wsId,
    userId,
    simulate: true,
  });
  assert.match(setup.setupTokenId, /^ST-SANDBOX-/);
  assert.match(setup.approveUrl, /sandbox\.paypal\.com/);

  // 3. Link distinct vault token to workspace
  const linked = await linkWorkspaceWallet({
    db,
    workspaceId: wsId,
    userId,
    setupTokenId: setup.setupTokenId,
    payerEmail: 'distinct-buyer@personal.example.com',
    simulate: true,
  });

  assert.equal(linked.status, 'active');
  assert.equal(linked.provider, 'paypal_sandbox');
  assert.equal(linked.payerEmail, 'distinct-buyer@personal.example.com');
  assert.match(linked.vaultTokenId, /^VAULT-SANDBOX-/);

  // 4. Check getWorkspaceWallet returns masked Vault ID
  const activeWallet = await getWorkspaceWallet({ db, workspaceId: wsId });
  assert.ok(activeWallet);
  assert.equal(activeWallet.payerEmail, 'distinct-buyer@personal.example.com');
  assert.match(activeWallet.maskedVaultId, /^\*\*\*\*/);

  // 5. Create and authorize mandate
  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Minimalist Walnut Desk Shelf',
      merchantDomain: 'grovemade.com',
      amountMinor: 12000,
      currency: 'USD',
      evidenceHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    },
  });

  await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  // 6. Create payment authorization hold without passing vaultId
  // It must automatically resolve from workspace's linked wallet!
  const tx = await createSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  assert.equal(tx.status, 'authorized');
  assert.equal(tx.vaultId, linked.vaultTokenId);

  // 7. Unlink wallet
  const unlinked = await unlinkWorkspaceWallet({ db, workspaceId: wsId, userId });
  assert.equal(unlinked.unlinked, true);

  const postUnlink = await getWorkspaceWallet({ db, workspaceId: wsId });
  assert.equal(postUnlink, null);
});

test('HTTP Wallet Routes: setup-token, link, get, and unlink work over REST', async () => {
  const { db, authService, workspaceService, session, wsId, userId } = await setupTestEnvironment();

  const config = loadServerConfig({
    TURSO_DATABASE_URL: 'file:./local.db',
  });

  const ctx = {
    db,
    authService,
    workspaceService,
  };

  await withServer(config, ctx, async (base) => {
    // 1. Initial GET wallet -> linked: false
    const initRes = await fetch(`${base}/api/commerce/paypal/wallet`, {
      headers: { Cookie: `kues_session=${session.sessionToken}` },
    });
    assert.equal(initRes.status, 200);
    const initData = await initRes.json();
    assert.equal(initData.linked, false);

    // 2. Request setup token
    const setupRes = await fetch(`${base}/api/commerce/paypal/wallet/setup-token`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ simulate: true }),
    });
    assert.equal(setupRes.status, 201);
    const setupData = await setupRes.json();
    assert.match(setupData.setupTokenId, /^ST-SANDBOX-/);

    // 3. Link wallet
    const linkRes = await fetch(`${base}/api/commerce/paypal/wallet/link`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        setupTokenId: setupData.setupTokenId,
        payerEmail: 'api-buyer@personal.example.com',
        simulate: true,
      }),
    });
    assert.equal(linkRes.status, 200);
    const linkData = await linkRes.json();
    assert.equal(linkData.ok, true);
    assert.equal(linkData.wallet.payerEmail, 'api-buyer@personal.example.com');
    assert.match(linkData.wallet.vaultTokenId, /^VAULT-SANDBOX-/);

    // 4. GET wallet -> linked: true
    const activeRes = await fetch(`${base}/api/commerce/paypal/wallet`, {
      headers: { Cookie: `kues_session=${session.sessionToken}` },
    });
    assert.equal(activeRes.status, 200);
    const activeData = await activeRes.json();
    assert.equal(activeData.linked, true);
    assert.equal(activeData.wallet.payerEmail, 'api-buyer@personal.example.com');
    assert.match(activeData.wallet.maskedVaultId, /^\*\*\*\*/);

    // 5. Unlink wallet
    const unlinkRes = await fetch(`${base}/api/commerce/paypal/wallet/unlink`, {
      method: 'POST',
      headers: { Cookie: `kues_session=${session.sessionToken}` },
    });
    assert.equal(unlinkRes.status, 200);
    const unlinkData = await unlinkRes.json();
    assert.equal(unlinkData.unlinked, true);

    // 6. Final GET wallet -> linked: false
    const finalRes = await fetch(`${base}/api/commerce/paypal/wallet`, {
      headers: { Cookie: `kues_session=${session.sessionToken}` },
    });
    assert.equal(finalRes.status, 200);
    const finalData = await finalRes.json();
    assert.equal(finalData.linked, false);
  });
});

test('refundSandboxPaymentCapture refunds captured payment and updates receipts and audit events', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Studio Monitor Speakers',
      merchantDomain: 'soundgear.example.com',
      amountMinor: 8900,
      currency: 'USD',
      evidenceHash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
  });
  await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
    userId,
    note: 'Approved for studio setup',
  });

  // 1. Authorize hold
  const auth = await createSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
    simulate: true,
  });

  // 2. Reject refund when not captured yet
  await assert.rejects(
    refundSandboxPaymentCapture({
      db,
      workspaceId: wsId,
      mandateId: mandateResult.mandateId,
      simulate: true,
    }),
    /Only captured payments can be refunded/
  );

  // 3. Capture payment
  const cap = await captureSandboxPaymentAuthorization({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
    simulate: true,
  });
  assert.equal(cap.status, 'captured');

  // 4. Refund payment
  const refund = await refundSandboxPaymentCapture({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
    simulate: true,
    note: 'Customer return within Sandbox policy',
  });
  assert.equal(refund.status, 'refunded');
  assert.match(refund.refundId, /^REF-SANDBOX-/);

  // 5. Verify transaction status in db
  const tx = await getSandboxPaymentTransaction({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
  });
  assert.equal(tx.status, 'refunded');
});

test('HTTP Commerce Routes: /api/commerce/paypal/refund, /receipts/:id, and /skills/export work over REST', async () => {
  const env = await setupTestEnvironment();
  const { db, wsId, userId, agentId, session } = env;
  const config = loadServerConfig({
    TURSO_DATABASE_URL: 'file:./local.db',
  });

  await withServer(config, env, async (base) => {
    // 1. Setup authorized mandate
    const mandateResult = await createPurchaseMandate({
      db,
      workspaceId: wsId,
      userId,
      agentId,
      product: {
        title: 'Ergonomic Mouse',
        merchantDomain: 'ergodesk.example.com',
        amountMinor: 4999,
        currency: 'USD',
        evidenceHash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      },
    });
    await authorizePurchaseMandate({
      db,
      workspaceId: wsId,
      mandateId: mandateResult.mandateId,
      userId,
      note: 'Authorized for desk ergonomics',
    });

    // 2. Authorize
    const authRes = await fetch(`${base}/api/commerce/paypal/authorize`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mandateId: mandateResult.mandateId,
        simulate: true,
      }),
    });
    assert.equal(authRes.status, 201);

    // 3. Capture
    const capRes = await fetch(`${base}/api/commerce/paypal/capture`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mandateId: mandateResult.mandateId,
        simulate: true,
      }),
    });
    assert.equal(capRes.status, 200);

    // 4. Refund over REST
    const refundRes = await fetch(`${base}/api/commerce/paypal/refund`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mandateId: mandateResult.mandateId,
        simulate: true,
        note: 'Rest mock refund test',
      }),
    });
    assert.equal(refundRes.status, 200);
    const refundData = await refundRes.json();
    assert.equal(refundData.ok, true);
    assert.equal(refundData.refund.status, 'refunded');

    // 5. Query receipt over REST
    const receiptRes = await fetch(`${base}/api/commerce/receipts/${mandateResult.mandateId}`, {
      headers: { Cookie: `kues_session=${session.sessionToken}` },
    });
    assert.equal(receiptRes.status, 200);
    const receiptData = await receiptRes.json();
    assert.equal(receiptData.ok, true);
    assert.equal(receiptData.receipt.status, 'refunded');
    assert.match(receiptData.receipt.receiptHash, /^sha256:/);

    // 6. Export SKILL.md over REST
    const skillRes = await fetch(`${base}/api/commerce/skills/export`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        skillName: 'Office Ergonomics Scout',
        description: 'Autonomously procure desk accessories up to $100 with passkey confirmation',
        maxPerOrderCents: 10000,
        allowedDomains: ['ergodesk.example.com', 'channel3.example.com'],
      }),
    });
    assert.equal(skillRes.status, 200);
    const skillData = await skillRes.json();
    assert.equal(skillData.ok, true);
    assert.ok(skillData.skill.markdown.includes('office-ergonomics-scout'));
    assert.ok(skillData.skill.markdown.includes('desk accessories'));
    assert.ok(skillData.skill.policyHash.length === 64);
  });
});
