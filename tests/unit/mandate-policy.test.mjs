import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import {
  evaluateSpendPolicy,
  createPurchaseMandate,
  authorizePurchaseMandate,
  getMandateDetails,
  computeMandateChallenge,
  MandatePolicyError,
} from '../../apps/web/lib/channel3/mandate-service.mjs';
import { discoverProducts } from '../../apps/web/lib/channel3/discovery.mjs';
import { createChannel3Client } from '../../apps/web/lib/channel3/client.mjs';

async function setupTestDatabase() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);

  const wsId = 'ws_mandate_test';
  const userId = 'usr_mandate_test';
  const agentId = 'ag_commerce_agent';

  await db.execute({
    sql: 'INSERT INTO users (id, email_normalized, status) VALUES (?, ?, ?)',
    args: [userId, 'buyer@example.test', 'active'],
  });
  await db.execute({
    sql: 'INSERT INTO workspaces (id, owner_user_id, name, status) VALUES (?, ?, ?, ?)',
    args: [wsId, userId, 'Commerce Workspace', 'active'],
  });
  await db.execute({
    sql: `INSERT INTO agents (workspace_id, id, name, role, avatar, status, settings_json)
          VALUES (?, ?, 'Buyer Agent', 'Procurement scout', 'cart', 'active', ?)`,
    args: [wsId, agentId, JSON.stringify({ color: '#4c8dff', approvalPath: 'desktop', orderCap: 50, dailyCap: 200 })],
  });

  return { db, wsId, userId, agentId };
}

test('evaluateSpendPolicy initializes policy from agent settings and approves valid order', async () => {
  const { db, wsId, agentId } = await setupTestDatabase();

  const result = await evaluateSpendPolicy({
    db,
    workspaceId: wsId,
    agentId,
    amountMinor: 3500, // $35.00 (under $50 orderCap)
    merchantDomain: 'keychron.example.com',
  });

  assert.equal(result.allowed, true);
  assert.equal(result.decisionCode, 'approved');
  assert.equal(result.maxPerOrderMinor, 5000);
  assert.equal(result.dailyBudgetMinor, 20000);
  assert.equal(result.remainingDailyMinor, 20000);
  assert.match(result.policyHash, /^sha256:[a-f0-9]{64}$/);
});

