import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrevoEmailDelivery } from '../../apps/web/lib/auth/brevo-delivery.mjs';

const settings = {
  apiKey: 'test-only-api-key',
  senderEmail: 'login@example.test',
  senderName: 'Keus Test',
  appBaseUrl: 'https://keus.example.test',
};

test('Brevo adapter sends a transactional magic-link message using server-side configuration', async () => {
  let captured;
  const delivery = createBrevoEmailDelivery({
    ...settings,
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 201 };
    },
  });
  const result = await delivery.sendMagicLink({ email: 'person@example.test', token: 'a'.repeat(43) });
  assert.deepEqual(result, { accepted: true });
  assert.equal(captured.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['api-key'], 'test-only-api-key');
  assert.deepEqual(captured.body.sender, { name: 'Keus Test', email: 'login@example.test' });
  assert.deepEqual(captured.body.to, [{ email: 'person@example.test' }]);
  assert.match(captured.body.textContent, /https:\/\/keus\.example\.test\/auth\/verify\?token=/);
  assert.match(captured.body.htmlContent, /Sign in to Keus/);
  assert.deepEqual(captured.body.tags, ['keus-auth']);
});

test('Brevo adapter fails closed on invalid settings or rejected sends', async () => {
  assert.throws(() => createBrevoEmailDelivery({ ...settings, appBaseUrl: 'https://keus.example.test/path' }), /app_base_url_must_be_https_origin/);
  assert.throws(() => createBrevoEmailDelivery({ ...settings, appBaseUrl: 'http://keus.example.test' }), /app_base_url_must_be_https_origin/);
  const delivery = createBrevoEmailDelivery({
    ...settings,
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  await assert.rejects(
    delivery.sendMagicLink({ email: 'person@example.test', token: 'a'.repeat(43) }),
    /brevo_rejected_401/
  );
});
