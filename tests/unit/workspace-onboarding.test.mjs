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

test('established workspace bootstrap stays on a read snapshot and repairs incomplete first-login state through the writer', async () => {
  const db = await createDb();
  const transactionModes = [];
  const observedDb = {
    transaction(mode) {
      transactionModes.push(mode);
      return db.transaction(mode);
    },
  };
  const now = '2026-10-26T09:00:00.000Z';
  try {
    const auth = createAuthService({ db, competition });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_fast_bootstrap_1',
      email: 'fast-bootstrap@example.test',
      emailVerified: true,
      displayName: 'Fast Bootstrap Owner',
      now,
    });
    const workspaces = createWorkspaceService({ db: observedDb, competition });

    const ready = await workspaces.getBootstrap({ userId: login.user.id, now });
    assert.equal(ready.workspace.role, 'owner');
    assert.deepEqual(transactionModes, ['read'], 'a fully provisioned workspace does not enter the write queue');

    await workspaces.completeOnboarding({ userId: login.user.id, input: onboardingInput, now });
    const secondLogin = await auth.createWorkOSSession({
      providerSubject: 'workos_fast_bootstrap_2',
      email: 'other-fast-bootstrap@example.test',
      emailVerified: true,
      displayName: 'Second Owner',
      now,
    });
    transactionModes.length = 0;
    const secondBootstrap = await workspaces.getBootstrap({ userId: secondLogin.user.id, now });
    assert.notEqual(secondBootstrap.workspace.id, ready.workspace.id);
    assert.deepEqual(secondBootstrap.agents, [], 'the read fast path returns only the signed-in account workspace agents');
    assert.deepEqual(transactionModes, ['read']);

    await db.execute({
      sql: "DELETE FROM entitlements WHERE workspace_id = ? AND source = 'competition'",
      args: [secondBootstrap.workspace.id],
    });
    transactionModes.length = 0;
    const entitlementRepaired = await workspaces.getBootstrap({ userId: secondLogin.user.id, now });
    assert.equal(entitlementRepaired.usageAccess.state, 'competition_free');
    assert.deepEqual(transactionModes, ['read', 'write'], 'missing active competition provisioning uses the repair path');

    await db.execute({
      sql: 'DELETE FROM workspace_onboarding WHERE workspace_id = ?',
      args: [ready.workspace.id],
    });
    transactionModes.length = 0;
    const repaired = await workspaces.getBootstrap({ userId: login.user.id, now });
    assert.equal(repaired.onboarding.status, 'not_started');
    assert.deepEqual(transactionModes, ['read', 'write'], 'missing first-login state falls back to provisioning');
  } finally {
    await db.close();
  }
});

test('completed onboarding stays linked to the same workspace on a new WorkOS identity with the same email', async () => {
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
    assert.equal(before.usageAccess.quotaScope, 'account');

    const saved = await workspaces.completeOnboarding({ userId: login.user.id, input: onboardingInput, now });
    assert.equal(saved.onboarding.status, 'completed');
    assert.equal(saved.onboarding.agent.status, 'active');
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

    const googleLogin = await auth.createWorkOSSession({
      providerSubject: 'workos_google_identity_1',
      email: 'onboarding@example.test',
      emailVerified: true,
      now: '2026-10-26T09:30:00.000Z',
    });
    assert.equal(googleLogin.user.id, login.user.id);
    assert.equal(googleLogin.isNewUser, false);
    assert.equal(googleLogin.needsOnboarding, false);
    const googleBootstrap = await workspaces.getBootstrap({ userId: googleLogin.user.id, now });
    assert.equal(googleBootstrap.workspace.id, saved.workspace.id);
    assert.equal(googleBootstrap.onboarding.status, 'completed');
    assert.equal(googleBootstrap.onboarding.agent.id, saved.onboarding.agent.id);

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

test('recompleting onboarding keeps an existing paused agent paused when the default changes', async () => {
  const db = await createDb();
  const now = '2026-10-26T09:00:00.000Z';
  try {
    const auth = createAuthService({ db, competition });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_existing_paused_1',
      email: 'existing-paused@example.test',
      emailVerified: true,
      displayName: 'Existing Agent Owner',
      now,
    });
    const workspaces = createWorkspaceService({ db, competition });
    const created = await workspaces.completeOnboarding({ userId: login.user.id, input: onboardingInput, now });
    assert.equal(created.onboarding.agent.status, 'active');

    await db.execute({
      sql: "UPDATE agents SET status = 'paused' WHERE id = ?",
      args: [created.onboarding.agent.id],
    });
    const completedAgain = await workspaces.completeOnboarding({ userId: login.user.id, input: onboardingInput, now });
    assert.equal(completedAgain.onboarding.agent.status, 'paused', 'the new default does not reactivate an existing paused agent');
  } finally {
    await db.close();
  }
});

