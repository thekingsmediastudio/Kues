import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAuthService } from '../../apps/web/lib/auth/service.mjs';
import { createWorkspaceService } from '../../apps/web/lib/workspaces/service.mjs';
import { createServer } from '../../apps/web/server.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';

const competition = Object.freeze({
  startAt: '2026-10-01T00:00:00.000Z',
  endAt: '2026-11-01T00:00:00.000Z',
  dailyTokenLimit: 25000,
});

async function createDb() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  return db;
}

const onboardingInput = {
  name: 'Mina Scout',
  role: 'Web & commerce scout',
  color: '#32d583',
  avatar: 'magnifier',
  approvalPath: 'desktop',
  orderCap: 85,
  dailyCap: 250,
  apps: [],
  memoryPills: ['Prefers concise comparisons'],
};

test('verified accounts receive one shared-DB default workspace, owner membership, and competition entitlement', async () => {
  const db = await createDb();
  try {
    const auth = createAuthService({ db, competition });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_signup_1',
      email: 'owner@example.test',
      emailVerified: true,
      displayName: 'Workspace Owner',
      now: '2026-10-26T09:00:00.000Z',
    });
    assert.equal(login.isNewUser, true);
    assert.equal(login.needsOnboarding, true);

    const rows = await db.execute(`
      SELECT w.id, w.owner_user_id, w.status, m.role, d.workspace_id
      FROM workspaces w
      JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = w.owner_user_id
      JOIN user_default_workspaces d ON d.user_id = w.owner_user_id
    `);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].owner_user_id, login.user.id);
    assert.equal(rows.rows[0].role, 'owner');
    assert.equal(rows.rows[0].status, 'active');
    assert.equal(rows.rows[0].id, rows.rows[0].workspace_id);

    const grants = await db.execute({
      sql: `SELECT e.source, e.starts_at, e.ends_at, p.included_tokens, p.code
            FROM entitlements e JOIN plans p ON p.id = e.plan_id
            WHERE e.workspace_id = ?`,
      args: [rows.rows[0].id],
    });
    assert.equal(grants.rows.length, 1);
    assert.equal(grants.rows[0].source, 'competition');
    assert.equal(Number(grants.rows[0].included_tokens), competition.dailyTokenLimit);
    assert.equal(grants.rows[0].code, 'keus_competition_daily');

    const secondLogin = await auth.createWorkOSSession({
      providerSubject: 'workos_signup_1',
      email: 'owner@example.test',
      emailVerified: true,
      now: '2026-10-26T09:30:00.000Z',
    });
    assert.equal(secondLogin.user.id, login.user.id);
    assert.equal(secondLogin.needsOnboarding, true);
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS count FROM workspaces')).rows[0].count), 1);
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS count FROM entitlements')).rows[0].count), 1);
  } finally {
    await db.close();
  }
});

test('onboarding is persisted in the owner workspace and returned from the shared database', async () => {
  const db = await createDb();
  try {
    const now = '2026-10-26T09:00:00.000Z';
    const auth = createAuthService({ db, competition });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_onboarding_1',
      email: 'onboarding@example.test',
      emailVerified: true,
      displayName: 'Onboarding Owner',
      now,
    });
    const workspaces = createWorkspaceService({ db, competition });
    const before = await workspaces.getBootstrap({ userId: login.user.id, now });
    assert.equal(before.workspace.role, 'owner');
    assert.equal(before.onboarding.status, 'not_started');
    assert.equal(before.usageAccess.state, 'competition_free');
    assert.equal(before.usageAccess.tokenLimit, competition.dailyTokenLimit);

    const saved = await workspaces.completeOnboarding({ userId: login.user.id, input: onboardingInput, now });
    assert.equal(saved.onboarding.status, 'completed');
    assert.equal(saved.onboarding.agent.status, 'paused');
    assert.equal(saved.onboarding.agent.name, onboardingInput.name);
    assert.equal(saved.onboarding.agent.settings.previewOnly, true);
    assert.equal(saved.onboarding.profile.agent.avatar, onboardingInput.avatar);
    assert.deepEqual(saved.onboarding.profile.memoryPills, onboardingInput.memoryPills);
    assert.equal(saved.onboarding.profile.payment.connected, false);
    assert.equal(saved.onboarding.profile.purchaseLimits.maxPerOrder.enforcement, 'preview_only');
    assert.equal(saved.onboarding.profile.purchaseLimits.dailyWorkspace.amount, onboardingInput.dailyCap);
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS count FROM spend_policies')).rows[0].count), 0);

    const reloaded = await workspaces.getBootstrap({ userId: login.user.id, now });
    assert.equal(reloaded.onboarding.status, 'completed');
    assert.deepEqual(reloaded.onboarding.profile, saved.onboarding.profile);
    assert.equal(reloaded.onboarding.agent.id, saved.onboarding.agent.id);
    assert.equal(reloaded.usageAccess.state, 'competition_free');

    const afterCompetition = await workspaces.getBootstrap({
      userId: login.user.id,
      now: competition.endAt,
    });
    assert.equal(afterCompetition.usageAccess.allowed, false);
    assert.equal(afterCompetition.usageAccess.state, 'subscription_required');
  } finally {
    await db.close();
  }
});