test('evaluateSpendPolicy blocks orders exceeding orderCap', async () => {
  const { db, wsId, agentId } = await setupTestDatabase();

  const result = await evaluateSpendPolicy({
    db,
    workspaceId: wsId,
    agentId,
    amountMinor: 7500, // $75.00 (exceeds $50 orderCap)
    merchantDomain: 'keychron.example.com',
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decisionCode, 'order_cap_exceeded');
  assert.match(result.failureReason, /exceeds agent per-order cap/);
});

test('createPurchaseMandate blocks order and records policy decision when order exceeds limit', async () => {
  const { db, wsId, userId, agentId } = await setupTestDatabase();

  const result = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Ultra High-End Monitor',
      merchantDomain: 'screens.example.com',
      merchantName: 'Screens Pro',
      amountMinor: 89900, // $899 (exceeds $50 cap)
      currency: 'USD',
      evidenceHash: 'sha256:11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decisionCode, 'order_cap_exceeded');
  assert.ok(result.policyDecisionId);

  // Verify denied policy decision recorded in DB
  const decisionRow = await db.execute({
    sql: 'SELECT * FROM policy_decisions WHERE id = ?',
    args: [result.policyDecisionId],
  });
  assert.equal(decisionRow.rows[0].allowed, 0);
  assert.equal(decisionRow.rows[0].decision_code, 'order_cap_exceeded');

  // Verify no mandate was inserted
  const mandateCount = await db.execute({
    sql: 'SELECT COUNT(*) AS count FROM mandates WHERE workspace_id = ?',
    args: [wsId],
  });
  assert.equal(Number(mandateCount.rows[0].count), 0);
});

test('createPurchaseMandate generates cryptographically bound mandate and awaiting_approval status', async () => {
  const { db, wsId, userId, agentId } = await setupTestDatabase();

  const product = {
    title: 'Ergonomic Desk Mat',
    merchantDomain: 'gear.example.com',
    merchantName: 'Gear Store',
    amountMinor: 2800, // $28.00 (under $50 cap)
    currency: 'USD',
    evidenceHash: 'sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
  };

  const result = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product,
  });

  assert.equal(result.allowed, true);
  assert.match(result.mandateId, /^man_[a-f0-9]{32}$/);
  assert.match(result.approvalId, /^mapp_[a-f0-9]{32}$/);
  assert.match(result.challengeHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(result.nonce);

  // Check mandate row
  const mandateRow = await db.execute({
    sql: 'SELECT * FROM mandates WHERE id = ?',
    args: [result.mandateId],
  });
  assert.equal(mandateRow.rows[0].status, 'awaiting_approval');
  assert.equal(mandateRow.rows[0].amount_minor, 2800);
  assert.equal(mandateRow.rows[0].merchant_domain, 'gear.example.com');
  assert.equal(mandateRow.rows[0].evidence_hash, product.evidenceHash);

  // Check mandate approval ceremony row
  const approvalRow = await db.execute({
    sql: 'SELECT * FROM mandate_approvals WHERE id = ?',
    args: [result.approvalId],
  });
  assert.equal(approvalRow.rows[0].status, 'pending');
  assert.equal(approvalRow.rows[0].challenge_hash, result.challengeHash);

  // Check run event
  const eventRows = await db.execute({
    sql: "SELECT * FROM run_events WHERE event_type = 'mandate_proposed'",
  });
  assert.equal(eventRows.rows.length, 1);
});

test('authorizePurchaseMandate successfully authorizes pending mandate and prevents replay', async () => {
  const { db, wsId, userId, agentId } = await setupTestDatabase();

  const result = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Wireless Trackball Mouse',
      merchantDomain: 'keyboards.example.com',
      merchantName: 'Keyboards Co',
      amountMinor: 4500, // $45.00
      currency: 'USD',
      evidenceHash: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    },
  });

  // Authorize the mandate
  const authResult = await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: result.mandateId,
    decision: 'approve',
  });

  assert.equal(authResult.status, 'authorized');
  assert.equal(authResult.decision, 'approve');
  assert.ok(authResult.authorizedAt);

  // Verify mandate and approval status updated in DB
  const details = await getMandateDetails({ db, workspaceId: wsId, mandateId: result.mandateId });
  assert.equal(details.status, 'authorized');
  assert.equal(details.approval_status, 'verified');
  assert.ok(details.verified_at);

  // Replaying authorization must fail with conflict (409)
  await assert.rejects(
    async () => authorizePurchaseMandate({
      db,
      workspaceId: wsId,
      userId,
      mandateId: result.mandateId,
      decision: 'approve',
    }),
    (err) => {
      assert(err instanceof MandatePolicyError);
      assert.equal(err.code, 'mandate_already_processed');
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('authorizePurchaseMandate marks expired mandate as expired and rejects authorization', async () => {
  const { db, wsId, userId, agentId } = await setupTestDatabase();
  const startTime = Date.now();

  const result = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Coffee Beans 1kg',
      merchantDomain: 'roasters.example.com',
      merchantName: 'City Roasters',
      amountMinor: 2200,
      currency: 'USD',
      evidenceHash: 'sha256:0011223344556677889900112233445566778899001122334455667788990011',
    },
    now: startTime,
    ttlMs: 60 * 1000, // 1 minute TTL
  });

  // Attempt authorization 5 minutes later
  await assert.rejects(
    async () => authorizePurchaseMandate({
      db,
      workspaceId: wsId,
      userId,
      mandateId: result.mandateId,
      decision: 'approve',
      now: startTime + (5 * 60 * 1000),
    }),
    (err) => {
      assert(err instanceof MandatePolicyError);
      assert.equal(err.code, 'mandate_expired');
      assert.equal(err.status, 410);
      return true;
    }
  );

  const mandateRow = await db.execute({
    sql: 'SELECT status FROM mandates WHERE id = ?',
    args: [result.mandateId],
  });
  assert.equal(mandateRow.rows[0].status, 'expired');
});

