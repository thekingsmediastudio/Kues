import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { AuthError, createAuthService } from '../../apps/web/lib/auth/service.mjs';
import { createWorkspaceService } from '../../apps/web/lib/workspaces/service.mjs';

const now = '2026-10-27T09:00:00.000Z';

async function createDb() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  return db;
}

test('account display name and theme persist and are returned in the authenticated session and workspace bootstrap', async () => {
  const db = await createDb();
  try {
    const auth = createAuthService({ db });
    const workspaces = createWorkspaceService({ db });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_settings_profile_1',
      email: 'settings-profile@example.test',
      emailVerified: true,
      displayName: 'Initial Name',
      now,
    });

    const profile = await auth.updateDisplayName({ userId: login.user.id, displayName: 'Changed Name', now });
    assert.equal(profile.displayName, 'Changed Name');
    assert.deepEqual(await auth.updateTheme({ userId: login.user.id, theme: 'light' }), { theme: 'light' });
    assert.deepEqual(await auth.updateTheme({ userId: login.user.id, theme: 'dark' }), { theme: 'dark' });
    await assert.rejects(auth.updateTheme({ userId: login.user.id, theme: 'system' }), (error) => error.code === 'invalid_theme');

    const sessionUser = await auth.getSession({ token: login.sessionToken, now });
    assert.equal(sessionUser.displayName, 'Changed Name');
    assert.equal(sessionUser.theme, 'dark');
    const bootstrap = await workspaces.getBootstrap({ userId: login.user.id, now });
    assert.equal(bootstrap.user.displayName, 'Changed Name');
    assert.equal(bootstrap.user.theme, 'dark');
  } finally {
    await db.close();
  }
});

test('pending email change is session-bound, rate-limited, and updates the account only after provider confirmation', async () => {
  const db = await createDb();
  try {
    const auth = createAuthService({ db });
    const owner = await auth.createWorkOSSession({
      providerSubject: 'workos_settings_email_owner',
      email: 'owner@example.test',
      emailVerified: true,
      now,
    });
    const other = await auth.createWorkOSSession({
      providerSubject: 'workos_settings_email_other',
      email: 'other@example.test',
      emailVerified: true,
      now,
    });
    const pending = await auth.reservePendingEmailChange({
      userId: owner.user.id,
      sessionToken: owner.sessionToken,
      newEmail: ' New.Owner@Example.test ',
      now,
    });
    assert.equal(pending.newEmail, 'new.owner@example.test');
    assert.equal((await auth.getSession({ token: owner.sessionToken, now })).email, 'owner@example.test');
    assert.equal(await auth.getPendingEmailChange({ userId: other.user.id, sessionToken: other.sessionToken, now }), null);
    assert.equal(await auth.getPendingEmailChange({ userId: owner.user.id, sessionToken: other.sessionToken, now }), null);

    const challenge = await db.execute({
      sql: 'SELECT new_email, session_token_hash, expires_at, failed_attempts FROM pending_email_changes WHERE user_id = ?',
      args: [owner.user.id],
    });
    assert.equal(challenge.rows.length, 1);
    assert.equal(challenge.rows[0].new_email, 'new.owner@example.test');
    assert.match(challenge.rows[0].session_token_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(challenge.rows[0].session_token_hash, owner.sessionToken);
    assert.equal(challenge.rows[0].failed_attempts, 0);

    await assert.rejects(
      auth.reservePendingEmailChange({
        userId: owner.user.id, sessionToken: owner.sessionToken,
        newEmail: 'other@example.test', now,
      }),
      (error) => error instanceof AuthError && error.code === 'email_unavailable' && error.status === 409,
    );
    assert.equal((await auth.getPendingEmailChange({ userId: owner.user.id, sessionToken: owner.sessionToken, now })).newEmail, pending.newEmail);

    const failure = await auth.recordPendingEmailChangeFailure({ userId: owner.user.id, sessionToken: owner.sessionToken, now });
    assert.equal(failure.attempts, 1);
    assert.equal((await auth.getPendingEmailChange({ userId: owner.user.id, sessionToken: owner.sessionToken, now })).failedAttempts, 1);

    const changed = await auth.completePendingEmailChange({
      userId: owner.user.id,
      providerSubject: 'workos_settings_email_owner',
      newEmail: 'new.owner@example.test',
      sessionToken: owner.sessionToken,
      now,
    });
    assert.equal(changed.email, 'new.owner@example.test');
    assert.equal((await auth.getSession({ token: owner.sessionToken, now })).email, 'new.owner@example.test');
    assert.equal(await auth.getPendingEmailChange({ userId: owner.user.id, sessionToken: owner.sessionToken, now }), null);

    const returning = await auth.createWorkOSSession({
      providerSubject: 'workos_settings_email_owner', email: 'new.owner@example.test', emailVerified: true, now,
    });
    assert.equal(returning.user.id, owner.user.id);
    assert.equal(returning.user.email, 'new.owner@example.test');
  } finally {
    await db.close();
  }
});

test('revoking a session also deletes its session-bound pending email change', async () => {
  const db = await createDb();
  try {
    const auth = createAuthService({ db });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_settings_revoke', email: 'revoke@example.test', emailVerified: true, now,
    });
    await auth.reservePendingEmailChange({
      userId: login.user.id, sessionToken: login.sessionToken, newEmail: 'new-revoke@example.test', now,
    });
    assert.deepEqual(await auth.revokeSession({ token: login.sessionToken, now }), { revoked: true });
    const pending = await db.execute('SELECT COUNT(*) AS count FROM pending_email_changes WHERE user_id = ?', [login.user.id]);
    assert.equal(Number(pending.rows[0].count), 0);
    assert.equal(await auth.getSession({ token: login.sessionToken, now }), null);
  } finally {
    await db.close();
  }
});

