import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAuthService } from '../../apps/web/lib/auth/service.mjs';
import { createWorkspaceService } from '../../apps/web/lib/workspaces/service.mjs';
import {
  createPurchaseMandate,
  authorizePurchaseMandate,
} from '../../apps/web/lib/channel3/mandate-service.mjs';
import {
  evaluateCheckoutRail,
  executeCheckoutMandate,
  voidCheckoutMandate,
  getCheckoutExecution,
} from '../../apps/web/lib/commerce/checkout-engine.mjs';
import { linkWorkspaceWallet } from '../../apps/web/lib/paypal/service.mjs';
import { createAgentRun } from '../../apps/web/lib/channel3/discovery.mjs';

async function setupTestEnvironment() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);

  const authService = createAuthService({ db });
  const workspaceService = createWorkspaceService({ db });

  const session = await authService.createWorkOSSession({
    providerSubject: 'sub_test_checkout_brain',
    email: 'agent-brain-tester@example.com',
    emailVerified: true,
    displayName: 'Brain Tester',
  });

  const bootstrap = await workspaceService.getBootstrap({ userId: session.user.id });
  const wsId = bootstrap.workspace.id;
  const userId = session.user.id;
  let agentId = bootstrap.agents[0]?.id;
  if (!agentId) {
    const created = await workspaceService.createAgent({
      userId,
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

  // Pre-link sandbox wallet for zero-login authorization
  await linkWorkspaceWallet({
    db,
    workspaceId: wsId,
    userId,
    setupTokenId: 'ST-SANDBOX-TEST-BRAIN-TOKEN',
    payerEmail: 'sandbox-buyer-brain@personal.example.com',
    simulate: true,
  });

  return { db, authService, workspaceService, session, wsId, userId, agentId };
}

test('evaluateCheckoutRail: Agent brain autonomously routes tiers based on retailer compatibility', () => {
  // Case A: Card-centric web retailer like Target -> Tier 3 Card Bridge
  const targetEval = evaluateCheckoutRail({
    merchantDomain: 'target.com',
    amountMinor: 7909,
    currency: 'USD',
  });
  assert.equal(targetEval.selectedRail, 'card_bridge');
  assert.match(targetEval.reasoning, /Tier 3|single-use virtual card/i);
  assert.match(targetEval.reasoning, /PayPal Sandbox authorization hold/i);

  // Case B: Discovered item with Channel3 Offer ID -> Tier 2 Channel3 UCP Direct API
  const ucpEval = evaluateCheckoutRail({
    merchantDomain: 'target.com',
    offerId: 'off_81b2159e39e54d89af93d85419cf3289',
    amountMinor: 7909,
    currency: 'USD',
  });
  assert.equal(ucpEval.selectedRail, 'channel3_ucp');
  assert.match(ucpEval.reasoning, /Channel3 Universal Commerce Protocol/i);

  // Case C: Shopify / PayPal native merchant -> Tier 1 PayPal Native Commerce Vault
  const shopifyEval = evaluateCheckoutRail({
    merchantDomain: 'studiokera.myshopify.com',
    amountMinor: 4500,
    currency: 'USD',
  });
  assert.equal(shopifyEval.selectedRail, 'paypal_native');
  assert.match(shopifyEval.reasoning, /PayPal Commerce Platform/i);

  // Case D: Explicit override respected
  const overrideEval = evaluateCheckoutRail({
    merchantDomain: 'target.com',
    preferredRail: 'paypal_native',
  });
  assert.equal(overrideEval.selectedRail, 'paypal_native');
});

test('Tier 3: Single-Use Virtual Card Bridge is funded 1:1 by active PayPal Authorization Hold', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  // Create & authorize mandate for Target shelf
  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Baxton Studio Fariat Walnut Wood Shelf',
      merchantDomain: 'target.com',
      amountMinor: 7909, // $79.09
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

  // Execute checkout with autonomous brain
  const execution = await executeCheckoutMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  assert.equal(execution.status, 'authorized');
  assert.equal(execution.selectedRail, 'card_bridge');
  assert.match(execution.paypalAuthorizationId, /^AUTH-SANDBOX-/);
  assert.equal(execution.amountMinor, 7909);
  assert.equal(execution.currency, 'USD');

  // Verify Virtual Card Bridge details
  const card = execution.railDetails;
  assert.ok(card.cardToken.startsWith('vcard_'));
  assert.equal(card.brand, 'Visa Virtual Bridge (PayPal-Backed)');
  assert.match(card.maskedPan, /^\*\*\*\* \*\*\*\* \*\*\*\* \d{4}$/);
  assert.equal(card.lockedMerchantDomain, 'target.com');
  assert.equal(card.spendCapMinor, 7909);
  assert.equal(card.paypalAuthorizationId, execution.paypalAuthorizationId);
  assert.equal(card.status, 'active');

  // Verify persistence in agent_checkout_executions
  const persisted = await getCheckoutExecution({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
  });
  assert.ok(persisted);
  assert.equal(persisted.selectedRail, 'card_bridge');
  assert.equal(persisted.paypalAuthorizationId, execution.paypalAuthorizationId);
  assert.equal(persisted.railDetails.cardToken, card.cardToken);

  // Void execution: releases PayPal hold and burns virtual card
  const voidResult = await voidCheckoutMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
    reason: 'Reviewer voided test card order',
  });

  assert.equal(voidResult.status, 'voided');
  assert.equal(voidResult.paypalVoid.status, 'voided');
  assert.equal(voidResult.railDetails.status, 'burned');

  const afterVoid = await getCheckoutExecution({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
  });
  assert.equal(afterVoid.status, 'voided');
  assert.equal(afterVoid.railDetails.status, 'burned');
});

