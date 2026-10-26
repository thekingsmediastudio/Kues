import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJSON,
  computeMandateChallenge,
  computeEvidenceHash,
} from '../../packages/shared/src/mandate.mjs';
import { evaluatePolicy } from '../../packages/shared/src/policy.mjs';
import { makePayPalRequestId } from '../../apps/web/lib/paypal/idempotency.mjs';

const baseMandate = {
  v: 1,
  runId: 'run_01JB7F3A9B2C',
  orderId: '5O190127TN364715T',
  authorizationId: '0AW987654321',
  amountCents: 7850,
  currency: 'USD',
  payee: 'seller@lagosaudio.example.com',
  merchantDomain: 'lagosaudio.example.com',
  evidenceHash: computeEvidenceHash(Buffer.from('screenshot-bytes-v1')),
  policyCeilingCents: 10000,
  issuedAt: '2026-10-24T12:00:00Z',
  nonce: 'nonce_abc123',
};

const basePolicy = {
  maxPerOrderCents: 10000,
  maxPerRunCents: 15000,
  expectedCurrency: 'USD',
  allowedDomains: ['lagosaudio.example.com', 'channel3.example.com'],
  blockedPayees: ['attacker@evil.com'],
};

test('W1/W5: canonicalJSON is key-order invariant and sensitive to 1-cent amount tampering', () => {
  const reordered = {
    nonce: baseMandate.nonce,
    amountCents: baseMandate.amountCents,
    v: baseMandate.v,
    runId: baseMandate.runId,
    orderId: baseMandate.orderId,
    authorizationId: baseMandate.authorizationId,
    currency: baseMandate.currency,
    payee: baseMandate.payee,
    merchantDomain: baseMandate.merchantDomain,
    evidenceHash: baseMandate.evidenceHash,
    policyCeilingCents: baseMandate.policyCeilingCents,
    issuedAt: baseMandate.issuedAt,
  };
  assert.equal(canonicalJSON(baseMandate), canonicalJSON(reordered));
  assert.equal(computeMandateChallenge(baseMandate), computeMandateChallenge(reordered));

  const tampered = { ...baseMandate, amountCents: 7851 };
  assert.notEqual(computeMandateChallenge(baseMandate), computeMandateChallenge(tampered));
});

test('Policy Engine: allows valid order at or below ceiling and blocks prompt-injection $450 over-cap', () => {
  const ok = evaluatePolicy(basePolicy, baseMandate);
  assert.equal(ok.allowed, true);

  // Exact ceiling (10000 cents = $100.00) passes
  const exactCeiling = evaluatePolicy(basePolicy, { ...baseMandate, amountCents: 10000 });
  assert.equal(exactCeiling.allowed, true);

  // One cent over ceiling (10001 cents = $100.01) fails closed
  const oneCentOver = evaluatePolicy(basePolicy, { ...baseMandate, amountCents: 10001 });
  assert.equal(oneCentOver.allowed, false);
  assert.match(oneCentOver.reason, /^ceiling_exceeded/);

  // Prompt injection ($450.00 to attacker@evil.com) fails closed
  const injected = evaluatePolicy(basePolicy, {
    ...baseMandate,
    amountCents: 45000,
    payee: 'attacker@evil.com',
  });
  assert.equal(injected.allowed, false);
});

test('Policy Engine: rejects malformed money values and missing ceilings by default', () => {
  for (const amountCents of [-1, 0, 0.5, '100', null, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.equal(evaluatePolicy(basePolicy, { ...baseMandate, amountCents }).allowed, false, `amount ${String(amountCents)} must fail closed`);
  }
  for (const key of ['maxPerOrderCents', 'maxPerRunCents']) {
    const invalidPolicy = { ...basePolicy, [key]: undefined };
    assert.equal(evaluatePolicy(invalidPolicy, { ...baseMandate, amountCents: 999999 }).allowed, false);
  }
  assert.equal(evaluatePolicy(basePolicy, { ...baseMandate, policyCeilingCents: undefined }).allowed, false);
  assert.equal(evaluatePolicy(basePolicy, baseMandate, -1).allowed, false);
  assert.equal(evaluatePolicy(basePolicy, baseMandate, 0.5).allowed, false);
});

test('Policy Engine: enforces domain allowlist, payee blocklist, and currency match', () => {
  const badDomain = evaluatePolicy(basePolicy, {
    ...baseMandate,
    merchantDomain: 'phishing.example.org',
  });
  assert.equal(badDomain.allowed, false);
  assert.match(badDomain.reason, /^domain_not_allowed/);

  const badPayee = evaluatePolicy(basePolicy, {
    ...baseMandate,
    payee: 'attacker@evil.com',
  });
  assert.equal(badPayee.allowed, false);
  assert.match(badPayee.reason, /^payee_blocked/);

  const badCurrency = evaluatePolicy(basePolicy, {
    ...baseMandate,
    currency: 'EUR',
  });
  assert.equal(badCurrency.allowed, false);
  assert.match(badCurrency.reason, /^currency_mismatch/);
});

test('P7: PayPal-Request-Id generator produces deterministic clw_<op>_<runIdShort>_<uuid8> keys', () => {
  const id1 = makePayPalRequestId('cap', 'run_01JB7F3A9B2C', '0AW987654321');
  const id2 = makePayPalRequestId('cap', 'run_01JB7F3A9B2C', '0AW987654321');
  assert.equal(id1, id2);
  assert.match(id1, /^clw_cap_01JB7F3A_[0-9a-f]{8}$/);
});
