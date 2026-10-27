import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import { createServer } from '../../apps/web/server.mjs';

const encryptionKey = Buffer.alloc(32, 29).toString('base64');

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

test('AI provider admin form is private to an authenticated allowlisted admin', async () => {
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
      if (token === 'admin-session') return { id: 'admin-1', email: 'OWNER@example.test' };
      if (token === 'member-session') return { id: 'member-1', email: 'member@example.test' };
      return null;
    },
  };
  const aiProviderService = {};

  await withServer(config, authService, aiProviderService, async (base) => {
    const unauthenticated = await fetch(`${base}/admin/ai-providers`, { redirect: 'manual' });
    assert.equal(unauthenticated.status, 302);
    assert.equal(unauthenticated.headers.get('location'), '/login?auth_error=session');

    const member = await fetch(`${base}/admin/ai-providers`, {
      headers: { Cookie: 'kues_session=member-session' },
    });
    assert.equal(member.status, 403);
    assert.match(await member.text(), /AI provider administrator access required/);

    const admin = await fetch(`${base}/admin/ai-providers`, {
      headers: { Cookie: 'kues_session=admin-session' },
    });
    assert.equal(admin.status, 200);
    assert.match(admin.headers.get('content-security-policy') || '', /default-src 'none'/);
    assert.equal(admin.headers.get('x-robots-tag'), 'noindex, nofollow');
    const html = await admin.text();
    assert.match(html, /AI providers/);
    assert.match(html, /aria-label="Keus logo"/);
    assert.doesNotMatch(html, /brand-mark/);
    assert.match(html, /Configured providers/);
    assert.match(html, /name="apiKey"/);
    assert.match(html, /api\('\/api\/admin\/ai-providers'/);
    assert.match(html, /method:'PUT'/);
    assert.match(html, /method:'DELETE'/);
    assert.match(html, /type="password"/);
    assert.match(html, /credentials:'same-origin'/);
  });
});
