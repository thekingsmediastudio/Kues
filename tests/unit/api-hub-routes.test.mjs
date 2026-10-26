import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createApiHubService } from '../../apps/web/lib/api-hub/service.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import { createServer } from '../../apps/web/server.mjs';

const ownerId = 'route-owner-0000001';
const key = Buffer.alloc(32, 3).toString('base64');

async function withServer(config, authService, apiHubService, run) {
  const server = createServer({ config, authService, apiHubService });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('API Hub management is login/admin protected and agent routes use scoped bearer keys', async () => {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  await db.execute({ sql: 'INSERT INTO users(id, email_normalized) VALUES (?, ?)', args: [ownerId, 'owner@example.test'] });
  const config = loadServerConfig({
    API_HUB_ADMIN_EMAILS: 'owner@example.test',
    API_HUB_ENCRYPTION_KEY: key,
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_key',
    WORKOS_CLIENT_ID: 'client_1234',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  });
  const authService = {
    async getSession({ token }) {
      if (token === 'valid-session') return { id: ownerId, email: 'owner@example.test' };
      if (token === 'other-session') return { id: 'other-user-id', email: 'member@example.test' };
      return null;
    },
  };
  const apiHubService = createApiHubService({
    db,
    encryptionKey: key,
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, contentType: 'application/json', body: Buffer.from('{"ok":true}') }),
  });
  try {
    await withServer(config, authService, apiHubService, async (base) => {
      const noSessionPage = await fetch(`${base}/api-hub`, { redirect: 'manual' });
      assert.equal(noSessionPage.status, 302);
      assert.equal(noSessionPage.headers.get('location'), '/login?auth_error=session');

      const memberPage = await fetch(`${base}/api-hub`, {
        headers: { Cookie: 'kues_session=other-session' }, redirect: 'manual',
      });
      assert.equal(memberPage.status, 403);

      const adminPage = await fetch(`${base}/api-hub`, {
        headers: { Cookie: 'kues_session=valid-session' },
      });
      assert.equal(adminPage.status, 200);
      assert.match(adminPage.headers.get('content-security-policy') || '', /default-src 'none'/);
      assert.match(await adminPage.text(), /Connect APIs once/);

      const unauthorized = await fetch(`${base}/api/hub/admin/connectors`);
      assert.equal(unauthorized.status, 401);

      const cookie = 'kues_session=valid-session';
      const form = {
        name: 'Sample API', baseUrl: 'https://api.example.com/v1', authType: 'bearer', authSecret: 'a-secret-token',
        defaultHeaders: { Accept: 'application/json' },
        operations: [{ name: 'list-items', method: 'GET', path: '/items' }],
      };
      const noOrigin = await fetch(`${base}/api/hub/admin/connectors`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      assert.equal(noOrigin.status, 403);
      assert.deepEqual(await noOrigin.json(), { error: 'same_origin_required' });

      const origin = base;
      const createdResponse = await fetch(`${base}/api/hub/admin/connectors`, {
        method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      assert.equal(createdResponse.status, 201);
      const connector = (await createdResponse.json()).connector;
      assert.equal(connector.name, 'Sample API');
      assert.equal(JSON.stringify(connector).includes('a-secret-token'), false);

      const tokenResponse = await fetch(`${base}/api/hub/admin/tokens`, {
        method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'agent key', scopes: [`${connector.id}:list-items`], expiresInDays: 7 }),
      });
      assert.equal(tokenResponse.status, 201);
      const issued = (await tokenResponse.json()).token;
      assert.match(issued.token, /^khub_[A-Za-z0-9_-]{43}$/);

      const manifest = await fetch(`${base}/api/hub/manifest`, { headers: { Authorization: `Bearer ${issued.token}` } });
      assert.equal(manifest.status, 200);
      assert.equal((await manifest.json()).connectors[0].operations[0].name, 'list-items');

      const invocation = await fetch(`${base}/api/hub/invoke`, {
        method: 'POST', headers: { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId: connector.id, operation: 'list-items' }),
      });
      assert.equal(invocation.status, 200);
      assert.equal((await invocation.json()).upstreamStatus, 200);

      const wrongOrigin = await fetch(`${base}/api/hub/admin/connectors`, {
        method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      assert.equal(wrongOrigin.status, 403);
    });
  } finally {
    await db.close();
  }
});