test('createPurchaseMandate resolves offer by offerId discovered in product_offers', async () => {
  const { db, wsId, userId, agentId } = await setupTestDatabase();
  const client = createChannel3Client({ apiKey: '' });

  // 1. Run discovery to populate product_offers
  const discoveryResult = await discoverProducts({
    channel3Client: client,
    query: 'linen apron',
    db,
    workspaceId: wsId,
    userId,
    agentId,
    allowFixtureFallback: true,
  });

  const discoveredOffers = await db.execute({
    sql: 'SELECT * FROM product_offers WHERE run_id = ?',
    args: [discoveryResult.runId],
  });
  assert.ok(discoveredOffers.rows.length > 0);
  const targetOffer = discoveredOffers.rows[0];

  // 2. Propose mandate by referencing offerId
  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    offerId: targetOffer.id,
  });

  // Since sample apron amount is $48.00 (4800 minor), and cap is $50.00 (5000 minor), it is allowed
  assert.equal(mandateResult.allowed, true);
  assert.equal(mandateResult.product.merchantDomain, targetOffer.merchant_domain);
  assert.equal(mandateResult.product.amountMinor, targetOffer.amount_minor);
  assert.equal(mandateResult.product.evidenceHash, targetOffer.evidence_hash);
});

import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import { createServer } from '../../apps/web/server.mjs';
import { createAuthService } from '../../apps/web/lib/auth/service.mjs';
import { createWorkspaceService } from '../../apps/web/lib/workspaces/service.mjs';

async function withServer(config, context, run) {
  const server = createServer({
    config,
    authService: context.authService,
    workspaceService: context.workspaceService,
    aiChatService: context.aiChatService,
    aiChatHistoryService: context.aiChatHistoryService,
    aiProviderService: context.aiProviderService,
    usageService: context.usageService,
    db: context.db,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('agent chat flow: purchase_product tool creates pending mandate proposal and user approval authorizes mandate', async () => {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);

  const authService = createAuthService({ db });
  const workspaceService = createWorkspaceService({ db });

  const session = await authService.createWorkOSSession({
    providerSubject: 'sub_test_buyer_mandate',
    email: 'buyer@example.test',
    emailVerified: true,
    displayName: 'Buyer',
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
        orderCap: 100,
        dailyCap: 500,
        apps: ['channel3'],
        memoryPills: [],
      },
    });
    agentId = created.createdAgentId || created.agents?.[0]?.id;
  }

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
      providerKey: 'mock',
      providerDisplayName: 'Mock Provider',
      modelId: 'mock-model',
    }),
    listProviders: async () => [],
  };

  const productEvidence = {
    title: 'Custom Mechanical Keyboard',
    merchantDomain: 'customkeys.example.com',
    amountMinor: 8500, // $85.00
    currency: 'USD',
    evidenceHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

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

  const config = loadServerConfig({
    AI_PROVIDER_CHAT_TEST_ENABLED: '1',
    AI_PROVIDER_ADMIN_EMAILS: 'buyer@example.test',
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

  await withServer(config, ctx, async (base) => {
    // 1. Send chat message that triggers purchase_product tool
    const chatRes = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId,
        message: 'Please purchase the custom mechanical keyboard',
      }),
    });

    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.ok(chatData.pendingAction);
    assert.equal(chatData.pendingAction.action.title, 'Review purchase quantities');
    assert.match(chatData.reply, /prepared a purchase review/);

    const actionId = chatData.pendingAction.actionId;
    assert.ok(actionId);

    // 2. User approves the proposed purchase mandate
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
    assert.match(approvalData.message, /Reviewed purchase/);
    assert.match(approvalData.message, /\$85\.00 USD/);

    // 3. Verify in database that mandate is now authorized and verified
    const mandateRows = await db.execute({
      sql: 'SELECT * FROM mandates WHERE merchant_domain = ?',
      args: [productEvidence.merchantDomain],
    });
    assert.equal(mandateRows.rows.length, 1);
    assert.equal(mandateRows.rows[0].status, 'authorized');

    const mandateId = mandateRows.rows[0].id;

    // 4. Query /api/commerce/mandates/:mandateId route
    const mandateDetailRes = await fetch(`${base}/api/commerce/mandates/${mandateId}`, {
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
      },
    });
    assert.equal(mandateDetailRes.status, 200);
    const detailData = await mandateDetailRes.json();
    assert.equal(detailData.ok, true);
    assert.equal(detailData.mandate.id, mandateId);
    assert.equal(detailData.mandate.status, 'authorized');
    assert.equal(detailData.mandate.approval_status, 'verified');

    // 5. Query /api/commerce/evaluate route for policy limits
    const evalRes = await fetch(`${base}/api/commerce/evaluate`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId,
        amountMinor: 2500,
        merchantDomain: 'gadgets.example.com',
      }),
    });
    assert.equal(evalRes.status, 200);
    const evalData = await evalRes.json();
    assert.equal(evalData.ok, true);
    assert.equal(evalData.evaluation.allowed, true);
    assert.equal(evalData.evaluation.decisionCode, 'approved');
  });
});