test('additional agents are persisted in the same workspace, returned in bootstrap, and start active', async () => {
  const db = await createDb();
  const now = '2026-10-26T09:00:00.000Z';
  try {
    const auth = createAuthService({ db, competition });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_create_agent_1',
      email: 'create-agent@example.test',
      emailVerified: true,
      displayName: 'Agent Owner',
      now,
    });
    const workspaces = createWorkspaceService({ db, competition });
    const original = await workspaces.completeOnboarding({ userId: login.user.id, input: onboardingInput, now });
    const input = {
      ...onboardingInput,
      name: 'Supply Scout',
      role: 'Compare supplier options',
      avatar: 'cart',
      color: '#4c8dff',
      approvalPath: 'keyfob',
      orderCap: 150,
      dailyCap: 500,
      apps: ['Shopify', 'Amazon'],
      memoryPills: ['Prefer local suppliers', 'Ask before substitutions'],
    };

    const saved = await workspaces.createAgent({ userId: login.user.id, input, now });
    assert.match(saved.createdAgentId, /^agt_[0-9a-f]{32}$/);
    assert.equal(saved.workspace.id, original.workspace.id);
    assert.equal(saved.onboarding.agent.id, original.onboarding.agent.id);
    assert.equal(saved.agents.length, 2);
    const created = saved.agents.find((agent) => agent.id === saved.createdAgentId);
    assert.ok(created);
    assert.equal(created.name, input.name);
    assert.equal(created.role, input.role);
    assert.equal(created.avatar, input.avatar);
    assert.equal(created.status, 'active');
    assert.equal(created.settings.color, input.color);
    assert.equal(created.settings.approvalPath, input.approvalPath);
    assert.equal(created.settings.orderCap, input.orderCap);
    assert.equal(created.settings.dailyCap, input.dailyCap);
    assert.deepEqual(created.settings.apps, input.apps);
    assert.deepEqual(created.settings.memoryPills, input.memoryPills);
    assert.equal(created.settings.previewOnly, true);
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS count FROM agents')).rows[0].count), 2);

    const reloaded = await workspaces.getBootstrap({ userId: login.user.id, now });
    assert.equal(reloaded.agents.length, 2);
    assert.equal(reloaded.agents.find((agent) => agent.id === saved.createdAgentId).status, 'active');
    await assert.rejects(
      workspaces.createAgent({ userId: login.user.id, input: { ...input, name: 'supply scout' }, now }),
      (error) => error.code === 'agent_name_conflict' && error.status === 409,
    );
    await assert.rejects(
      workspaces.createAgent({ userId: login.user.id, input: { ...input, memoryPills: [''] }, now }),
      (error) => error.code === 'invalid_memory_pills' && error.status === 400,
    );
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS count FROM agents')).rows[0].count), 2);
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
      assert.equal(reloadedBody.onboarding.agent.status, 'active');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await db.close();
  }
});