const onboardingInput = {
  name: 'Settings Scout',
  role: 'Commerce assistant',
  avatar: 'bulb',
  color: '#32d583',
  approvalPath: 'desktop',
  orderCap: 20,
  dailyCap: 100,
  apps: ['paypal'],
  memoryPills: ['Ask before publishing changes'],
};

async function withServer({ authService, workspaceService, workosAuth, config, sessionToken }, run) {
  const { createServer } = await import('../../apps/web/server.mjs');
  const { loadServerConfig } = await import('../../apps/web/lib/config.mjs');
  const server = createServer({
    config: config || loadServerConfig({
      AUTH_PROVIDER: 'workos',
      WORKOS_API_KEY: 'server-secret',
      WORKOS_CLIENT_ID: 'client-settings',
      WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
      TURSO_DATABASE_URL: 'file:./local.db',
    }),
    authService,
    workspaceService,
    workosAuth,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await run({ base, cookie: `kues_session=${sessionToken}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('authenticated Settings routes persist profile, theme, workspace and agent changes with same-origin protection', async () => {
  const db = await createDb();
  try {
    const auth = createAuthService({ db });
    const workspaces = createWorkspaceService({ db });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_settings_routes_1', email: 'settings-routes@example.test',
      emailVerified: true, displayName: 'Settings Owner', now,
    });
    const initial = await workspaces.completeOnboarding({ userId: login.user.id, input: onboardingInput, now });
    const agent = initial.agents[0];
    const workosCalls = [];
    const fakeWorkOS = {
      async reauthenticatePassword(input) { workosCalls.push(['reauthenticatePassword', input]); if (input.currentPassword !== 'current-good') throw new AuthError('invalid_credentials', 401); },
      async changePassword(input) { workosCalls.push(['changePassword', input]); return { passwordUpdated: true }; },
      async sendEmailChangeCode(input) { workosCalls.push(['sendEmailChangeCode', input]); return {}; },
      async confirmEmailChange(input) { workosCalls.push(['confirmEmailChange', input]); return { user: { id: input.userId, email: 'updated@example.test', emailVerified: true } }; },
    };

    await withServer({ authService: auth, workspaceService: workspaces, workosAuth: fakeWorkOS, sessionToken: login.sessionToken }, async ({ base, cookie }) => {
      const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', Accept: 'application/json' };
      const anonymous = await fetch(`${base}/api/settings/profile`, { method: 'PUT', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Intruder' }) });
      assert.equal(anonymous.status, 401);

      const foreignOrigin = await fetch(`${base}/api/settings/profile`, { method: 'PUT', headers: { ...headers, Origin: 'https://attacker.example' }, body: JSON.stringify({ displayName: 'Intruder' }) });
      assert.equal(foreignOrigin.status, 403);

      const profile = await fetch(`${base}/api/settings/profile`, { method: 'PUT', headers, body: JSON.stringify({ displayName: 'Saved Settings Owner' }) });
      assert.equal(profile.status, 200);
      assert.equal((await profile.json()).user.displayName, 'Saved Settings Owner');

      const theme = await fetch(`${base}/api/settings/theme`, { method: 'PUT', headers, body: JSON.stringify({ theme: 'light' }) });
      assert.equal(theme.status, 200);
      assert.equal((await theme.json()).theme, 'light');

      const workspace = await fetch(`${base}/api/settings/workspace`, { method: 'PUT', headers, body: JSON.stringify({ name: 'Operations Workspace' }) });
      assert.equal(workspace.status, 200);
      assert.equal((await workspace.json()).workspace.name, 'Operations Workspace');

      const agentUpdate = await fetch(`${base}/api/settings/agents/${encodeURIComponent(agent.id)}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ ...onboardingInput, name: 'Settings Scout Revised', apps: ['paypal', 'gmail'], memoryPills: ['Always ask before sending'] }),
      });
      assert.equal(agentUpdate.status, 200);
      const agentBody = await agentUpdate.json();
      assert.equal(agentBody.agents.find((item) => item.id === agent.id).name, 'Settings Scout Revised');
      assert.deepEqual(agentBody.agents.find((item) => item.id === agent.id).settings.apps, ['paypal', 'gmail']);
      assert.deepEqual(agentBody.agents.find((item) => item.id === agent.id).settings.memoryPills, ['Always ask before sending']);

      const invalidTheme = await fetch(`${base}/api/settings/theme`, { method: 'PUT', headers, body: JSON.stringify({ theme: 'system' }) });
      assert.equal(invalidTheme.status, 400);
      assert.deepEqual(await invalidTheme.json(), { error: 'invalid_theme' });

      const changedBootstrap = await fetch(`${base}/api/workspace/bootstrap`, { headers: { Cookie: cookie } });
      const bootstrapBody = await changedBootstrap.json();
      assert.equal(bootstrapBody.user.displayName, 'Saved Settings Owner');
      assert.equal(bootstrapBody.user.theme, 'light');
      assert.equal(bootstrapBody.workspace.name, 'Operations Workspace');
    });
    assert.deepEqual(workosCalls, []);
  } finally {
    await db.close();
  }
});

