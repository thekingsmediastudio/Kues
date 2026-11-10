import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { createServer } from '../../apps/web/server.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAuthService } from '../../apps/web/lib/auth/service.mjs';

async function withServer(authService, run) {
  const server = createServer({ config: loadServerConfig({}), authService });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function createDb() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  return db;
}

test('same-origin email auth endpoints set an HttpOnly session cookie without returning its token', async () => {
  const db = await createDb();
  const delivered = [];
  const authService = createAuthService({
    db,
    emailDelivery: { async sendMagicLink(message) { delivered.push(message); } },
  });
  try {
    await withServer(authService, async (base) => {
      const start = await fetch(`${base}/api/auth/email/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.test' }),
      });
      assert.equal(start.status, 202);
      assert.equal((await start.json()).accepted, true);
      assert.equal(delivered.length, 1);

      const consume = await fetch(`${base}/api/auth/email/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: delivered[0].token }),
      });
      assert.equal(consume.status, 200);
      const loginBody = await consume.json();
      assert.equal(loginBody.authenticated, true);
      assert.equal('sessionToken' in loginBody, false);
      const setCookie = consume.headers.get('set-cookie');
      assert.match(setCookie, /^kues_session=[^;]+;/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);
      const sessionCookie = setCookie.split(';', 1)[0];

      const session = await fetch(`${base}/api/auth/session`, { headers: { Cookie: sessionCookie } });
      assert.equal(session.status, 200);
      assert.equal((await session.json()).user.email, 'person@example.test');

      const logout = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

      const afterLogout = await fetch(`${base}/api/auth/session`, { headers: { Cookie: sessionCookie } });
      assert.deepEqual(await afterLogout.json(), { authenticated: false, user: null });
    });
  } finally {
    await db.close();
  }
});

test('auth endpoints report disabled storage and reject invalid or cross-origin requests', async () => {
  await withServer(null, async (base) => {
    const unavailable = await fetch(`${base}/api/auth/session`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'auth_storage_not_configured' });
  });

  const db = await createDb();
  const authService = createAuthService({ db });
  try {
    await withServer(authService, async (base) => {
      const wrongOrigin = await fetch(`${base}/api/auth/email/start`, {
        method: 'POST',
        headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.test' }),
      });
      assert.equal(wrongOrigin.status, 403);

      const malformed = await fetch(`${base}/api/auth/email/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), { error: 'invalid_json' });

      const noDelivery = await fetch(`${base}/api/auth/email/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.test' }),
      });
      assert.equal(noDelivery.status, 503);
      assert.deepEqual(await noDelivery.json(), { error: 'email_delivery_not_configured' });
    });
  } finally {
    await db.close();
  }
});

test('first sign-in over HTTP provisions a starter agent and points the browser at the desktop preview', async () => {
  const { createWorkspaceService } = await import('../../apps/web/lib/workspaces/service.mjs');
  const db = await createDb();
  const delivered = [];
  const authService = createAuthService({ db, emailDelivery: { async sendMagicLink(message) { delivered.push(message); } } });
  const workspaceService = createWorkspaceService({ db });
  const server = createServer({ config: loadServerConfig({}), db, authService, workspaceService });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/api/auth/email/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'fresh@example.test' }) });
    const consume = await fetch(`${base}/api/auth/email/consume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: delivered[0].token }) });
    assert.equal(consume.status, 200);
    const body = await consume.json();
    assert.equal(body.redirect, '/desktop-preview');
    assert.equal(body.needsOnboarding, true, 'onboarding stays available; it is no longer a gate');
    const cookie = consume.headers.get('set-cookie').split(';', 1)[0];
    const bootstrap = await (await fetch(`${base}/api/workspace/bootstrap`, { headers: { Cookie: cookie } })).json();
    assert.equal(bootstrap.agents.length, 1);
    assert.equal(bootstrap.agents[0].name, 'Scout');
    assert.equal(bootstrap.agents[0].status, 'active');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  }
});
