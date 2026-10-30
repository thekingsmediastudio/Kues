import crypto from 'node:crypto';
import { withWriteTransaction, withReadTransaction } from '../db/transaction.mjs';
import {
  createSandboxPaymentAuthorization,
  voidSandboxPaymentAuthorization,
  getSandboxPaymentTransaction,
  PayPalSandboxError,
} from '../paypal/service.mjs';
import { mintCardBridgeProxy, burnCardBridgeProxy } from './card-bridge.mjs';
import { createChannel3UcpOrder, cancelChannel3UcpOrder } from '../channel3/checkout.mjs';

const KNOWN_PAYPAL_NATIVE_DOMAINS = new Set([
  'shopify.com',
  'studiokera.example.com',
  'paypal.com',
  'kues.test',
  'studiokera.com',
]);

function isPayPalNativeDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const lower = domain.toLowerCase().trim();
  if (KNOWN_PAYPAL_NATIVE_DOMAINS.has(lower)) return true;
  return lower.endsWith('.myshopify.com');
}

/**
 * Autonomous Checkout Brain: Evaluates product offer, merchant domain,
 * and rails to select the optimal checkout tier.
 */
export function evaluateCheckoutRail({
  merchantDomain,
  offerId = null,
  amountMinor = 0,
  currency = 'USD',
  preferredRail = null,
} = {}) {
  const cleanDomain = String(merchantDomain || 'unknown.example').toLowerCase().trim();
  const cleanOfferId = offerId ? String(offerId).trim() : null;

  if (preferredRail && ['paypal_native', 'channel3_ucp', 'card_bridge'].includes(preferredRail)) {
    let reasoning = `Autonomous agent used explicit override rail: ${preferredRail}.`;
    if (preferredRail === 'card_bridge') {
      reasoning = `Merchant ${cleanDomain} routed via Tier 3 Virtual Card Bridge (backed 1:1 by PayPal Sandbox hold).`;
    } else if (preferredRail === 'channel3_ucp') {
      reasoning = `Offer routed via Tier 2 Channel3 Universal Commerce Protocol (UCP direct partner checkout).`;
    } else if (preferredRail === 'paypal_native') {
      reasoning = `Merchant ${cleanDomain} routed via Tier 1 PayPal Native Commerce Vault.`;
    }
    return { selectedRail: preferredRail, reasoning };
  }

  // Tier 2: Channel3 UCP Direct API Checkout
  if (cleanOfferId && (cleanOfferId.startsWith('off_') || cleanOfferId.startsWith('c3_'))) {
    return {
      selectedRail: 'channel3_ucp',
      reasoning: `Discovered offer ${cleanOfferId} supports Channel3 Universal Commerce Protocol (UCP) direct partner checkout. Orchestrating direct server-to-server order with PayPal Sandbox settlement.`,
    };
  }

  // Tier 1: PayPal Web Native / Fastlane Vault
  if (isPayPalNativeDomain(cleanDomain)) {
    return {
      selectedRail: 'paypal_native',
      reasoning: `Merchant ${cleanDomain} supports direct PayPal Commerce Platform checkout. Authorizing directly using workspace PayPal Sandbox Vault token.`,
    };
  }

  // Tier 3: Universal Card Bridge (Funded JIT by PayPal Hold)
  const priceFormatted = `$${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  return {
    selectedRail: 'card_bridge',
    reasoning: `Merchant ${cleanDomain} requires web card checkout. Minting an ephemeral single-use virtual card locked strictly to ${cleanDomain} for ${priceFormatted}, funded 1:1 by PayPal Sandbox authorization hold.`,
  };
}

/**
 * Executes multi-tier checkout mandate.
 * In all tiers, PayPal authorization hold is placed first (conforming strictly to competition rules).
 */
export async function executeCheckoutMandate({
  db,
  workspaceId,
  userId,
  mandateId,
  preferredRail = null,
  channel3Client = null,
  now = Date.now(),
}) {
  if (!db) throw new Error('Database is required');
  if (!workspaceId) throw new Error('Workspace ID is required');
  if (!mandateId) throw new Error('Mandate ID is required');

  // 1. Fetch mandate
  const mandate = await withReadTransaction(db, async (tx) => {
    const res = await tx.execute({
      sql: `SELECT id, workspace_id, run_id, status, amount_minor, currency, merchant_domain
            FROM mandates
            WHERE workspace_id = ? AND id = ?`,
      args: [workspaceId, mandateId],
    });
    return res.rows[0] || null;
  });

  if (!mandate) {
    throw new Error(`Mandate ${mandateId} not found in workspace`);
  }

  // Fetch associated product offer if exists
  const offer = await withReadTransaction(db, async (tx) => {
    const res = await tx.execute({
      sql: `SELECT id, source_listing_id, source FROM product_offers WHERE workspace_id = ? AND run_id = ? LIMIT 1`,
      args: [workspaceId, mandate.run_id],
    });
    return res.rows[0] || null;
  });
  const offerId = offer?.source_listing_id || (offer?.source === 'channel3' ? offer?.id : null);

  // 2. Autonomous Brain selects rail
  const { selectedRail, reasoning } = evaluateCheckoutRail({
    merchantDomain: mandate.merchant_domain,
    offerId,
    amountMinor: mandate.amount_minor,
    currency: mandate.currency,
    preferredRail,
  });

  // 3. STEP A: 100% PayPal Core Engine - Place PayPal Sandbox Authorization Hold First
  const paypalHold = await createSandboxPaymentAuthorization({
    db,
    workspaceId,
    userId,
    mandateId,
  });

  // 4. STEP B: Execute the Autonomous Rail
  let railExecutionId = null;
  let railDetails = {};

  if (selectedRail === 'card_bridge') {
    railDetails = mintCardBridgeProxy({
      paypalHold,
      merchantDomain: mandate.merchant_domain,
      amountMinor: mandate.amount_minor,
      currency: mandate.currency,
      mandateId,
      now,
    });
    railExecutionId = railDetails.cardToken;
  } else if (selectedRail === 'channel3_ucp') {
    railDetails = await createChannel3UcpOrder({
      channel3Client,
      offerId: offerId || 'off_partner_channel3',
      merchantDomain: mandate.merchant_domain,
      amountMinor: mandate.amount_minor,
      currency: mandate.currency,
      paypalHold,
      now,
    });
    railExecutionId = railDetails.ucpOrderId;
  } else {
    // paypal_native
    railDetails = {
      provider: 'paypal_sandbox_native',
      vaultTokenId: paypalHold.vaultId,
      externalOrderId: paypalHold.externalOrderId,
      testPayeeEmail: paypalHold.testPayeeEmail,
      authorizedAt: new Date(now).toISOString(),
    };
    railExecutionId = paypalHold.externalOrderId;
  }

  const executionId = `chk_${crypto.randomUUID().replace(/-/g, '')}`;
  const timestamp = new Date(now).toISOString();

  // 5. STEP C: Persist execution record
  await withWriteTransaction(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO agent_checkout_executions (
              id, workspace_id, run_id, mandate_id, selected_rail, agent_reasoning,
              paypal_authorization_id, merchant_domain, amount_minor, currency,
              rail_execution_id, rail_details_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?)
            ON CONFLICT(mandate_id) DO UPDATE SET
              selected_rail = excluded.selected_rail,
              agent_reasoning = excluded.agent_reasoning,
              paypal_authorization_id = excluded.paypal_authorization_id,
              rail_execution_id = excluded.rail_execution_id,
              rail_details_json = excluded.rail_details_json,
              status = 'authorized',
              updated_at = excluded.updated_at`,
      args: [
        executionId,
        workspaceId,
        mandate.run_id,
        mandate.id,
        selectedRail,
        reasoning,
        paypalHold.authorizationId,
        mandate.merchant_domain,
        mandate.amount_minor,
        mandate.currency,
        railExecutionId,
        JSON.stringify(railDetails),
        timestamp,
        timestamp,
      ],
    });

    // Log to run_events
    await tx.execute({
      sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
            VALUES (?, ?, ?, 'checkout_rail_executed', ?, ?)`,
      args: [
        `evt_${crypto.randomUUID().replace(/-/g, '')}`,
        workspaceId,
        mandate.run_id,
        JSON.stringify({
          executionId,
          mandateId: mandate.id,
          selectedRail,
          reasoning,
          paypalAuthorizationId: paypalHold.authorizationId,
          railExecutionId,
          amountMinor: mandate.amount_minor,
          currency: mandate.currency,
          merchantDomain: mandate.merchant_domain,
        }),
        timestamp,
      ],
    });
  });

  return {
    id: executionId,
    workspaceId,
    runId: mandate.run_id,
    mandateId: mandate.id,
    selectedRail,
    agentReasoning: reasoning,
    paypalHold,
    paypalAuthorizationId: paypalHold.authorizationId,
    merchantDomain: mandate.merchant_domain,
    amountMinor: mandate.amount_minor,
    amountFormatted: paypalHold.amountFormatted,
    currency: mandate.currency,
    railExecutionId,
    railDetails,
    status: 'authorized',
    createdAt: timestamp,
  };
}

/**
 * Safely voids an autonomous checkout mandate across all tiers.
 */
export async function voidCheckoutMandate({
  db,
  workspaceId,
  userId,
  mandateId,
  reason = 'User requested cancellation',
  now = Date.now(),
}) {
  if (!db) throw new Error('Database is required');
  if (!workspaceId) throw new Error('Workspace ID is required');
  if (!mandateId) throw new Error('Mandate ID is required');

  const execution = await withReadTransaction(db, async (tx) => {
    const res = await tx.execute({
      sql: `SELECT id, workspace_id, run_id, mandate_id, selected_rail, paypal_authorization_id,
                   rail_details_json, status
            FROM agent_checkout_executions
            WHERE workspace_id = ? AND mandate_id = ?`,
      args: [workspaceId, mandateId],
    });
    return res.rows[0] || null;
  });

  // Void the underlying PayPal Authorization Hold
  const paypalVoid = await voidSandboxPaymentAuthorization({
    db,
    workspaceId,
    userId,
    mandateId,
    reason,
    now,
  });

  let updatedRailDetails = {};
  if (execution) {
    try {
      const parsed = JSON.parse(execution.rail_details_json || '{}');
      if (execution.selected_rail === 'card_bridge') {
        updatedRailDetails = burnCardBridgeProxy(parsed, reason);
      } else if (execution.selected_rail === 'channel3_ucp') {
        updatedRailDetails = cancelChannel3UcpOrder(parsed, reason);
      } else {
        updatedRailDetails = { ...parsed, status: 'voided', voidReason: reason };
      }
    } catch {}

    const timestamp = new Date(now).toISOString();
    await withWriteTransaction(db, async (tx) => {
      await tx.execute({
        sql: `UPDATE agent_checkout_executions
              SET status = 'voided', rail_details_json = ?, updated_at = ?
              WHERE workspace_id = ? AND id = ?`,
        args: [JSON.stringify(updatedRailDetails), timestamp, workspaceId, execution.id],
      });

      await tx.execute({
        sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
              VALUES (?, ?, ?, 'checkout_rail_voided', ?, ?)`,
        args: [
          `evt_${crypto.randomUUID().replace(/-/g, '')}`,
          workspaceId,
          execution.run_id,
          JSON.stringify({
            executionId: execution.id,
            mandateId,
            selectedRail: execution.selected_rail,
            paypalAuthorizationId: execution.paypal_authorization_id,
            reason,
          }),
          timestamp,
        ],
      });
    });
  }

  return {
    mandateId,
    status: 'voided',
    paypalVoid,
    selectedRail: execution?.selected_rail || 'paypal_native',
    railDetails: updatedRailDetails,
  };
}

export async function getCheckoutExecution({ db, workspaceId, mandateId }) {
  if (!db || !workspaceId || !mandateId) return null;
  return withReadTransaction(db, async (tx) => {
    const res = await tx.execute({
      sql: `SELECT id, workspace_id, run_id, mandate_id, selected_rail, agent_reasoning,
                   paypal_authorization_id, merchant_domain, amount_minor, currency,
                   rail_execution_id, rail_details_json, status, created_at, updated_at
            FROM agent_checkout_executions
            WHERE workspace_id = ? AND mandate_id = ?`,
      args: [workspaceId, mandateId],
    });
    const row = res.rows[0];
    if (!row) return null;
    let details = {};
    try { details = JSON.parse(row.rail_details_json); } catch {}
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      mandateId: row.mandate_id,
      selectedRail: row.selected_rail,
      agentReasoning: row.agent_reasoning,
      paypalAuthorizationId: row.paypal_authorization_id,
      merchantDomain: row.merchant_domain,
      amountMinor: row.amount_minor,
      currency: row.currency,
      railExecutionId: row.rail_execution_id,
      railDetails: details,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}
