import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../apps/web/server.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';

const config = loadServerConfig({
  AUTH_PROVIDER: 'workos',
  WORKOS_API_KEY: 'server-secret',
  WORKOS_CLIENT_ID: 'client-kues',
  WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
  TURSO_DATABASE_URL: 'file:./local.db',
});

async function withServer({
  authService,
  workosAuth,
  workspaceService = null,
  db = null,
  serverConfig = config,
  signInOnlyPreview = false,
}, run) {
  const server = createServer({
    config: serverConfig,
    authService,
    workosAuth,
    workspaceService,
    db,
    signInOnlyPreview,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('WorkOS browser flow uses HttpOnly state cookie, validates callback, and issues local session', async () => {
  let completed;
  const authService = {
    async getSession({ token }) { return token === 'kues-session-token' ? { id: 'local-1', email: 'person@example.test' } : null; },
  };
  const workosAuth = {
    async getAuthorizationUrl({ state }) { return `https://authkit.example.test/login?state=${state}`; },
    async completeLogin(input) {
      completed = input;
      return { sessionToken: 'kues-session-token' };
    },
  };

  const serverConfig = loadServerConfig({
    AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'server-secret', WORKOS_CLIENT_ID: 'client-kues',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback', TURSO_DATABASE_URL: 'file:./local.db',
    WORKOS_GOOGLE_OAUTH_ENABLED: '1',
  });
  await withServer({ authService, workosAuth, serverConfig }, async (base) => {
    const start = await fetch(`${base}/auth/start?provider=GoogleOAuth`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    assert.match(start.headers.get('location'), /^https:\/\/authkit\.example\.test\/login\?state=/);
    const stateCookie = start.headers.get('set-cookie');
    assert.match(stateCookie, /HttpOnly/);
    assert.match(stateCookie, /SameSite=Lax/);
    const state = stateCookie.match(/kues_workos_state=([^;]+)/)?.[1];
    assert.equal(state.length, 43);

    const callback = await fetch(`${base}/auth/callback?code=authorization-code&state=${state}`, {
      headers: { Cookie: `kues_workos_state=${state}` },
      redirect: 'manual',
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/desktop-preview');
    assert.deepEqual(completed, {
      code: 'authorization-code',
      ipAddress: '127.0.0.1',
      userAgent: 'node',
    });
    const cookies = callback.headers.get('set-cookie');
    assert.match(cookies, /kues_workos_state=; Max-Age=0/);
    assert.match(cookies, /kues_session=kues-session-token/);
    assert.match(cookies, /HttpOnly/);

    const session = await fetch(`${base}/api/auth/session`, {
      headers: { Cookie: 'kues_session=kues-session-token' },
    });
    assert.deepEqual(await session.json(), {
      authenticated: true,
      user: { id: 'local-1', email: 'person@example.test' },
    });
  });
});

test('first-time WorkOS OAuth accounts are sent to onboarding after the callback', async () => {
  const workosAuth = {
    async getAuthorizationUrl({ state }) { return `https://authkit.example.test/login?state=${state}`; },
    async completeLogin() { return { sessionToken: 'new-user-session', isNewUser: true }; },
  };
  const serverConfig = loadServerConfig({
    AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'server-secret', WORKOS_CLIENT_ID: 'client-kues',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback', TURSO_DATABASE_URL: 'file:./local.db',
    WORKOS_GOOGLE_OAUTH_ENABLED: '1',
  });
  await withServer({ authService: {}, workosAuth, serverConfig }, async (base) => {
    const start = await fetch(`${base}/auth/start?provider=GoogleOAuth`, { redirect: 'manual' });
    const state = start.headers.get('set-cookie').match(/kues_workos_state=([^;]+)/)?.[1];
    const callback = await fetch(`${base}/auth/callback?code=authorization-code&state=${state}`, {
      headers: { Cookie: `kues_workos_state=${state}` }, redirect: 'manual',
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/desktop-preview');
  });
});

test('WorkOS social routes dispatch only enabled Google/GitHub providers', async () => {
  const serverConfig = loadServerConfig({
    AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'server-secret', WORKOS_CLIENT_ID: 'client-keus',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback', TURSO_DATABASE_URL: 'file:./local.db',
    WORKOS_GOOGLE_OAUTH_ENABLED: '1', WORKOS_GITHUB_OAUTH_ENABLED: '1',
  });
  const authorizations = [];
  const workosAuth = {
    async getAuthorizationUrl(input) {
      authorizations.push(input);
      const url = new URL('https://api.workos.com/user_management/authorize');
      url.searchParams.set('provider', input.provider);
      if (input.screenHint) url.searchParams.set('screen_hint', input.screenHint);
      url.searchParams.set('state', input.state);
      return url.toString();
    },
  };
  await withServer({ authService: {}, workosAuth, serverConfig }, async (base) => {
    const configResponse = await fetch(`${base}/api/auth/config`);
    assert.deepEqual(await configResponse.json(), {
      provider: 'workos', enabled: true, emailEnabled: true, emailPasswordEnabled: true,
      emailAuthMethod: 'password', magicAuthEnabled: false, googleEnabled: true, githubEnabled: true,
      otherMethodsEnabled: true,
    });
    for (const provider of ['GoogleOAuth', 'GitHubOAuth']) {
      const response = await fetch(`${base}/auth/start?provider=${provider}&intent=sign-up`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      const location = new URL(response.headers.get('location'));
      assert.equal(location.searchParams.get('provider'), provider);
      assert.equal(location.searchParams.get('screen_hint'), null);
      const stateCookie = response.headers.get('set-cookie');
      assert.match(stateCookie, /HttpOnly/);
      assert.equal(stateCookie.match(/kues_workos_state=([^;]+)/)?.[1].length, 43);
    }
    assert.deepEqual(authorizations.map(({ provider, screenHint }) => ({ provider, screenHint })), [
      { provider: 'GoogleOAuth', screenHint: undefined },
      { provider: 'GitHubOAuth', screenHint: undefined },
    ]);
    const unsupported = await fetch(`${base}/auth/start?provider=SlackOAuth`, { redirect: 'manual' });
    assert.equal(unsupported.status, 302);
    assert.equal(unsupported.headers.get('location'), '/login?auth_error=provider_disabled');
  });
});

test('WorkOS social providers stay disabled in the sign-in-only preview even if configured', async () => {
  const serverConfig = loadServerConfig({
    AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'server-secret', WORKOS_CLIENT_ID: 'client-keus',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback', TURSO_DATABASE_URL: 'file:./local.db',
    WORKOS_GOOGLE_OAUTH_ENABLED: '1', WORKOS_GITHUB_OAUTH_ENABLED: '1',
  });
  let called = false;
  await withServer({ authService: {}, workosAuth: { async getAuthorizationUrl() { called = true; return 'https://example.test'; } }, serverConfig, signInOnlyPreview: true }, async (base) => {
    const configResponse = await fetch(`${base}/api/auth/config`);
    const config = await configResponse.json();
    assert.equal(config.googleEnabled, false);
    assert.equal(config.githubEnabled, false);
    const response = await fetch(`${base}/auth/start?provider=GoogleOAuth`, { redirect: 'manual' });
    assert.equal(response.headers.get('location'), '/login?auth_error=provider_disabled');
    assert.equal(called, false);
  });
});

test('WorkOS callback rejects state mismatch without exchanging the authorization code', async () => {
  let exchanged = false;
  const workosAuth = {
    async getAuthorizationUrl() { return 'https://authkit.example.test'; },
    async completeLogin() { exchanged = true; throw new Error('should_not_run'); },
  };
  await withServer({ authService: {}, workosAuth }, async (base) => {
    const response = await fetch(`${base}/auth/callback?code=stolen&state=${'A'.repeat(43)}`, {
      headers: { Cookie: `kues_workos_state=${'B'.repeat(43)}` },
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login?auth_error=state');
    assert.equal(exchanged, false);
  });
});

test('WorkOS password signup stores a short-lived HttpOnly challenge and verification creates a Keus session', async () => {
  let signup;
  let verified;
  const workosAuth = {
    async signUpWithPassword(value) {
      signup = value;
      return {
        needsEmailVerification: true,
        email: 'person@example.test',
        challenge: { kind: 'pending', token: 'pending-secret', email: 'person@example.test' },
      };
    },
    async verifyPasswordEmail(value) {
      verified = value;
      return { user: { id: 'local-1' }, sessionToken: 'kues-password-session', isNewUser: true };
    },
  };
  await withServer({ authService: {}, workosAuth }, async (base) => {
    const origin = base;
    const signupResponse = await fetch(`${base}/api/auth/password/signup`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test', password: 'a sufficiently strong password' }),
    });
    assert.equal(signupResponse.status, 202);
    assert.deepEqual(await signupResponse.json(), { accepted: true, email: 'person@example.test' });
    assert.equal(signup.email, 'person@example.test');
    assert.equal(signup.password, 'a sufficiently strong password');
    const pendingCookie = signupResponse.headers.get('set-cookie');
    assert.match(pendingCookie, /kues_pending_auth=/);
    assert.match(pendingCookie, /HttpOnly/);
    assert.match(pendingCookie, /SameSite=Strict/);
    assert.match(pendingCookie, /Path=\/api\/auth\/password/);
    assert.equal(pendingCookie.includes('a sufficiently strong password'), false);
    assert.equal(pendingCookie.includes('pending-secret'), false);

    const pendingValue = pendingCookie.match(/kues_pending_auth=([^;]+)/)?.[1];
    const verifyResponse = await fetch(`${base}/api/auth/password/verify`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: `kues_pending_auth=${pendingValue}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test', password: 'a sufficiently strong password', code: '123456' }),
    });
    assert.equal(verifyResponse.status, 200);
    assert.deepEqual(await verifyResponse.json(), {
      authenticated: true, isNewUser: true, needsOnboarding: true, redirect: '/desktop-preview', user: { id: 'local-1' },
    });
    assert.equal(verified.code, '123456');
    assert.deepEqual(verified.challenge, {
      kind: 'pending', token: 'pending-secret', email: 'person@example.test',
    });
    const cookies = verifyResponse.headers.get('set-cookie');
    assert.match(cookies, /kues_session=kues-password-session/);
    assert.match(cookies, /kues_pending_auth=; Max-Age=0/);
  });
});

test('WorkOS signup does not reveal whether an email-code account already exists', async () => {
  let requests = 0;
  const workosAuth = {
    async signUpWithPassword({ email }) {
      requests += 1;
      if (email === 'existing@example.test') return { needsEmailVerification: false, passwordResetAvailable: true, email };
      return { needsEmailVerification: true, email, challenge: { kind: 'pending', token: 'new-token', email } };
    },
  };
  await withServer({ authService: {}, workosAuth }, async (base) => {
    const makeRequest = (email) => fetch(`${base}/api/auth/password/signup`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'a sufficiently strong password' }),
    });
    const created = await makeRequest('new@example.test');
    const existing = await makeRequest('existing@example.test');
    assert.equal(created.status, 202);
    assert.equal(existing.status, 202);
    assert.deepEqual(await created.json(), { accepted: true, email: 'new@example.test' });
    assert.deepEqual(await existing.json(), { accepted: true, email: 'existing@example.test' });
    assert.match(created.headers.get('set-cookie'), /kues_pending_auth=/);
    assert.match(existing.headers.get('set-cookie'), /kues_pending_auth=; Max-Age=0/);
    assert.equal(requests, 2);
  });
});

test('password reset sends a generic code response and never creates a Keus session', async () => {
  const requests = [];
  const workosAuth = {
    async startPasswordReset(value) {
      requests.push({ type: 'start', value });
      return { accepted: true, email: value.email, challenge: { kind: 'password_reset', email: value.email } };
    },
    async completePasswordReset(value) {
      requests.push({ type: 'complete', value });
      return { passwordUpdated: true };
    },
  };
  await withServer({ authService: {}, workosAuth }, async (base) => {
    const response = await fetch(`${base}/api/auth/password/reset/start`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test' }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      accepted: true,
      message: 'If an account exists for that email, a password reset code will be sent.',
    });
    const resetCookie = response.headers.get('set-cookie');
    assert.match(resetCookie, /kues_password_reset=/);
    assert.match(resetCookie, /HttpOnly/);
    assert.match(resetCookie, /SameSite=Strict/);
    assert.match(resetCookie, /Path=\/api\/auth\/password\/reset/);
    assert.doesNotMatch(resetCookie, /kues_session=/);
    assert.deepEqual(requests, [{ type: 'start', value: { email: 'person@example.test' } }]);

    const cookieValue = resetCookie.match(/kues_password_reset=([^;]+)/)?.[1];
    const verifyResponse = await fetch(`${base}/api/auth/password/reset/verify`, {
      method: 'POST',
      headers: { Origin: base, Cookie: `kues_password_reset=${cookieValue}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456', newPassword: 'a strong new password' }),
    });
    assert.equal(verifyResponse.status, 200);
    assert.deepEqual(await verifyResponse.json(), { passwordUpdated: true });
    const clearCookie = verifyResponse.headers.get('set-cookie');
    assert.match(clearCookie, /kues_password_reset=; Max-Age=0/);
    assert.doesNotMatch(clearCookie, /kues_session=/);
    assert.deepEqual(requests[1], {
      type: 'complete',
      value: {
        code: '123456', newPassword: 'a strong new password',
        challenge: { kind: 'password_reset', email: 'person@example.test' },
        ipAddress: '127.0.0.1', userAgent: 'node',
      },
    });
  });
});

test('WorkOS password routes require same-origin requests and old Magic Auth endpoints are retired', async () => {
  await withServer({
    authService: {},
    workosAuth: {
      async signUpWithPassword() { throw new Error('must_not_run'); },
      async signInWithPassword() { throw new Error('must_not_run'); },
    },
  }, async (base) => {
    const crossOrigin = await fetch(`${base}/api/auth/password/login`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test', password: 'correct horse battery' }),
    });
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(await crossOrigin.json(), { error: 'origin_not_allowed' });

    const crossOriginRecovery = await fetch(`${base}/api/auth/password/reset/verify`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456', newPassword: 'a strong new password' }),
    });
    assert.equal(crossOriginRecovery.status, 403);
    assert.deepEqual(await crossOriginRecovery.json(), { error: 'origin_not_allowed' });

    for (const [path, body] of [
      ['/api/auth/email/start', { email: 'person@example.test' }],
      ['/api/auth/email/verify', { email: 'person@example.test', code: '123456' }],
      ['/api/auth/email/consume', { token: 'old' }],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 410);
      assert.deepEqual(await response.json(), { error: 'password_auth_required' });
    }
  });
});

test('AuthKit hosted sign-in is blocked so enabled Magic Auth cannot bypass password sign-in', async () => {
  let called = false;
  await withServer({
    authService: {},
    workosAuth: { async getAuthorizationUrl() { called = true; return 'https://authkit.example.test'; } },
  }, async (base) => {
    for (const path of ['/auth/start', '/auth/start?provider=authkit']) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/login?auth_error=provider_disabled');
    }
    assert.equal(called, false);
  });
});

test('same-origin password login works behind a preview proxy while CORS preflight respects the allowlist', async () => {
  const serverConfig = loadServerConfig({
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'server-secret',
    WORKOS_CLIENT_ID: 'client-kues',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
    CORS_ALLOWED_ORIGINS: 'https://preview.example.test',
  });
  let requested;
  await withServer({
    serverConfig,
    authService: {},
    workosAuth: { async signInWithPassword(value) { requested = value; return { needsEmailVerification: true, email: value.email, challenge: { kind: 'pending', token: 'challenge', email: value.email } }; } },
    signInOnlyPreview: true,
  }, async (base) => {
    const response = await fetch(`${base}/api/auth/password/login`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test', password: 'correct horse battery' }),
    });
    assert.equal(response.status, 202);
    assert.equal(requested.email, 'person@example.test');
    assert.equal(requested.password, 'correct horse battery');
    const preflight = await fetch(`${base}/api/auth/password/login`, {
      method: 'OPTIONS',
      headers: {
        Host: 'preview.example.test', Origin: 'https://preview.example.test', 'X-Forwarded-Proto': 'https',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    const allowedHeaders = preflight.headers.get('access-control-allow-headers') || '';
    assert.match(allowedHeaders, /content-type/i);
    assert.doesNotMatch(allowedHeaders, /x-keus-setup-token|x-kues-setup-token/i);
  });
});

test('sign-in-only preview keeps the public landing available and does not expose temporary credential setup', async () => {
  const serverConfig = loadServerConfig({ TURSO_DATABASE_URL: 'file:./local.db' });
  await withServer({ serverConfig, authService: {}, signInOnlyPreview: true }, async (base) => {
    const root = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Your AI workspace/);
    assert.equal((await fetch(`${base}/login`)).status, 200);
    assert.equal((await fetch(`${base}/__dev/workos-setup`)).status, 404);
    assert.equal((await fetch(`${base}/api/dev/workos-setup`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/onboarding`)).status, 200);
    assert.equal((await fetch(`${base}/app`)).status, 200);
    assert.equal((await fetch(`${base}/desktop-preview`)).status, 200);
    const oldPreview = await fetch(`${base}/desktop`, { redirect: 'manual' });
    assert.equal(oldPreview.status, 302);
    assert.equal(oldPreview.headers.get('location'), '/app');
  });
});

test('auth config endpoint reports WorkOS activation without returning secrets', async () => {
  await withServer({ authService: {}, workosAuth: {} }, async (base) => {
    const response = await fetch(`${base}/api/auth/config`);
    assert.deepEqual(await response.json(), {
      provider: 'workos', enabled: true, emailEnabled: true, emailPasswordEnabled: true,
      emailAuthMethod: 'password', magicAuthEnabled: false, googleEnabled: false, githubEnabled: false,
      otherMethodsEnabled: false,
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('demo-fastlane creates judge session and redirects to the desktop preview with established workspace', async () => {
  let created = null;
  const authService = {
    async createWorkOSSession(payload) {
      created = payload;
      return {
        sessionToken: 'token_judge_fastlane_test',
        user: { id: 'usr_judge_123', email_normalized: payload.email, display_name: payload.displayName },
      };
    },
    async getSession({ token }) {
      if (token === 'token_judge_fastlane_test') {
        return {
          sessionToken: token,
          user: { id: 'usr_judge_123', email_normalized: 'judge@paypal.sandbox', status: 'active' },
        };
      }
      return null;
    },
  };

  await withServer({ authService, workosAuth: {} }, async (base) => {
    const res = await fetch(`${base}/api/auth/demo-fastlane`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.authenticated, true);
    assert.equal(data.redirect, '/desktop-preview');
    assert.equal(created?.email, 'judge@paypal.sandbox');

    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /kues_session=token_judge_fastlane_test/);

    const appRes = await fetch(`${base}/app`, {
      headers: {
        Cookie: 'kues_session=token_judge_fastlane_test',
      },
    });
    assert.equal(appRes.status, 200);
  });
});
