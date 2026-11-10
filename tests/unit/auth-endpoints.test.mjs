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
    assert.equal(returning.body.redirect, '/workspace', 'returning accounts land in the workspace even if onboarding was skipped');
    const admin = await signIn(plainBase, 'admin@example.test');
    assert.equal(admin.body.redirect, '/onboarding', 'new account; without an allowlist nobody is a reviewer');
    assert.equal((await signIn(plainBase, 'admin@example.test')).body.redirect, '/workspace');
  } finally {
    await new Promise((resolve) => plain.close(resolve));
  }
  // Destination with the allowlist active, checked through the shared helper via the bootstrap flag and sign-in response.
  const { signInDestinationForTest } = await import('../../apps/web/server.mjs').then((m) => ({ signInDestinationForTest: m.signInDestinationForTest }));
  assert.equal(signInDestinationForTest(config, { email: 'Admin@Example.test' }), '/onboarding');
  assert.equal(signInDestinationForTest(config, { email: 'member@example.test' }), '/workspace');
  assert.equal(signInDestinationForTest(config, { email: 'member@example.test' }, { isNewUser: true }), '/onboarding');
  assert.equal(signInDestinationForTest(config, { email: 'member@example.test' }, { isNewUser: false, needsOnboarding: true }), '/workspace', 'skipped onboarding is not re-forced');
  assert.equal(signInDestinationForTest(config, null), '/workspace');
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

