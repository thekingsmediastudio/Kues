import {purchaseQuantity,quantityLine,purchaseItemsHash} from '../commerce/purchase-items.mjs';
import crypto from 'node:crypto';
import { withReadTransaction, withWriteTransaction } from '../db/transaction.mjs';
import { createAgentRun } from './discovery.mjs';

export class MandatePolicyError extends Error {
  constructor(code, status = 400, message = null) {
    super(message || code);
    this.name = 'MandatePolicyError';
    this.code = code;
    this.status = status;
  }
}

function isoNow(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid_timestamp');
  return date.toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function computePolicyHash(policyPayload) {
  const canonical = JSON.stringify(policyPayload, Object.keys(policyPayload).sort());
  return `sha256:${sha256(canonical)}`;
}

export function computeMandateChallenge({
  workspaceId,
  runId,
  amountMinor,
  currency,
  merchantDomain,
  evidenceHash,
  nonce,
}) {
  const rawChallenge = `${workspaceId}:${runId}:${amountMinor}:${currency}:${merchantDomain}:${evidenceHash}:${nonce}`;
  return {
    nonceHash: `sha256:${sha256(nonce)}`,
    challengeHash: `sha256:${sha256(rawChallenge)}`,
  };
}

/**
 * Evaluates spending policy for a proposed autonomous order.
 * Checks per-order cap, daily budget, and domain restrictions.
 */
export async function evaluateSpendPolicy({
  db,
  workspaceId,
  agentId = null,
  amountMinor,
  merchantDomain,
  payee = '',
  currency = 'USD',
  now = Date.now(),
}) {
  if (!db) throw new Error('database_required');
  if (!workspaceId) throw new Error('workspace_id_required');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new MandatePolicyError('invalid_amount', 400, 'Order amount must be a positive integer in minor units');
  }

  const normalizedDomain = String(merchantDomain || '').toLowerCase().trim();
  const normalizedCurrency = String(currency || 'USD').toUpperCase().trim();
  const currentIso = isoNow(now);
  const startOfDayIso = new Date(new Date(now).setUTCHours(0, 0, 0, 0)).toISOString();

  return withWriteTransaction(db, async (tx) => {
    // 1. Fetch active spend policy for this agent or workspace default
    let policyRow = null;
    if (agentId) {
      const agentPolicy = await tx.execute({
        sql: `SELECT id, workspace_id, agent_id, max_per_order_minor, max_per_run_minor,
                     daily_budget_minor, currency, allowed_domains_json, blocked_payees_json,
                     blocked_conditions_json, active
              FROM spend_policies
              WHERE workspace_id = ? AND agent_id = ? AND active = 1`,
        args: [workspaceId, agentId],
      });
      policyRow = agentPolicy.rows[0];
    }

    if (!policyRow) {
      const workspacePolicy = await tx.execute({
        sql: `SELECT id, workspace_id, agent_id, max_per_order_minor, max_per_run_minor,
                     daily_budget_minor, currency, allowed_domains_json, blocked_payees_json,
                     blocked_conditions_json, active
              FROM spend_policies
              WHERE workspace_id = ? AND agent_id IS NULL AND active = 1`,
        args: [workspaceId],
      });
      policyRow = workspacePolicy.rows[0];
    }

    // 2. If no policy exists in DB, initialize one from agent settings or safe defaults
    if (!policyRow) {
      let maxPerOrder = 2000; // $20.00
      let dailyBudget = 10000; // $100.00
      if (agentId) {
        const agentResult = await tx.execute({
          sql: 'SELECT settings_json FROM agents WHERE workspace_id = ? AND id = ?',
          args: [workspaceId, agentId],
        });
        const agent = agentResult.rows[0];
        if (agent?.settings_json) {
          try {
            const settings = JSON.parse(agent.settings_json);
            if (Number.isSafeInteger(settings.orderCap) && settings.orderCap > 0) {
              maxPerOrder = settings.orderCap * 100;
            }
            if (Number.isSafeInteger(settings.dailyCap) && settings.dailyCap > 0) {
              dailyBudget = settings.dailyCap * 100;
            }
          } catch {}
        }
      }

      const policyId = `pol_${crypto.randomUUID().replaceAll('-', '')}`;
      await tx.execute({
        sql: `INSERT INTO spend_policies (
               id, workspace_id, agent_id, max_per_order_minor, max_per_run_minor,
               daily_budget_minor, currency, allowed_domains_json, blocked_payees_json,
               blocked_conditions_json, active, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'USD', '[]', '[]', '[]', 1, ?, ?)`,
        args: [
          policyId,
          workspaceId,
          agentId || null,
          maxPerOrder,
          maxPerOrder * 2,
          dailyBudget,
          currentIso,
          currentIso,
        ],
      });

      policyRow = {
        id: policyId,
        workspace_id: workspaceId,
        agent_id: agentId || null,
        max_per_order_minor: maxPerOrder,
        max_per_run_minor: maxPerOrder * 2,
        daily_budget_minor: dailyBudget,
        currency: 'USD',
        allowed_domains_json: '[]',
        blocked_payees_json: '[]',
        blocked_conditions_json: '[]',
        active: 1,
      };
    }

    // 3. Calculate daily spend so far today
    const dailySpentResult = await tx.execute({
      sql: `SELECT COALESCE(SUM(amount_minor), 0) AS daily_spent
            FROM mandates
            WHERE workspace_id = ?
              AND status IN ('authorized', 'awaiting_approval', 'approved', 'captured')
              AND created_at >= ?`,
      args: [workspaceId, startOfDayIso],
    });
    const dailySpentMinor = Number(dailySpentResult.rows[0]?.daily_spent || 0);

    // 4. Validate domain allow/block lists
    let allowedDomains = [];
    let blockedPayees = [];
    try { allowedDomains = JSON.parse(policyRow.allowed_domains_json || '[]'); } catch {}
    try { blockedPayees = JSON.parse(policyRow.blocked_payees_json || '[]'); } catch {}

    const isDomainBlocked = blockedPayees.some((d) => normalizedDomain.includes(String(d).toLowerCase()));
    const isDomainNotAllowed = allowedDomains.length > 0 && !allowedDomains.some((d) => normalizedDomain.includes(String(d).toLowerCase()));

    // 5. Evaluate limits
    let allowed = 1;
    let decisionCode = 'approved';
    let failureReason = null;

    if (policyRow.currency !== normalizedCurrency) {
      allowed = 0;
      decisionCode = 'currency_mismatch';
      failureReason = `Currency ${normalizedCurrency} does not match policy currency ${policyRow.currency}`;
    } else if (isDomainBlocked || isDomainNotAllowed) {
      allowed = 0;
      decisionCode = 'merchant_domain_blocked';
      failureReason = `Merchant domain ${normalizedDomain} is not permitted by spend policy`;
    } else if (amountMinor > policyRow.max_per_order_minor) {
      allowed = 0;
      decisionCode = 'order_cap_exceeded';
      failureReason = `Order amount $${(amountMinor / 100).toFixed(2)} exceeds agent per-order cap of $${(policyRow.max_per_order_minor / 100).toFixed(2)} USD`;
    } else if (dailySpentMinor + amountMinor > policyRow.daily_budget_minor) {
      allowed = 0;
      decisionCode = 'daily_cap_exceeded';
      failureReason = `Order would bring daily spend to $${((dailySpentMinor + amountMinor) / 100).toFixed(2)}, exceeding daily limit of $${(policyRow.daily_budget_minor / 100).toFixed(2)} USD`;
    }

    const policyPayload = {
      policyId: policyRow.id,
      maxPerOrderMinor: policyRow.max_per_order_minor,
      dailyBudgetMinor: policyRow.daily_budget_minor,
      currency: policyRow.currency,
      dailySpentMinor,
      requestedAmountMinor: amountMinor,
      merchantDomain: normalizedDomain,
    };
    const policyHash = computePolicyHash(policyPayload);

    return {
      allowed: Boolean(allowed),
      decisionCode,
      failureReason,
      policyHash,
      spendPolicyId: policyRow.id,
      maxPerOrderMinor: policyRow.max_per_order_minor,
      dailyBudgetMinor: policyRow.daily_budget_minor,
      dailySpentMinor,
      remainingDailyMinor: Math.max(0, policyRow.daily_budget_minor - dailySpentMinor),
      currency: policyRow.currency,
    };
  });
}