test('multi-product bundles evaluate aggregate spend caps and formulate consolidated mandates', async () => {
  const { db, wsId, userId, agentId } = await setupTestDatabase();

  const bundleItems = [
    {
      title: 'Precision Wrist Rest',
      merchantName: 'Grovemade',
      merchantDomain: 'grovemade.com',
      amountMinor: 1800, // $18.00
      currency: 'USD',
      evidenceHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    },
    {
      title: 'Hardcover Linen Notebook',
      merchantName: 'Nordic',
      merchantDomain: 'nordic.example.com',
      amountMinor: 2200, // $22.00
      currency: 'USD',
      evidenceHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    },
  ];

  // 1. Bundle within cap: $18 + $22 = $40 (<= $50 cap) -> Approved
  const bundleResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    items: bundleItems,
  });

  assert.equal(bundleResult.allowed, true);
  assert.equal(bundleResult.isBundle, true);
  assert.equal(bundleResult.product.amountMinor, 4000); // $40.00
  assert.equal(bundleResult.items.length, 2);
  assert.match(bundleResult.product.title, /Bundle \(2 items\)/);
  assert.match(bundleResult.product.evidenceHash, /^sha256:[a-f0-9]{64}$/);

  // 2. Authorize bundle mandate
  const authResult = await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: bundleResult.mandateId,
    challengeHash: bundleResult.challengeHash,
  });
  assert.equal(authResult.status, 'authorized');
  assert.equal(authResult.amountMinor, 4000);

  // 3. Bundle exceeding cap: $18 + $22 + $25 = $65 (> $50 cap) -> Blocked
  const excessiveBundle = [
    ...bundleItems,
    {
      title: 'Desk Mat',
      merchantName: 'Grovemade',
      merchantDomain: 'grovemade.com',
      amountMinor: 2500, // $25.00 -> total $65
      currency: 'USD',
      evidenceHash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    },
  ];

  const blockedBundle = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    items: excessiveBundle,
  });

  assert.equal(blockedBundle.allowed, false);
  assert.equal(blockedBundle.decisionCode, 'order_cap_exceeded');
  assert.match(blockedBundle.failureReason, /exceeds agent per-order cap/);
  assert.equal(blockedBundle.product.amountMinor, 6500);
});