test('demo fast lane: private workspace per click, no PayPal, rate limited per visitor, shared fallback at the daily cap', async () => {
  const { createWorkspaceService } = await import('../../apps/web/lib/workspaces/service.mjs');
  const { judgeFastlaneForTest } = await import('../../apps/web/server.mjs');
  async function boot(env = {}) {
    const db = await createDb();
    const authService = createAuthService({ db, emailDelivery: { async sendMagicLink() {} } });
    const workspaceService = createWorkspaceService({ db });
    const server = createServer({ config: loadServerConfig(env), authService, workspaceService, db });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { db, server, base: `http://127.0.0.1:${server.address().port}`, workspaceService };
  }
  const click = (base, headers = {}) => fetch(`${base}/api/auth/demo-fastlane`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
  });

  judgeFastlaneForTest.demoLimiter.reset();
  let { db, server, base, workspaceService } = await boot();
  try {
    const bodies = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await click(base, { 'X-Forwarded-For': '203.0.113.10' });
      assert.equal(res.status, 200, `attempt ${attempt}`);
      const body = await res.json();
      assert.equal(body.authenticated, true);
      assert.equal(body.redirect, '/workspace');
      assert.equal(body.privateDemo, true);
      assert.match(body.demoWorkspaceId, /^[0-9a-f]{10}$/);
      assert.match(body.user.email, /^demo-[0-9a-f]{10}@judges\.keus\.sandbox$/);
      assert.equal(body.user.displayName ?? body.user.display_name ?? body.user.name, 'PayPal Hackathon Judge');
      body.cookie = res.headers.get('set-cookie').match(/kues_session=([^;]+)/)[1];
      bodies.push(body);
    }
    // Two clicks, two isolated users, each with its own provisioned starter agent.
    assert.notEqual(bodies[0].user.id, bodies[1].user.id);
    const users = await db.execute("SELECT id FROM users WHERE email_normalized LIKE 'demo-%@judges.keus.sandbox'");
    assert.equal(users.rows.length, 2);
    for (const body of bodies) {
      const bootstrap = await workspaceService.getBootstrap({ userId: body.user.id });
      assert.equal(bootstrap.agents.length, 1);
      assert.equal(bootstrap.agents[0].name, 'Procure Scout');
      const onboarding = await db.execute({ sql: 'SELECT status FROM workspace_onboarding WHERE workspace_id = ?', args: [bootstrap.workspace.id] });
      assert.equal(onboarding.rows[0]?.status, 'completed');
    }
    // No shared identity was created on the private path.
    const shared = await db.execute("SELECT id FROM users WHERE email_normalized = 'judge@paypal.sandbox'");
    assert.equal(shared.rows.length, 0);
    // Private demo identities are blocked from PayPal checkout and wallet, like the shared one.
    const checkout = await fetch(`${base}/api/commerce/paypal/checkout`, { headers: { Cookie: `kues_session=${bodies[0].cookie}` } });
    assert.equal(checkout.status, 403);
    assert.equal((await checkout.json()).error, 'checkout_personal_account_required');
    const wallet = await fetch(`${base}/api/commerce/paypal/wallet`, { headers: { Cookie: `kues_session=${bodies[0].cookie}` } });
    assert.equal(wallet.status, 403);
    assert.equal((await wallet.json()).error, 'wallet_personal_account_required');
    // Per-visitor limit keyed on the proxy-supplied client address: 6 per window, other visitors unaffected.
    for (let i = 0; i < 4; i += 1) assert.equal((await click(base, { 'X-Forwarded-For': '203.0.113.10' })).status, 200);
    const limited = await click(base, { 'X-Forwarded-For': '203.0.113.10' });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'demo_fastlane_rate_limited');
    assert.equal((await click(base, { 'X-Forwarded-For': '198.51.100.7, 203.0.113.99' })).status, 200);
    assert.equal(judgeFastlaneForTest.clientAddress({ headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.99' }, socket: { remoteAddress: '10.0.0.1' } }), '203.0.113.99');
    assert.equal(judgeFastlaneForTest.clientAddress({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // Daily cap reached: degrade to the single shared demo identity, provisioned once, still no PayPal.
  judgeFastlaneForTest.demoLimiter.reset();
  ({ db, server, base, workspaceService } = await boot({ DEMO_FASTLANE_DAILY_CAP: '1' }));
  try {
    const first = await (await click(base)).json();
    assert.equal(first.privateDemo, true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await click(base);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.privateDemo, false);
      assert.equal(body.demoWorkspaceId, null);
      assert.equal(body.user.email, 'judge@paypal.sandbox');
    }
    const users = await db.execute("SELECT id FROM users WHERE email_normalized = 'judge@paypal.sandbox'");
    assert.equal(users.rows.length, 1);
    const bootstrap = await workspaceService.getBootstrap({ userId: users.rows[0].id });
    assert.equal(bootstrap.agents.length, 1);
    assert.equal(bootstrap.agents[0].name, 'Procure Scout');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('personal judge fast lane: code-gated, isolated accounts with checkout allowed, capped and rate limited', async () => {
  const { createWorkspaceService } = await import('../../apps/web/lib/workspaces/service.mjs');
  const { judgeFastlaneForTest } = await import('../../apps/web/server.mjs');
  async function boot(env) {
    const db = await createDb();
    const authService = createAuthService({ db, emailDelivery: { async sendMagicLink() {} } });
    const workspaceService = createWorkspaceService({ db });
    const server = createServer({ config: loadServerConfig(env), authService, workspaceService, db });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { db, server, base: `http://127.0.0.1:${server.address().port}` };
  }
  const post = (base, body, headers = {}) => fetch(`${base}/api/auth/judge-fastlane`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body),
  });

  // Disabled when no code is configured: endpoint is invisible and config says so.
  const off = await boot({});
  try {
    assert.equal((await post(off.base, { code: 'anything' })).status, 404);
    const cfg = await (await fetch(`${off.base}/api/auth/config`)).json();
    assert.equal(cfg.judgeFastlaneEnabled, false);
  } finally { await new Promise((r) => off.server.close(r)); }

  judgeFastlaneForTest.limiter.reset();
  const on = await boot({ JUDGE_ACCESS_CODE: 'KEUS-JUDGE-TEST-2026', JUDGE_FASTLANE_MAX_ACCOUNTS: '2' });
  try {
    const cfg = await (await fetch(`${on.base}/api/auth/config`)).json();
    assert.equal(cfg.judgeFastlaneEnabled, true);
    assert.equal((await post(on.base, { code: 'wrong-code' })).status, 403);
    assert.equal((await post(on.base, {})).status, 403);

    const first = await post(on.base, { code: 'KEUS-JUDGE-TEST-2026' });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.authenticated, true);
    assert.match(firstBody.judgeWorkspaceId, /^[0-9a-f]{10}$/);
    assert.equal(firstBody.redirect, `/workspace?judge=${firstBody.judgeWorkspaceId}`);
    assert.equal(firstBody.user.email, `judge-${firstBody.judgeWorkspaceId}@judges.keus.sandbox`);
    const firstCookie = first.headers.get('set-cookie').split(';', 1)[0];

    // Returning with code + workspace ID signs back into the same account (no new account minted).
    const back = await post(on.base, { code: 'KEUS-JUDGE-TEST-2026', workspaceId: firstBody.judgeWorkspaceId.toUpperCase() });
    assert.equal(back.status, 200);
    const backBody = await back.json();
    assert.equal(backBody.resumed, true);
    assert.equal(backBody.user.id, firstBody.user.id);
    assert.equal(backBody.redirect, '/workspace');
    const unknown = await post(on.base, { code: 'KEUS-JUDGE-TEST-2026', workspaceId: '0123456789' });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'judge_workspace_not_found');
    // Workspace ID without the code never works.
    assert.equal((await post(on.base, { code: 'wrong', workspaceId: firstBody.judgeWorkspaceId })).status, 403);

    const second = await post(on.base, { code: 'KEUS-JUDGE-TEST-2026' });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.notEqual(secondBody.user.id, firstBody.user.id, 'each click mints an isolated account');

    // Not the shared judge identity, so the checkout surface is reachable (list is empty, not 403).
    const checkout = await fetch(`${on.base}/api/commerce/paypal/checkout`, { headers: { Cookie: firstCookie } });
    assert.notEqual(checkout.status, 403);
    assert.notEqual((await checkout.json()).error, 'checkout_personal_account_required');

    // Provisioned like a finished onboarding: starter agent present, onboarding complete, lands on workspace.
    const ws = createWorkspaceService({ db: on.db });
    const bootstrap = await ws.getBootstrap({ userId: firstBody.user.id });
    assert.equal(bootstrap.agents.length, 1);
    assert.equal(bootstrap.agents[0].name, 'Scout');
    assert.equal(bootstrap.onboarding.status, 'completed');
    const page = await fetch(`${on.base}/workspace`, { headers: { Cookie: firstCookie }, redirect: 'manual' });
    assert.equal(page.status, 200);

    // Cap reached → 409 with a human message; shared identity count is not affected.
    const third = await post(on.base, { code: 'KEUS-JUDGE-TEST-2026' });
    assert.equal(third.status, 409);
    assert.equal((await third.json()).error, 'judge_fastlane_capacity_reached');

    // Rate limit: 10 attempts per IP per 10 minutes (8 used above).
    for (let i = 0; i < 2; i += 1) await post(on.base, { code: 'nope' });
    assert.equal((await post(on.base, { code: 'nope' })).status, 429);
  } finally {
    judgeFastlaneForTest.limiter.reset();
    await new Promise((r) => on.server.close(r));
  }
});