/**
 * Creates an autonomous purchase mandate and associated approval record.
 * Connects product evidence with spend policy evaluation and cryptographically hashed nonces.
 */
export async function createPurchaseMandate({
  db,
  workspaceId,
  userId,
  agentId,
  offerId = null,
  product = null,
  items = null,
  quantity = undefined,
  runId = null,
  now = Date.now(),
  ttlMs = 15 * 60 * 1000, // 15 minute expiration
}) {
  if (!db) throw new Error('database_required');
  if (!workspaceId) throw new Error('workspace_id_required');
  if (!userId) throw new Error('user_id_required');

  const timestamp = isoNow(now);
  const expiresAt = isoNow(now + ttlMs);

  let targetRunId = runId;
  const resolvedItems = [];
  try {
    if(items!==null){if(!Array.isArray(items)||items.length<1||items.length>10||quantity!==undefined||offerId||product)throw Error('purchase_items_invalid');
      for(const i of items){if(!i||typeof i!=='object'||Array.isArray(i))throw Error('purchase_items_invalid');purchaseQuantity(i.quantity);}
      const offers=items.filter(i=>i.offerId).map(i=>i.offerId);if(new Set(offers).size!==offers.length)throw Error('duplicate_purchase_offer');
    }else{if(offerId&&product)throw Error('purchase_items_ambiguous');if(quantity!==undefined&&product?.quantity!==undefined)throw Error('purchase_quantity_ambiguous');purchaseQuantity(quantity===undefined?product?.quantity:quantity);}
  }catch(e){throw new MandatePolicyError(e.message,400,e.message);}


  if (Array.isArray(items) && items.length > 0) {
    for (const rawItem of items) {
      if (rawItem.offerId) {
        const offerResult = await db.execute({
          sql: `SELECT id, run_id, source, source_url, merchant_name, merchant_domain,
                       title, amount_minor, currency, availability, evidence_hash
                FROM product_offers
                WHERE workspace_id = ? AND id = ? AND EXISTS(SELECT 1 FROM runs r WHERE r.id=product_offers.run_id AND r.workspace_id=product_offers.workspace_id AND r.user_id=? AND r.agent_id=?)`,
          args: [workspaceId, rawItem.offerId,userId,agentId],
        });
        const offer = offerResult.rows[0];
        if (!offer) throw new MandatePolicyError('product_offer_not_found', 404, `Product offer ${rawItem.offerId} not found`);
        resolvedItems.push({
          offerId: offer.id,
          title: offer.title,
          merchantName: offer.merchant_name,
          merchantDomain: offer.merchant_domain,
          amountMinor: offer.amount_minor,
          quantity: rawItem.quantity,
          currency: offer.currency,
          url: offer.source_url,
          evidenceHash: offer.evidence_hash,
        });
        if (!targetRunId) targetRunId = offer.run_id;
      } else if (rawItem.title || rawItem.productTitle) {
        const title = rawItem.title || rawItem.productTitle;
        const merchantDomain = rawItem.merchantDomain;
        const amountMinor = rawItem.amountMinor;
        const evidenceHash = rawItem.evidenceHash;
        if (!title || !merchantDomain || !Number.isSafeInteger(amountMinor) || !evidenceHash) {
          throw new MandatePolicyError('invalid_product_details', 400, 'Product details missing required fields');
        }
        resolvedItems.push({
          offerId: rawItem.offerId || null,
          title,
          merchantName: rawItem.merchantName || merchantDomain,
          merchantDomain,
          amountMinor,
          quantity: rawItem.quantity,
          currency: rawItem.currency || 'USD',
          url: rawItem.url || '',
          evidenceHash,
        });
      } else { throw new MandatePolicyError('invalid_product_details',400,'Each item must identify an offer or product'); }
    }
  } else if (offerId) {
    const offerResult = await db.execute({
      sql: `SELECT id, run_id, source, source_url, merchant_name, merchant_domain,
                   title, amount_minor, currency, availability, evidence_hash
            FROM product_offers
            WHERE workspace_id = ? AND id = ? AND EXISTS(SELECT 1 FROM runs r WHERE r.id=product_offers.run_id AND r.workspace_id=product_offers.workspace_id AND r.user_id=? AND r.agent_id=?)`,
      args: [workspaceId, offerId,userId,agentId],
    });
    const offer = offerResult.rows[0];
    if (!offer) throw new MandatePolicyError('product_offer_not_found', 404, `Product offer ${offerId} not found`);
    resolvedItems.push({
      offerId: offer.id,
      title: offer.title,
      merchantName: offer.merchant_name,
      merchantDomain: offer.merchant_domain,
      amountMinor: offer.amount_minor,
      quantity,
      currency: offer.currency,
      url: offer.source_url,
      evidenceHash: offer.evidence_hash,
    });
    if (!targetRunId) targetRunId = offer.run_id;
  } else if (product) {
    if (!product.title || !product.merchantDomain || !Number.isSafeInteger(product.amountMinor) || !product.evidenceHash) {
      throw new MandatePolicyError('invalid_product_details', 400, 'Product details missing required fields');
    }
    resolvedItems.push({
      offerId: product.offerId || null,
      title: product.title,
      merchantName: product.merchantName || product.merchantDomain,
      merchantDomain: product.merchantDomain,
      amountMinor: product.amountMinor,
      quantity: quantity===undefined?product.quantity:quantity,
      currency: product.currency || 'USD',
      url: product.url || '',
      evidenceHash: product.evidenceHash,
    });
  } else {
    throw new MandatePolicyError('offer_or_product_required', 400, 'Must supply offerId, product details, or items list');
  }

  if (resolvedItems.length === 0) {
    throw new MandatePolicyError('items_empty', 400, 'Must supply at least one valid item');
  }

  try {for(let i=0;i<resolvedItems.length;i++)resolvedItems[i]=quantityLine(resolvedItems[i]);}
  catch(e){throw new MandatePolicyError(e.message,400,e.message);}
  const primaryCurrency = resolvedItems[0].currency;
  if (resolvedItems.some((i) => i.currency !== primaryCurrency)) {
    throw new MandatePolicyError('currency_mismatch', 400, 'All bundle items must share the same currency');
  }

  const totalAmountMinor = resolvedItems.reduce((acc, i) => acc + i.amountMinor, 0);
  if(!Number.isSafeInteger(totalAmountMinor)||totalAmountMinor>100000000)throw new MandatePolicyError('purchase_amount_invalid',400);
  const itemsHash=purchaseItemsHash(resolvedItems);
  const isBundle = resolvedItems.length > 1;

  let targetProduct = null;
  if (!isBundle) {
    targetProduct = resolvedItems[0];
  } else {
    const uniqueDomains = Array.from(new Set(resolvedItems.map((i) => i.merchantDomain)));
    const uniqueMerchants = Array.from(new Set(resolvedItems.map((i) => i.merchantName)));
    const sortedEvidence = resolvedItems.map((i) => i.evidenceHash).sort().join(':');
    targetProduct = {
      offerId: null,
      title: `Bundle (${resolvedItems.length} items)`,
      merchantName: uniqueMerchants.length === 1 ? uniqueMerchants[0] : uniqueMerchants.join(', '),
      merchantDomain: uniqueDomains.length === 1 ? uniqueDomains[0] : uniqueDomains.join(', '),
      amountMinor: totalAmountMinor,
      currency: primaryCurrency,
      evidenceHash: `sha256:${sha256(sortedEvidence)}`,
      items: resolvedItems,
      isBundle: true,
    };
  }

  // 2. Ensure run exists (outside inner tx to prevent write-queue deadlock)
  if (!targetRunId) {
    const runGoal = isBundle
      ? `Bundle purchase mandate evaluation (${resolvedItems.length} items)`
      : `Purchase mandate evaluation for "${targetProduct.title}"`;
    const newRun = await createAgentRun({
      db,
      workspaceId,
      userId,
      agentId,
      goal: runGoal,
      mode: 'sandbox_purchase',
      now,
    });
    targetRunId = newRun.runId;
  }

  // 3. Evaluate spend policy (outside inner tx to prevent write-queue deadlock)
  let policyResult = await evaluateSpendPolicy({
    db,
    workspaceId,
    agentId,
    amountMinor: targetProduct.amountMinor,
    merchantDomain: resolvedItems[0].merchantDomain,
    payee: targetProduct.merchantName,
    currency: targetProduct.currency,
    now,
  });

  // Every line's merchant must pass policy; a permitted first line cannot hide another.
  for(const item of resolvedItems.slice(1)){
    if(!policyResult.allowed)break;
    const check=await evaluateSpendPolicy({db,workspaceId,agentId,amountMinor:totalAmountMinor,merchantDomain:item.merchantDomain,payee:item.merchantName,currency:primaryCurrency,now});
    if(!check.allowed)policyResult=check;
  }

  const decisionId = `pdec_${crypto.randomUUID().replaceAll('-', '')}`;

  return withWriteTransaction(db, async (tx) => {
    if (!policyResult.allowed) {
      // Record denied policy decision
      await tx.execute({
        sql: `INSERT INTO policy_decisions (
               id, workspace_id, run_id, spend_policy_id, allowed, decision_code,
               policy_hash, mandate_hash, created_at
             ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?)`,
        args: [
          decisionId,
          workspaceId,
          targetRunId,
          policyResult.spendPolicyId,
          policyResult.decisionCode,
          policyResult.policyHash,
          timestamp,
        ],
      });

      await tx.execute({
        sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
              VALUES (?, ?, ?, 'policy_decision_blocked', ?, ?)`,
        args: [
          `evt_${crypto.randomUUID().replaceAll('-', '')}`,
          workspaceId,
          targetRunId,
          JSON.stringify({
            decisionCode: policyResult.decisionCode,
            reason: policyResult.failureReason,
            isBundle,
            items: resolvedItems,
          }),
          timestamp,
        ],
      });

      return {
        allowed: false,
        decisionCode: policyResult.decisionCode,
        failureReason: policyResult.failureReason,
        policyDecisionId: decisionId,
        product: targetProduct,
        items: resolvedItems,
        isBundle,
        limits: {
          maxPerOrderMinor: policyResult.maxPerOrderMinor,
          dailyBudgetMinor: policyResult.dailyBudgetMinor,
          dailySpentMinor: policyResult.dailySpentMinor,
          remainingDailyMinor: policyResult.remainingDailyMinor,
        },
      };
    }

    // 4. Allowed: Formulate cryptographically bound purchase mandate
    const mandateId = `man_${crypto.randomUUID().replaceAll('-', '')}`;
    const approvalId = `mapp_${crypto.randomUUID().replaceAll('-', '')}`;
    const nonce = crypto.randomBytes(32).toString('hex');
    const { nonceHash, challengeHash } = computeMandateChallenge({
      workspaceId,
      runId: targetRunId,
      amountMinor: targetProduct.amountMinor,
      currency: targetProduct.currency,
      merchantDomain: targetProduct.merchantDomain,
      evidenceHash: targetProduct.evidenceHash+':'+itemsHash,
      nonce,
    });

    const mandatePayload = {
      mandateId,
      workspaceId,
      runId: targetRunId,
      amountMinor: targetProduct.amountMinor,
      currency: targetProduct.currency,
      merchantDomain: targetProduct.merchantDomain,
      evidenceHash: targetProduct.evidenceHash,
      nonceHash,
      challengeHash,
      purchaseItemsHash:itemsHash,
    };
    const mandateHash = `sha256:${sha256(JSON.stringify(mandatePayload))}`;

    // Record approved policy decision
    await tx.execute({
      sql: `INSERT INTO policy_decisions (
             id, workspace_id, run_id, spend_policy_id, allowed, decision_code,
             policy_hash, mandate_hash, created_at
           ) VALUES (?, ?, ?, ?, 1, 'approved', ?, ?, ?)`,
      args: [
        decisionId,
        workspaceId,
        targetRunId,
        policyResult.spendPolicyId,
        policyResult.policyHash,
        mandateHash,
        timestamp,
      ],
    });

    // Insert mandate
    await tx.execute({
      sql: `INSERT INTO mandates (
             id, workspace_id, run_id, policy_decision_id, amount_minor, currency,
             payee, merchant_domain, evidence_hash, nonce_hash, challenge_hash,
             status, expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?)`,
      args: [
        mandateId,
        workspaceId,
        targetRunId,
        decisionId,
        targetProduct.amountMinor,
        targetProduct.currency,
        targetProduct.merchantName,
        targetProduct.merchantDomain,
        targetProduct.evidenceHash,
        nonceHash,
        challengeHash,
        expiresAt,
        timestamp,
        timestamp,
      ],
    });

    await tx.execute({sql:'UPDATE mandates SET purchase_items_hash=? WHERE id=? AND workspace_id=?',args:[itemsHash,mandateId,workspaceId]});
    for(const [index,item] of resolvedItems.entries())await tx.execute({sql:'INSERT INTO mandate_purchase_items(mandate_id,workspace_id,line_number,offer_id,title,merchant_domain,currency,unit_amount_minor,quantity,line_total_minor,evidence_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)',args:[mandateId,workspaceId,index+1,item.offerId||null,item.title,item.merchantDomain,item.currency,item.unitAmountMinor,item.quantity,item.lineTotalMinor,item.evidenceHash]});

    // Insert mandate approval ceremony record
    await tx.execute({
      sql: `INSERT INTO mandate_approvals (
             id, workspace_id, mandate_id, user_id, credential_id,
             challenge_hash, status, expires_at, verified_at, created_at
           ) VALUES (?, ?, ?, ?, NULL, ?, 'pending', ?, NULL, ?)`,
      args: [
        approvalId,
        workspaceId,
        mandateId,
        userId,
        challengeHash,
        expiresAt,
        timestamp,
      ],
    });

    // If target product has an offerId, ensure it is recorded in product_offers
    if (targetProduct.offerId) {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO product_offers (
               id, workspace_id, run_id, source, source_listing_id, source_url,
               merchant_name, merchant_domain, title, amount_minor, currency,
               availability, evidence_hash, observed_at, created_at
             ) VALUES (?, ?, ?, 'channel3', ?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?, ?)`,
        args: [
          targetProduct.offerId,
          workspaceId,
          targetRunId,
          targetProduct.offerId,
          targetProduct.url || '',
          targetProduct.merchantName,
          targetProduct.merchantDomain,
          targetProduct.title,
          targetProduct.unitAmountMinor,
          targetProduct.currency,
          targetProduct.evidenceHash,
          timestamp,
          timestamp,
        ],
      });
    }

    // Record run event
    await tx.execute({
      sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
            VALUES (?, ?, ?, 'mandate_proposed', ?, ?)`,
      args: [
        `evt_${crypto.randomUUID().replaceAll('-', '')}`,
        workspaceId,
        targetRunId,
        JSON.stringify({
          mandateId,
          approvalId,
          amountMinor: targetProduct.amountMinor,
          currency: targetProduct.currency,
          merchantDomain: targetProduct.merchantDomain,
          evidenceHash: targetProduct.evidenceHash,
          isBundle,
          items: resolvedItems,
        }),
        timestamp,
      ],
    });

    return {
      allowed: true,
      decisionCode: 'approved',
      mandateId,
      approvalId,
      runId: targetRunId,
      challengeHash,
      nonce,
      expiresAt,
      product: targetProduct,
      items: resolvedItems,
      isBundle,
      amountFormatted: `$${(targetProduct.amountMinor / 100).toFixed(2)} ${targetProduct.currency}`,
      limits: {
        maxPerOrderMinor: policyResult.maxPerOrderMinor,
        dailyBudgetMinor: policyResult.dailyBudgetMinor,
        dailySpentMinor: policyResult.dailySpentMinor,
        remainingDailyMinor: policyResult.remainingDailyMinor,
      },
    };
  });
}

/**
 * Authorizes or rejects a proposed purchase mandate.
 */
export async function authorizePurchaseMandate({
  db,
  workspaceId,
  userId,
  mandateId,
  decision = 'approve',
  now = Date.now(),
}) {
  if (!db) throw new Error('database_required');
  if (!workspaceId) throw new Error('workspace_id_required');
  if (!userId) throw new Error('user_id_required');
  if (!mandateId) throw new Error('mandate_id_required');

  const timestamp = isoNow(now);

  const txResult = await withWriteTransaction(db, async (tx) => {
    const mandateResult = await tx.execute({
      sql: `SELECT id, workspace_id, run_id, amount_minor, currency, payee,
                   merchant_domain, evidence_hash, status, expires_at
            FROM mandates
            WHERE workspace_id = ? AND id = ? AND EXISTS (SELECT 1 FROM runs r WHERE r.id=mandates.run_id AND r.workspace_id=mandates.workspace_id AND r.user_id=?) AND EXISTS (SELECT 1 FROM mandate_approvals ma WHERE ma.mandate_id=mandates.id AND ma.user_id=?)`,
      args: [workspaceId, mandateId, userId, userId],
    });
    const mandate = mandateResult.rows[0];
    if (!mandate) throw new MandatePolicyError('mandate_not_found', 404, 'Purchase mandate not found');

    if (mandate.status !== 'awaiting_approval') {
      throw new MandatePolicyError(
        'mandate_already_processed',
        409,
        `Mandate is already in status '${mandate.status}'`
      );
    }

    if (new Date(mandate.expires_at).getTime() <= now) {
      await tx.execute({
        sql: `UPDATE mandates SET status = 'expired', updated_at = ? WHERE workspace_id = ? AND id = ?`,
        args: [timestamp, workspaceId, mandateId],
      });
      await tx.execute({
        sql: `UPDATE mandate_approvals SET status = 'expired' WHERE workspace_id = ? AND mandate_id = ?`,
        args: [workspaceId, mandateId],
      });
      return { expired: true };
    }

    const isApproval = decision === 'approve';
    const newStatus = isApproval ? 'authorized' : 'rejected';
    const approvalStatus = isApproval ? 'verified' : 'rejected';

    await tx.execute({
      sql: `UPDATE mandates SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
      args: [newStatus, timestamp, workspaceId, mandateId],
    });

    await tx.execute({
      sql: `UPDATE mandate_approvals
            SET status = ?, verified_at = ?
            WHERE workspace_id = ? AND mandate_id = ?`,
      args: [approvalStatus, isApproval ? timestamp : null, workspaceId, mandateId],
    });

    await tx.execute({
      sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        `evt_${crypto.randomUUID().replaceAll('-', '')}`,
        workspaceId,
        mandate.run_id,
        isApproval ? 'mandate_authorized' : 'mandate_rejected',
        JSON.stringify({ mandateId, userId, amountMinor: mandate.amount_minor }),
        timestamp,
      ],
    });

    return {
      mandateId,
      status: newStatus,
      decision,
      amountMinor: mandate.amount_minor,
      currency: mandate.currency,
      payee: mandate.payee,
      merchantDomain: mandate.merchant_domain,
      evidenceHash: mandate.evidence_hash,
      authorizedAt: isApproval ? timestamp : null,
    };
  });

  if (txResult?.expired) {
    throw new MandatePolicyError('mandate_expired', 410, 'Purchase mandate has expired');
  }

  return txResult;
}

/**
 * Retrieves a mandate with associated policy decision and product offer.
 */
export async function getMandateDetails({ db, workspaceId, mandateId }) {
  if (!db) throw new Error('database_required');
  return withReadTransaction(db, async (tx) => {
    const result = await tx.execute({
      sql: `SELECT m.id, m.workspace_id, m.run_id, m.amount_minor, m.currency,
                   m.payee, m.merchant_domain, m.evidence_hash, m.status,
                   m.expires_at, m.created_at, m.updated_at,
                   pd.decision_code, pd.allowed AS policy_allowed, pd.policy_hash,
                   ma.status AS approval_status, ma.verified_at
            FROM mandates m
            JOIN policy_decisions pd ON pd.id = m.policy_decision_id
            LEFT JOIN mandate_approvals ma ON ma.mandate_id = m.id
            WHERE m.workspace_id = ? AND m.id = ?`,
      args: [workspaceId, mandateId],
    });
    return result.rows[0] || null;
  });
}