test('agent creation API is same-origin and authenticated, persists settings, and rejects duplicate names', async () => {
  const db = await createDb();
  const now = new Date(Date.now() - 60_000).toISOString();
  try {
    const authService = createAuthService({ db });
    const workspaceService = createWorkspaceService({ db });
    const login = await authService.createWorkOSSession({
      providerSubject: 'workos_create_agent_api_1',
      email: 'create-agent-api@example.test',
      emailVerified: true,
      displayName: 'Agent API Owner',
      now,
    });
    const server = createServer({ config: loadServerConfig({}), authService, workspaceService });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const cookie = `kues_session=${login.sessionToken}`;
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
    try {
      const anonymous = await fetch(`${base}/api/workspace/agents`, {
        method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify(onboardingInput),
      });
      assert.equal(anonymous.status, 401);
      assert.deepEqual(await anonymous.json(), { error: 'authentication_required' });

      const missingOrigin = await fetch(`${base}/api/workspace/agents`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(onboardingInput),
      });
      assert.equal(missingOrigin.status, 403);
      assert.deepEqual(await missingOrigin.json(), { error: 'same_origin_required' });

      const foreignOrigin = await fetch(`${base}/api/workspace/agents`, {
        method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' },
        body: JSON.stringify(onboardingInput),
      });
      assert.equal(foreignOrigin.status, 403);

      const initial = await fetch(`${base}/api/workspace/bootstrap`, { headers: { Cookie: cookie } });
      assert.equal(initial.status, 200);
      const initialBody = await initial.json();
      assert.equal(initialBody.agents.length, 0);

      const input = {
        ...onboardingInput,
        name: 'Inventory Helper',
        apps: ['Shopify'],
        memoryPills: ['Ask before changing inventory'],
        workspaceId: 'attacker-selected-workspace',
        userId: 'attacker-selected-user',
      };
      const created = await fetch(`${base}/api/workspace/agents`, {
        method: 'POST', headers,
        body: JSON.stringify(input),
      });
      assert.equal(created.status, 201);
      const createdBody = await created.json();
      assert.equal(createdBody.created, true);
      assert.equal(createdBody.user.id, login.user.id);
      assert.equal(createdBody.agents.length, 1);
      assert.equal(createdBody.createdAgentId, createdBody.agents[0].id);
      assert.equal(createdBody.agents[0].name, input.name);
      assert.equal(createdBody.agents[0].status, 'active');
      assert.deepEqual(createdBody.agents[0].settings.apps, input.apps);
      assert.deepEqual(createdBody.agents[0].settings.memoryPills, input.memoryPills);
      assert.equal(createdBody.agents[0].settings.previewOnly, true);
      assert.equal(createdBody.workspace.id, initialBody.workspace.id);

      const duplicate = await fetch(`${base}/api/workspace/agents`, {
        method: 'POST', headers,
        body: JSON.stringify({ ...input, name: 'inventory helper' }),
      });
      assert.equal(duplicate.status, 409);
      assert.deepEqual(await duplicate.json(), { error: 'agent_name_conflict' });

      const invalid = await fetch(`${base}/api/workspace/agents`, {
        method: 'POST', headers,
        body: JSON.stringify({ ...onboardingInput, name: 'Invalid Assistant', avatar: 'robot' }),
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), { error: 'invalid_agent_avatar' });

      const reloaded = await fetch(`${base}/api/workspace/bootstrap`, { headers: { Cookie: cookie } });
      assert.equal(reloaded.status, 200);
      const reloadedBody = await reloaded.json();
      assert.equal(reloadedBody.agents.length, 1);
      assert.equal(reloadedBody.agents[0].id, createdBody.createdAgentId);
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

test('agent instructions and tool preferences persist independently and cannot edit another account', async () => {
 const db=await createDb(); const now='2026-10-26T09:00:00.000Z';
 try {
  const auth=createAuthService({db,competition}); const ws=createWorkspaceService({db,competition});
  const login=await auth.createWorkOSSession({providerSubject:'agent_ext_owner',email:'agent-ext@example.test',emailVerified:true,displayName:'Owner',now});
  const initial=await ws.completeOnboarding({userId:login.user.id,input:onboardingInput,now});
  const a=initial.agents[0].id;
  const second=await ws.createAgent({userId:login.user.id,input:{...onboardingInput,name:'Second agent'},now}); const b=second.createdAgentId;
  const saved=await ws.updateAgent({userId:login.user.id,agentId:a,input:{...onboardingInput,instructions:'Use concise comparisons.',toolPermissions:{web_search:true,read_files:true}},now});
  assert.equal(saved.agents.find(x=>x.id===a).settings.instructions,'Use concise comparisons.');
  assert.equal(saved.agents.find(x=>x.id===a).settings.toolPermissions.web_search,true);
  assert.equal(saved.agents.find(x=>x.id===b).settings.toolPermissions.web_search,false);
  const oldClient=await ws.updateAgent({userId:login.user.id,agentId:a,input:{...onboardingInput,role:'Updated role'},now});
  assert.equal(oldClient.agents.find(x=>x.id===a).settings.toolPermissions.web_search,true);
  assert.equal(oldClient.agents.find(x=>x.id===a).settings.instructions,'Use concise comparisons.');
  await assert.rejects(ws.updateAgent({userId:login.user.id,agentId:a,input:{...onboardingInput,toolPermissions:{send_email:true}},now}),e=>e.code==='invalid_agent_tool_permissions');
  const other=await auth.createWorkOSSession({providerSubject:'agent_ext_other',email:'other-agent-ext@example.test',emailVerified:true,displayName:'Other',now});
  await assert.rejects(ws.updateAgent({userId:other.user.id,agentId:a,input:{...onboardingInput,instructions:'Cross-account overwrite'},now}),e=>e.code==='agent_not_found');
  const cleared=await ws.updateAgent({userId:login.user.id,agentId:a,input:{...onboardingInput,instructions:'',toolPermissions:{}},now});
  assert.equal(cleared.agents.find(x=>x.id===a).settings.instructions,'');
  assert.equal(cleared.agents.find(x=>x.id===a).settings.toolPermissions.web_search,false);
 } finally { db.close(); }
});