test('email change and password routes require re-authentication and keep provider calls mocked', async () => {
  const db = await createDb();
  try {
    const auth = createAuthService({ db });
    const workspaces = createWorkspaceService({ db });
    const login = await auth.createWorkOSSession({
      providerSubject: 'workos_settings_email_routes_1', email: 'original@example.test',
      emailVerified: true, displayName: 'Email Owner', now,
    });
    const workosCalls = [];
    const fakeWorkOS = {
      async reauthenticatePassword(input) {
        workosCalls.push(['reauthenticatePassword', input]);
        if (input.currentPassword !== 'correct horse') throw new AuthError('invalid_credentials', 401);
      },
      async changePassword(input) {
        workosCalls.push(['changePassword', input]);
        if (input.currentPassword !== 'correct horse') throw new AuthError('invalid_credentials', 401);
        return { passwordUpdated: true };
      },
      async sendEmailChangeCode(input) { workosCalls.push(['sendEmailChangeCode', input]); return {}; },
      async confirmEmailChange(input) {
        workosCalls.push(['confirmEmailChange', input]);
        return { user: { id: input.userId, email: 'updated@example.test', emailVerified: true } };
      },
    };

    await withServer({ authService: auth, workspaceService: workspaces, workosAuth: fakeWorkOS, sessionToken: login.sessionToken }, async ({ base, cookie }) => {
      const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', Accept: 'application/json' };
      const rejected = await fetch(`${base}/api/settings/email-change/start`, { method: 'POST', headers, body: JSON.stringify({ currentPassword: 'wrong', newEmail: 'updated@example.test' }) });
      assert.equal(rejected.status, 401);
      assert.deepEqual(await rejected.json(), { error: 'invalid_credentials' });
      assert.equal(workosCalls.some(([name]) => name === 'sendEmailChangeCode'), false);

      const started = await fetch(`${base}/api/settings/email-change/start`, { method: 'POST', headers, body: JSON.stringify({ currentPassword: 'correct horse', newEmail: 'updated@example.test' }) });
      assert.equal(started.status, 202);
      assert.equal((await started.json()).email, 'updated@example.test');
      assert.equal((await auth.getSession({ token: login.sessionToken })).email, 'original@example.test');
      assert.equal(workosCalls.filter(([name]) => name === 'sendEmailChangeCode').length, 1);

      const pending = await fetch(`${base}/api/settings/email-change`, { headers: { Cookie: cookie } });
      assert.equal(pending.status, 200);
      assert.equal((await pending.json()).pending.email, 'updated@example.test');

      const password = await fetch(`${base}/api/settings/password`, { method: 'PUT', headers, body: JSON.stringify({ currentPassword: 'correct horse', newPassword: 'a longer new password' }) });
      assert.equal(password.status, 200);
      assert.deepEqual(await password.json(), { passwordUpdated: true });
      const failedPassword = await fetch(`${base}/api/settings/password`, { method: 'PUT', headers, body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'a longer new password' }) });
      assert.equal(failedPassword.status, 401);

      const confirmed = await fetch(`${base}/api/settings/email-change/confirm`, { method: 'POST', headers, body: JSON.stringify({ code: '123456' }) });
      assert.equal(confirmed.status, 200);
      assert.equal((await confirmed.json()).user.email, 'updated@example.test');
      assert.equal((await auth.getSession({ token: login.sessionToken })).email, 'updated@example.test');

      const clearedPending = await fetch(`${base}/api/settings/email-change`, { headers: { Cookie: cookie } });
      assert.deepEqual(await clearedPending.json(), { pending: null });
    });
    assert.equal(workosCalls.filter(([name]) => name === 'reauthenticatePassword').length, 2);
    assert.equal(workosCalls.filter(([name]) => name === 'confirmEmailChange').length, 1);
  } finally {
    await db.close();
  }
});
