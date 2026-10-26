import { evaluatePolicy } from './policy.mjs';

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /system\s+override/i,
  /send\s+funds\s+to/i,
  /transfer\s+to\s+attacker/i,
  /disregard\s+budget/i,
  /bypass\s+(passkey|policy|cap)/i,
];

/**
 * Upgrade 4 (Meta Muse style, upgraded to deterministic):
 * Sentinel Outbound Guard + User-Controlled Transparent Memory Pills.
 *
 * Inspects screen text (Web DOM + Android ADB uiautomator text), price drift between
 * quoted price and checkout total, and deterministic policy rules BEFORE any PayPal hold.
 */
export function inspectWithSentinel({
  domText = '',
  adbText = '',
  quotedPriceCents,
  checkoutPriceCents,
  maxFeeCreepPercent = 12,
  mandate,
  policy,
  runSpentSoFarCents = 0,
} = {}) {
  const combinedText = `${String(domText || '')}\n${String(adbText || '')}`;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(combinedText)) {
      return { verdict: 'BLOCK', code: 'sentinel_prompt_injection_detected',
        detail: `Matched injection pattern: ${pattern.source}` };
    }
  }

  const hasQuote = quotedPriceCents !== undefined;
  const hasCheckout = checkoutPriceCents !== undefined;
  if (hasQuote !== hasCheckout) {
    return { verdict: 'BLOCK', code: 'sentinel_price_context_incomplete', detail: 'Both quoted and checkout prices are required.' };
  }
  if (hasQuote) {
    if (!Number.isSafeInteger(quotedPriceCents) || quotedPriceCents <= 0
        || !Number.isSafeInteger(checkoutPriceCents) || checkoutPriceCents <= 0
        || typeof maxFeeCreepPercent !== 'number' || !Number.isFinite(maxFeeCreepPercent)
        || maxFeeCreepPercent < 0 || maxFeeCreepPercent > 1000) {
      return { verdict: 'BLOCK', code: 'sentinel_price_context_invalid', detail: 'Price and fee-creep inputs are invalid.' };
    }
    const creepPct = ((checkoutPriceCents - quotedPriceCents) / quotedPriceCents) * 100;
    if (creepPct > maxFeeCreepPercent) {
      return { verdict: 'BLOCK', code: 'sentinel_dark_pattern_fee_creep',
        detail: `Checkout jumped ${creepPct.toFixed(1)}% above quote (${quotedPriceCents} -> ${checkoutPriceCents} cents)` };
    }
  }

  if (Boolean(policy) !== Boolean(mandate)) {
    return { verdict: 'BLOCK', code: 'sentinel_policy_context_incomplete', detail: 'Policy and mandate must both be supplied.' };
  }
  if (policy && mandate) {
    const result = evaluatePolicy(policy, mandate, runSpentSoFarCents);
    if (!result.allowed) return { verdict: 'BLOCK', code: 'sentinel_policy_violation', detail: result.reason };
    return { verdict: 'ALLOW', code: 'sentinel_clean', detail: 'Deterministic policy checks passed; this is not payment authorization.' };
  }

  return { verdict: 'REVIEW', code: 'sentinel_policy_required',
    detail: 'No transaction policy and mandate were supplied; this scan cannot authorize an action.' };
}

/**
 * Transparent Memory Pills: user-visible, 1-tap toggleable preference chips.
 * Unlike opaque cloud dossiers, only active pills are applied to tighten policy constraints.
 */
export function applyMemoryPills(basePolicy, memoryPills = [], itemMetadata = {}) {
  const tightened = {
    ...basePolicy,
    allowedDomains: [...(basePolicy.allowedDomains || [])],
    blockedPayees: [...(basePolicy.blockedPayees || [])],
  };

  for (const pill of memoryPills) {
    if (!pill || !pill.enabled) continue;

    if (pill.kind === 'MAX_ORDER_CENTS' && typeof pill.valueCents === 'number') {
      tightened.maxPerOrderCents = Math.min(tightened.maxPerOrderCents, pill.valueCents);
    }
    if (pill.kind === 'BLOCK_CONDITION' && itemMetadata.condition) {
      if (String(itemMetadata.condition).toLowerCase() === String(pill.value).toLowerCase()) {
        return {
          allowedByMemory: false,
          reason: `memory_pill_blocked_condition:${pill.label || pill.value}`,
          effectivePolicy: tightened,
        };
      }
    }
  }

  return {
    allowedByMemory: true,
    effectivePolicy: tightened,
  };
}
