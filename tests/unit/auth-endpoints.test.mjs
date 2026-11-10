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

test('first sign-in over HTTP provisions a starter agent and points the browser at onboarding', async () => {
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
    assert.equal(body.redirect, '/onboarding', 'first session of a brand-new account starts in onboarding');
    assert.equal(body.needsOnboarding, true);
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

test('allowlisted admin sign-in lands on onboarding and may re-run it to add an agent; everyone else lands on the preview', async () => {
  const { createWorkspaceService } = await import('../../apps/web/lib/workspaces/service.mjs');
  const db = await createDb();
  const delivered = [];
  const authService = createAuthService({ db, emailDelivery: { async sendMagicLink(message) { delivered.push(message); } } });
  const workspaceService = createWorkspaceService({ db });
  const config = loadServerConfig({
    AI_PROVIDER_ADMIN_EMAILS: 'admin@example.test',
    AI_PROVIDER_ENCRYPTION_KEY: 'a'.repeat(64),
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_key',
    WORKOS_CLIENT_ID: 'client_1234',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  });
  // Magic-link routes are retired under workos; exercise the destination logic through a brevo-style config too.
  const plainConfig = loadServerConfig({});
  const serverFor = (cfg) => createServer({ config: cfg, db, authService, workspaceService });
  const signIn = async (base, email) => {
    delivered.length = 0;
    await fetch(`${base}/api/auth/email/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const consume = await fetch(`${base}/api/auth/email/consume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: delivered[0].token }) });
    assert.equal(consume.status, 200);
    return { body: await consume.json(), cookie: consume.headers.get('set-cookie').split(';', 1)[0] };
  };
  const plain = serverFor(plainConfig);
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  const plainBase = `http://127.0.0.1:${plain.address().port}`;
  try {
    const regular = await signIn(plainBase, 'member@example.test');
    assert.equal(regular.body.isNewUser, true);
    assert.equal(regular.body.redirect, '/onboarding', 'a brand-new account is taken through onboarding once');
    const returning = await signIn(plainBase, 'member@example.test');
    assert.equal(returning.body.isNewUser, false);
    assert.equal(returning.body.redirect, '/desktop-preview', 'returning accounts land in the workspace even if onboarding was skipped');
    const admin = await signIn(plainBase, 'admin@example.test');
    assert.equal(admin.body.redirect, '/onboarding', 'new account; without an allowlist nobody is a reviewer');
    assert.equal((await signIn(plainBase, 'admin@example.test')).body.redirect, '/desktop-preview');
  } finally {
    await new Promise((resolve) => plain.close(resolve));
  }
  // Destination with the allowlist active, checked through the shared helper via the bootstrap flag and sign-in response.
  const { signInDestinationForTest } = await import('../../apps/web/server.mjs').then((m) => ({ signInDestinationForTest: m.signInDestinationForTest }));
  assert.equal(signInDestinationForTest(config, { email: 'Admin@Example.test' }), '/onboarding');
  assert.equal(signInDestinationForTest(config, { email: 'member@example.test' }), '/desktop-preview');
  assert.equal(signInDestinationForTest(config, { email: 'member@example.test' }, { isNewUser: true }), '/onboarding');
  assert.equal(signInDestinationForTest(config, { email: 'member@example.test' }, { isNewUser: false, needsOnboarding: true }), '/desktop-preview', 'skipped onboarding is not re-forced');
  assert.equal(signInDestinationForTest(config, null), '/desktop-preview');
  const configured = serverFor(config);
  await new Promise((resolve) => configured.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${configured.address().port}`;
  try {
    // Sessions created above remain valid; reuse the admin cookie against the allowlisted server.
    const adminSession = await authService.createWorkOSSession({ providerSubject: 'admin_ws', email: 'admin@example.test', emailVerified: true });
    const cookie = `kues_session=${adminSession.sessionToken}`;
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
    const before = await (await fetch(`${base}/api/workspace/bootstrap`, { headers: { Cookie: cookie } })).json();
    assert.equal(before.onboardingRerunAllowed, true);
    assert.equal(before.agents.length, 1, 'the earlier HTTP sign-in already provisioned Scout for this account');
    assert.equal(before.onboarding.status, 'not_started');
    const input = { name: 'Scout', role: 'Web & commerce scout', color: '#32d583', avatar: 'bulb', approvalPath: 'desktop', orderCap: 85, dailyCap: 250, apps: [], memoryPills: [] };
    const first = await fetch(`${base}/api/onboarding/complete`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(first.status, 200);
    const completed = await first.json();
    assert.equal(completed.onboarding.status, 'completed');
    assert.equal(completed.agents.length, 1, 'first completion customizes the starter agent in place');
    assert.equal(completed.agents[0].id, before.agents[0].id);
    // Second pass (what the page does once setup is complete): add a distinct agent, never overwrite.
    const added = await fetch(`${base}/api/workspace/agents`, { method: 'POST', headers, body: JSON.stringify({ ...input, name: 'Reviewer Bot' }) });
    assert.equal(added.status, 201);
    const addedBody = await added.json();
    assert.equal(addedBody.agents.length, 2);
    assert.deepEqual(addedBody.agents.map((a) => a.name).sort(), ['Reviewer Bot', 'Scout']);
    const conflict = await fetch(`${base}/api/workspace/agents`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'agent_name_conflict');
    const member = await (await fetch(`${base}/api/workspace/bootstrap`, { headers: { Cookie: `kues_session=${(await authService.createWorkOSSession({ providerSubject: 'member_ws', email: 'member2@example.test', emailVerified: true })).sessionToken}` } })).json();
    assert.equal(member.onboardingRerunAllowed, false);
  } finally {
    await new Promise((resolve) => configured.close(resolve));
    await db.close();
  }
});
