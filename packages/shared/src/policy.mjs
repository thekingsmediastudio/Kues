/** Strict, deterministic server-side policy check. Invalid or incomplete input fails closed. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDomain(value) {
  return typeof value === 'string' && value.length <= 253
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);
}

/**
 * Check one proposed transaction against a known policy.
 * Money values are positive integer minor units; aggregate spend is a nonnegative integer.
 */
export function evaluatePolicy(policy, mandate, runSpentSoFarCents = 0) {
  if (!isRecord(policy) || !isRecord(mandate)) {
    return { allowed: false, reason: 'invalid_policy_or_mandate' };
  }
  const positiveInteger = (v) => Number.isSafeInteger(v) && v > 0;
  const nonNegativeInteger = (v) => Number.isSafeInteger(v) && v >= 0;
  if (!positiveInteger(mandate.amountCents)
      || !positiveInteger(mandate.policyCeilingCents)
      || !positiveInteger(policy.maxPerOrderCents)
      || !positiveInteger(policy.maxPerRunCents)
      || !nonNegativeInteger(runSpentSoFarCents)
      || typeof mandate.currency !== 'string' || !/^[A-Z]{3}$/.test(mandate.currency)
      || typeof policy.expectedCurrency !== 'string' || !/^[A-Z]{3}$/.test(policy.expectedCurrency)
      || !validDomain(mandate.merchantDomain)
      || !Array.isArray(policy.allowedDomains)
      || !policy.allowedDomains.every(validDomain)
      || !Array.isArray(policy.blockedPayees)
      || !policy.blockedPayees.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 320)
      || typeof mandate.payee !== 'string' || !mandate.payee.trim() || mandate.payee.length > 320) {
    return { allowed: false, reason: 'invalid_policy_or_mandate' };
  }
  if (mandate.currency !== policy.expectedCurrency) {
    return { allowed: false, reason: `currency_mismatch:${mandate.currency}!=${policy.expectedCurrency}` };
  }
  if (mandate.amountCents > policy.maxPerOrderCents) {
    return { allowed: false, reason: `ceiling_exceeded:${mandate.amountCents}>${policy.maxPerOrderCents}` };
  }
  if (mandate.amountCents > mandate.policyCeilingCents) {
    return { allowed: false, reason: `mandate_ceiling_exceeded:${mandate.amountCents}>${mandate.policyCeilingCents}` };
  }
  if (mandate.amountCents > policy.maxPerRunCents - runSpentSoFarCents) {
    return { allowed: false, reason: `run_budget_exceeded:${runSpentSoFarCents + mandate.amountCents}>${policy.maxPerRunCents}` };
  }
  if (policy.allowedDomains.length > 0 && !policy.allowedDomains.includes(mandate.merchantDomain.toLowerCase())) {
    return { allowed: false, reason: `domain_not_allowed:${mandate.merchantDomain}` };
  }
  if (policy.blockedPayees.some((payee) => payee.toLowerCase() === mandate.payee.trim().toLowerCase())) {
    return { allowed: false, reason: `payee_blocked:${mandate.payee}` };
  }
  return { allowed: true };
}