test('onboarding API requires a session and same-origin write, and persists data for the authenticated account', async () => {
  const db = await createDb();
  const now = new Date(Date.now() - 60_000).toISOString();
  try {
    const authService = createAuthService({ db });
    const workspaceService = createWorkspaceService({ db });
    const login = await authService.createWorkOSSession({
      providerSubject: 'workos_api_1',
      email: 'api-owner@example.test',
      emailVerified: true,
      displayName: 'API Owner',
      now,
    });
    const server = createServer({
      config: loadServerConfig({}),
      authService,
      workspaceService,
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const cookie = `kues_session=${login.sessionToken}`;
    try {
      const anonymous = await fetch(`${base}/api/workspace/bootstrap`);
      assert.equal(anonymous.status, 401);

      const initial = await fetch(`${base}/api/workspace/bootstrap`, { headers: { Cookie: cookie } });
      assert.equal(initial.status, 200);
      const initialBody = await initial.json();
      assert.equal(initialBody.user.id, login.user.id);
      assert.equal(initialBody.onboarding.status, 'not_started');

      const missingOrigin = await fetch(`${base}/api/onboarding/complete`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(onboardingInput),
      });
      assert.equal(missingOrigin.status, 403);
      assert.deepEqual(await missingOrigin.json(), { error: 'same_origin_required' });

      const foreignOrigin = await fetch(`${base}/api/onboarding/complete`, {
        method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify(onboardingInput),
      });
      assert.equal(foreignOrigin.status, 403);

      const saved = await fetch(`${base}/api/onboarding/complete`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...onboardingInput, workspaceId: 'attacker-selected-workspace' }),
      });
      assert.equal(saved.status, 200);
      const savedBody = await saved.json();
      assert.equal(savedBody.saved, true);
      assert.equal(savedBody.workspace.id, initialBody.workspace.id);
      assert.equal(savedBody.onboarding.status, 'completed');

      const reloaded = await fetch(`${base}/api/workspace/bootstrap`, { headers: { Cookie: cookie } });
      assert.equal(reloaded.status, 200);
      const reloadedBody = await reloaded.json();
      assert.equal(reloadedBody.onboarding.profile.agent.name, onboardingInput.name);
      assert.equal(reloadedBody.onboarding.agent.status, 'paused');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await db.close();
  }
});

test('onboarding rejects invalid values instead of writing ambiguous policy settings', async () => {
  const db = await createDb();
  try {
    const now = '2026-10-26T09:00:00.000Z';
    const auth = createAuthService({ db });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_invalid_onboarding',
      email: 'invalid-onboarding@example.test',
      emailVerified: true,
      now,
    });
    const workspaces = createWorkspaceService({ db });
    await assert.rejects(
      workspaces.completeOnboarding({
        userId: login.user.id,
        input: { ...onboardingInput, color: 'url(https://evil.example)' },
        now,
      }),
      (error) => error.code === 'invalid_agent_color',
    );
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS count FROM agents')).rows[0].count), 0);
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS count FROM workspace_onboarding WHERE status = \'completed\'')).rows[0].count), 0);
  } finally {
    await db.close();
  }
});