test('POST /api/commerce/mandates creates multi-product bundle mandate over HTTP', async () => {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);

  const authService = createAuthService({ db });
  const workspaceService = createWorkspaceService({ db });

  const session = await authService.createWorkOSSession({
    providerSubject: 'sub_test_buyer_bundle',
    email: 'bundlebuyer@example.test',
    emailVerified: true,
    displayName: 'Bundle Buyer',
  });

  const bootstrap = await workspaceService.getBootstrap({ userId: session.user.id });
  let agentId = bootstrap.agents[0]?.id;
  if (!agentId) {
    const created = await workspaceService.createAgent({
      userId: session.user.id,
      input: {
        name: 'Bundle Scout',
        role: 'Autonomous buyer',
        avatar: 'cart',
        color: '#4c8dff',
        approvalPath: 'desktop',
        orderCap: 100,
        dailyCap: 500,
        apps: ['channel3'],
        memoryPills: [],
      },
    });
    agentId = created.createdAgentId || created.agents?.[0]?.id;
  }

  const config = loadServerConfig({
    TURSO_DATABASE_URL: 'file:./local.db',
  });

  const ctx = {
    db,
    authService,
    workspaceService,
  };

  await withServer(config, ctx, async (base) => {
    const res = await fetch(`${base}/api/commerce/mandates`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId,
        items: [
          {
            title: 'Wireless Trackball Mouse',
            merchantDomain: 'logitech.com',
            amountMinor: 3000,
            currency: 'USD',
            evidenceHash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
          },
          {
            title: 'Felt Desk Mat',
            merchantDomain: 'grovemade.com',
            amountMinor: 1500,
            currency: 'USD',
            evidenceHash: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
          },
        ],
      }),
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.mandate.isBundle, true);
    assert.equal(data.mandate.product.amountMinor, 4500);
    assert.match(data.mandate.mandateId, /^man_[a-f0-9]{32}$/);
  });
});

test('quantity inputs must be integers 1–20, default to one, and malformed lines are not skipped',async()=>{const {db,wsId,userId,agentId}=await setupTestDatabase();const product={title:'Notebook',merchantDomain:'shop.example',amountMinor:100,currency:'USD',evidenceHash:'sha256:'+'a'.repeat(64)};for(const quantity of [0,-1,1.5,21,null,'2',true,Number.MAX_SAFE_INTEGER])await assert.rejects(createPurchaseMandate({db,workspaceId:wsId,userId,agentId,product:{...product,quantity}}),/quantity/);for(const items of [[],[null],[{}],Array(11).fill(product)])await assert.rejects(createPurchaseMandate({db,workspaceId:wsId,userId,agentId,items}));const m=await createPurchaseMandate({db,workspaceId:wsId,userId,agentId,product});assert.equal(m.items[0].quantity,1);const max=await createPurchaseMandate({db,workspaceId:wsId,userId,agentId,product:{...product,quantity:20}});assert.equal(max.product.amountMinor,2000);});
test('bundle quantities calculate each line in cents and retain an immutable priced breakdown',async()=>{const {db,wsId,userId,agentId}=await setupTestDatabase();const base={merchantDomain:'shop.example',currency:'USD',evidenceHash:'sha256:'+'b'.repeat(64)};const m=await createPurchaseMandate({db,workspaceId:wsId,userId,agentId,items:[{...base,title:'Pen',amountMinor:150,quantity:2},{...base,title:'Notebook',amountMinor:275,quantity:3}]});assert.equal(m.allowed,true);assert.equal(m.product.amountMinor,1125);assert.deepEqual(m.items.map(i=>[i.quantity,i.unitAmountMinor,i.lineTotalMinor]),[[2,150,300],[3,275,825]]);const lines=await db.execute({sql:'SELECT quantity,unit_amount_minor,line_total_minor FROM mandate_purchase_items WHERE mandate_id=? ORDER BY line_number',args:[m.mandateId]});assert.equal(lines.rows.length,2);assert.equal(lines.rows[1].line_total_minor,825);});
test('quantity total, not unit price, is checked against order and daily caps',async()=>{const {db,wsId,userId,agentId}=await setupTestDatabase();const product={title:'Lamp',merchantDomain:'shop.example',amountMinor:2000,currency:'USD',evidenceHash:'sha256:'+'c'.repeat(64)};const m=await createPurchaseMandate({db,workspaceId:wsId,userId,agentId,product:{...product,quantity:3}});assert.equal(m.allowed,false);assert.equal(m.decisionCode,'order_cap_exceeded');await db.execute({sql:'UPDATE spend_policies SET daily_budget_minor=5000 WHERE workspace_id=?',args:[wsId]});const first=await createPurchaseMandate({db,workspaceId:wsId,userId,agentId,product:{...product,quantity:2}});assert.equal(first.allowed,true);const second=await createPurchaseMandate({db,workspaceId:wsId,userId,agentId,product});assert.equal(second.allowed,false);assert.equal(second.decisionCode,'daily_cap_exceeded');});
test('duplicate offers and overflowing prices are rejected rather than silently merging quantities',async()=>{const {db,wsId,userId,agentId}=await setupTestDatabase();await assert.rejects(createPurchaseMandate({db,workspaceId:wsId,userId,agentId,items:[{offerId:'same',quantity:1},{offerId:'same',quantity:2}]}),/duplicate/);await assert.rejects(createPurchaseMandate({db,workspaceId:wsId,userId,agentId,product:{title:'Huge',merchantDomain:'shop.example',amountMinor:100000000,quantity:20,currency:'USD',evidenceHash:'x'}}),/amount_invalid/);});

