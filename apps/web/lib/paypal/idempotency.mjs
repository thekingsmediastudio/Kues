import crypto from 'node:crypto';

/**
 * Generates deterministic or unique PayPal-Request-Id headers following doc 10 §2:
 * Format: clw_<op>_<runIdShort>_<uuid8>
 */
export function makePayPalRequestId(op, runId, deterministicKey) {
  const cleanRun = String(runId).replace(/^run_/, '').slice(0, 8) || 'global00';
  const suffix = deterministicKey
    ? crypto.createHash('sha256').update(`${op}:${runId}:${deterministicKey}`).digest('hex').slice(0, 8)
    : crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `clw_${op}_${cleanRun}_${suffix}`;
}
