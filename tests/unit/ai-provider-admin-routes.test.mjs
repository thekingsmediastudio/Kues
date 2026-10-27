import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAiProviderService } from '../../apps/web/lib/ai-providers/service.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import { createServer } from '../../apps/web/server.mjs';

const adminId = 'provider-admin-00001';
const encryptionKey = Buffer.alloc(32, 23).toString('base64');
const testApiKey = 'local_route_test_key_not_real';

async function withServer(config, authService, aiProviderService, run) {
  const server = createServer({ config, authService, aiProviderService });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('AI provider creation route is same-origin, WorkOS-session and admin-allowlist protected, and never returns the key', async () => {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  await db.execute({
    sql: 'INSERT INTO users(id, email_normalized) VALUES (?, ?)',
    args: [adminId, 'owner@example.test'],
  });
  const config = loadServerConfig({
    AI_PROVIDER_ADMIN_EMAILS: 'owner@example.test',
    AI_PROVIDER_ENCRYPTION_KEY: encryptionKey,
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_key',
    WORKOS_CLIENT_ID: 'client_1234',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  });
  const authService = {
    async getSession({ token }) {
      if (token === 'admin-session') return { id: adminId, email: 'OWNER@example.test' };
      if (token === 'member-session') return { id: 'member-0000000001', email: 'member@example.test' };
      return null;
    },
  };
  const aiProviderService = createAiProviderService({ db, encryptionKey });

  try {
    await withServer(config, authService, aiProviderService, async (base) => {
      const endpoint = `${base}/api/admin/ai-providers`;
      const payload = {
        providerKey: 'route-test-provider',
        displayName: 'Route Test Provider',
        apiProtocol: 'openai_chat',
        baseUrl: 'https://api.provider.com/v1',
        modelId: 'test-model',
        apiKey: testApiKey,
      };
      const origin = base;

      const noOrigin = await fetch(endpoint, {
        method: 'POST',
        headers: { Cookie: 'kues_session=admin-session', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(noOrigin.status, 403);
      assert.deepEqual(await noOrigin.json(), { error: 'same_origin_required' });

      const noSession = await fetch(endpoint, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(noSession.status, 401);

      const member = await fetch(endpoint, {
        method: 'POST',
        headers: { Cookie: 'kues_session=member-session', Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(member.status, 403);
      assert.deepEqual(await member.json(), { error: 'ai_provider_admin_required' });

      const wrongOrigin = await fetch(endpoint, {
        method: 'POST',
        headers: { Cookie: 'kues_session=admin-session', Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(wrongOrigin.status, 403);

      const createdResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { Cookie: 'kues_session=admin-session', Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(createdResponse.status, 201);
      assert.equal(createdResponse.headers.get('cache-control'), 'no-store');
      const responseBody = await createdResponse.json();
      assert.equal(responseBody.provider.providerKey, 'route-test-provider');
      assert.equal(responseBody.provider.enabled, false);
      assert.equal(Object.hasOwn(responseBody.provider, 'apiKey'), false);
      assert.equal(JSON.stringify(responseBody).includes(testApiKey), false);

      const stored = await db.execute({
        sql: 'SELECT api_key_ciphertext FROM ai_providers WHERE provider_key = ?',
        args: ['route-test-provider'],
      });
      assert.notEqual(stored.rows[0].api_key_ciphertext, testApiKey);

      const methodNotAllowed = await fetch(endpoint, { headers: { Cookie: 'kues_session=admin-session' } });
      assert.equal(methodNotAllowed.status, 405);
      assert.equal(methodNotAllowed.headers.get('allow'), 'POST, OPTIONS');

      const runtimeDisabled = await aiProviderService.getProviderForRuntime({ providerKey: 'route-test-provider' })
        .then(() => null, (error) => error);
      assert.equal(runtimeDisabled.code, 'ai_provider_not_found');
    });
  } finally {
    await db.close();
  }
});