test('Tier 2: Channel3 UCP Direct Partner Order is backed by PayPal Authorization Hold', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  // Seed a scoped saved offer; callers select it by top-level offerId so the
  // server, not client-provided product fields, determines price and merchant.
  const { runId } = await createAgentRun({db, workspaceId:wsId, userId, agentId, goal:'Synthetic saved offer for rail fixture'});
  const timestamp = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO product_offers (id, workspace_id, run_id, source, source_listing_id, source_url,
      merchant_name, merchant_domain, title, amount_minor, currency, availability, evidence_hash, observed_at, created_at, evidence_ref)
      VALUES (?, ?, ?, 'channel3', ?, '', ?, ?, ?, ?, 'USD', 'in_stock', ?, ?, ?, ?)`,
    args: ['off_81b2159e39e54d89af93d85419cf3289',wsId,runId,'off_81b2159e39e54d89af93d85419cf3289','Studio Kera',
      'studiokera.example.com','Ceramic Tabletop Bundle',7850,'sha256:'+'b'.repeat(64),timestamp,timestamp,JSON.stringify({keusCurrencyEvidence:1,explicit:true,currency:'USD'})],
  });
  const mandateResult = await createPurchaseMandate({
    db, workspaceId:wsId, userId, agentId, offerId:'off_81b2159e39e54d89af93d85419cf3289',
  });

  await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  const execution = await executeCheckoutMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  assert.equal(execution.status, 'authorized');
  assert.equal(execution.selectedRail, 'channel3_ucp');
  assert.match(execution.railExecutionId, /^ucp_ord_/);
  assert.equal(execution.railDetails.offerId, 'off_81b2159e39e54d89af93d85419cf3289');
  assert.equal(execution.railDetails.status, 'placed');
  assert.match(execution.paypalAuthorizationId, /^AUTH-SANDBOX-/);

  // Void cancels UCP order and releases PayPal hold
  const voidResult = await voidCheckoutMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });
  assert.equal(voidResult.status, 'voided');
  assert.equal(voidResult.railDetails.status, 'cancelled');
});

test('Tier 1: PayPal Native Vault Order uses direct PayPal Vault authorization', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Handmade Wool Beanie',
      merchantDomain: 'nordicknitwear.myshopify.com',
      amountMinor: 3600,
      currency: 'USD',
      evidenceHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    },
  });

  await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  const execution = await executeCheckoutMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  assert.equal(execution.status, 'authorized');
  assert.equal(execution.selectedRail, 'paypal_native');
  assert.match(execution.paypalAuthorizationId, /^AUTH-SANDBOX-/);
  assert.match(execution.railExecutionId, /^ORD-SANDBOX-/);
});

test('Full Multi-Tier Lifecycle: Mandate evaluation, Autonomous Execution, Query, and Safe Void', async () => {
  const { db, wsId, userId, agentId } = await setupTestEnvironment();

  // 1. Propose purchase mandate
  const mandateResult = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Modern Ergonomic Office Chair',
      merchantDomain: 'wayfair.com',
      amountMinor: 12999,
      currency: 'USD',
      evidenceHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    },
  });

  assert.equal(mandateResult.allowed, true);
  assert.ok(mandateResult.mandateId);

  // 2. Autonomous evaluation
  const railEval = evaluateCheckoutRail({
    merchantDomain: mandateResult.product.merchantDomain,
    amountMinor: mandateResult.product.amountMinor,
    currency: mandateResult.product.currency,
  });
  assert.equal(railEval.selectedRail, 'card_bridge');

  // 3. User authorizes mandate
  await authorizePurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });

  // 4. Autonomous engine executes mandate
  const execution = await executeCheckoutMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
  });
  assert.equal(execution.status, 'authorized');
  assert.equal(execution.selectedRail, 'card_bridge');
  assert.match(execution.paypalAuthorizationId, /^AUTH-SANDBOX-/);
  assert.ok(execution.railDetails.cardToken);

  // 5. Query execution details via getCheckoutExecution
  const queried = await getCheckoutExecution({
    db,
    workspaceId: wsId,
    mandateId: mandateResult.mandateId,
  });
  assert.ok(queried);
  assert.equal(queried.selectedRail, 'card_bridge');
  assert.equal(queried.status, 'authorized');
  assert.equal(queried.railDetails.cardToken, execution.railDetails.cardToken);

  // 6. Safe void releases PayPal hold and burns card bridge
  const voided = await voidCheckoutMandate({
    db,
    workspaceId: wsId,
    userId,
    mandateId: mandateResult.mandateId,
    reason: 'User cancelled order in preview',
  });
  assert.equal(voided.status, 'voided');
  assert.equal(voided.railDetails.status, 'burned');
});

