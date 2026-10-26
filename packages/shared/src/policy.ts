import type { MandatePayload } from './mandate.ts';

export interface SpendPolicy {
  maxPerOrderCents: number;
  maxPerRunCents: number;
  expectedCurrency: string;
  allowedDomains: string[]; // empty = allow any
  blockedPayees: string[];
}

export interface PolicyEvaluation {
  allowed: boolean;
  reason?: string;
}

/**
 * Deterministic server-side settlement policy check (doc 04 §A6).
 * Executed after WebAuthn assertion verification and before PayPal capture.
 */
export function evaluatePolicy(
  policy: SpendPolicy,
  mandate: MandatePayload,
  runSpentSoFarCents = 0
): PolicyEvaluation {
  if (mandate.currency !== policy.expectedCurrency) {
    return {
      allowed: false,
      reason: `currency_mismatch:${mandate.currency}!=${policy.expectedCurrency}`,
    };
  }
  if (mandate.amountCents > policy.maxPerOrderCents) {
    return {
      allowed: false,
      reason: `ceiling_exceeded:${mandate.amountCents}>${policy.maxPerOrderCents}`,
    };
  }
  if (mandate.amountCents > mandate.policyCeilingCents) {
    return {
      allowed: false,
      reason: `mandate_ceiling_exceeded:${mandate.amountCents}>${mandate.policyCeilingCents}`,
    };
  }
  if (runSpentSoFarCents + mandate.amountCents > policy.maxPerRunCents) {
    return {
      allowed: false,
      reason: `run_budget_exceeded:${runSpentSoFarCents + mandate.amountCents}>${policy.maxPerRunCents}`,
    };
  }
  if (
    policy.allowedDomains.length > 0 &&
    !policy.allowedDomains.includes(mandate.merchantDomain)
  ) {
    return {
      allowed: false,
      reason: `domain_not_allowed:${mandate.merchantDomain}`,
    };
  }
  if (policy.blockedPayees.includes(mandate.payee)) {
    return {
      allowed: false,
      reason: `payee_blocked:${mandate.payee}`,
    };
  }
  return { allowed: true };
}