test('offer quantities use the stored unit price without rewriting it and reject another agent',async()=>{const {db,wsId,userId,agentId}=await setupTestDatabase();const discovery=await discoverProducts({channel3Client:createChannel3Client({apiKey:''}),query:'notebook',db,workspaceId:wsId,userId,agentId,allowFixtureFallback:true});const row=(await db.execute({sql:'SELECT * FROM product_offers WHERE run_id=? LIMIT 1',args:[discovery.runId]})).rows[0];await db.execute({sql:'UPDATE product_offers SET amount_minor=333 WHERE id=?',args:[row.id]});const result=await createPurchaseMandate({db,workspaceId:wsId,userId,agentId,offerId:row.id,quantity:3});assert.equal(result.product.amountMinor,999);assert.equal(result.items[0].unitAmountMinor,333);assert.equal((await db.execute({sql:'SELECT amount_minor FROM product_offers WHERE id=?',args:[row.id]})).rows[0].amount_minor,333);await assert.rejects(createPurchaseMandate({db,workspaceId:wsId,userId,agentId:'other',offerId:row.id,quantity:2}),/not found/);});


test('merchant allowlist uses DNS label boundaries and checks every bundle item',async()=>{
 const {db,wsId,userId,agentId}=await setupTestDatabase();const base={db,workspaceId:wsId,agentId,amountMinor:1000};await evaluateSpendPolicy({...base,merchantDomain:'shop.example'});
 await db.execute({sql:'UPDATE spend_policies SET allowed_domains_json=? WHERE workspace_id=? AND agent_id=?',args:[JSON.stringify(['shop.example']),wsId,agentId]});
 for(const domain of ['shop.example','SHOP.EXAMPLE','store.shop.example'])assert.equal((await evaluateSpendPolicy({...base,merchantDomain:domain})).allowed,true,domain);
 for(const domain of ['shop.example.evil.test','notshop.example','shop-example','evil.test']){const r=await evaluateSpendPolicy({...base,merchantDomain:domain});assert.equal(r.allowed,false,domain);assert.equal(r.decisionCode,'merchant_domain_blocked');}
 const common={title:'Fixture',amountMinor:100,currency:'USD',evidenceHash:'sha256:'+'a'.repeat(64)};const result=await createPurchaseMandate({db,workspaceId:wsId,userId,agentId,items:[{...common,merchantDomain:'shop.example'},{...common,merchantDomain:'shop.example.evil.test'}]});assert.equal(result.allowed,false);assert.equal(result.decisionCode,'merchant_domain_blocked');
});
