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
  serverConfig = config,
  allowEphemeralWorkOSTestSetup = false,
  signInOnlyPreview = false,
  workosClientFactory,
}, run) {
  const server = createServer({
    config: serverConfig,
    authService,
    workosAuth,
    allowEphemeralWorkOSTestSetup,
    signInOnlyPreview,
    workosClientFactory,
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

  await withServer({ authService, workosAuth }, async (base) => {
    const start = await fetch(`${base}/auth/start`, { redirect: 'manual' });
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
    assert.equal(callback.headers.get('location'), '/app');
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
  await withServer({ authService: {}, workosAuth }, async (base) => {
    const start = await fetch(`${base}/auth/start`, { redirect: 'manual' });
    const state = start.headers.get('set-cookie').match(/kues_workos_state=([^;]+)/)?.[1];
    const callback = await fetch(`${base}/auth/callback?code=authorization-code&state=${state}`, {
      headers: { Cookie: `kues_workos_state=${state}` }, redirect: 'manual',
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/onboarding');
  });
});

test('WorkOS social routes dispatch only enabled Google/GitHub providers and preserve sign-up intent', async () => {
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
      provider: 'workos', enabled: true, emailEnabled: true, googleEnabled: true, githubEnabled: true,
      otherMethodsEnabled: true, testSetupAvailable: false,
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

test('WorkOS exposes email-code endpoints, creates a Keus session, and retires old link consumption', async () => {
  let requested;
  let verified;
  const workosAuth = {
    async getAuthorizationUrl() { return 'https://authkit.example.test'; },
    async requestEmailCode(value) { requested = value; return { accepted: true, expiresAt: 'later' }; },
    async verifyEmailCode(value) { verified = value; return { user: { id: 'local-1' }, sessionToken: 'kues-code-session', isNewUser: true }; },
  };
  await withServer({ authService: {}, workosAuth }, async (base) => {
    const start = await fetch(`${base}/api/auth/email/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test' }),
    });
    assert.equal(start.status, 202);
    assert.equal((await start.json()).accepted, true);
    assert.equal('code' in requested, false);
    assert.equal(requested.email, 'person@example.test');

    const verifyCode = await fetch(`${base}/api/auth/email/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test', code: '123456' }),
    });
    assert.equal(verifyCode.status, 200);
    assert.deepEqual(await verifyCode.json(), { authenticated: true, isNewUser: true, needsOnboarding: true, user: { id: 'local-1' } });
    assert.equal(verified.code, '123456');
    assert.match(verifyCode.headers.get('set-cookie'), /kues_session=kues-code-session/);

    const oldConsume = await fetch(`${base}/api/auth/email/consume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'old' }),
    });
    assert.equal(oldConsume.status, 410);
    assert.deepEqual(await oldConsume.json(), { error: 'workos_authkit_required' });

    const verify = await fetch(`${base}/auth/verify`, { redirect: 'manual' });
    assert.equal(verify.status, 302);
    assert.equal(verify.headers.get('location'), '/login');
  });
});

test('sign-in-only preview accepts an explicitly allowlisted browser-preview origin', async () => {
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
    workosAuth: { async requestEmailCode(value) { requested = value; } },
    signInOnlyPreview: true,
  }, async (base) => {
    const response = await fetch(`${base}/api/auth/email/start`, {
      method: 'POST',
      headers: { Host: 'preview.example.test', Origin: 'https://preview.example.test', 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test' }),
    });
    assert.equal(response.status, 202);
    assert.equal(requested.email, 'person@example.test');
    const preflight = await fetch(`${base}/api/dev/workos-setup`, {
      method: 'OPTIONS',
      headers: {
        Host: 'preview.example.test', Origin: 'https://preview.example.test', 'X-Forwarded-Proto': 'https',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-keus-setup-token',
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /x-keus-setup-token/i);
  });
});

test('sign-in-only preview serves the connection page at root and hides unrelated pages', async () => {
  const serverConfig = loadServerConfig({ TURSO_DATABASE_URL: 'file:./local.db' });
  await withServer({
    serverConfig,
    authService: {},
    allowEphemeralWorkOSTestSetup: true,
    signInOnlyPreview: true,
  }, async (base) => {
    const root = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Connect WorkOS test/);
    assert.equal((await fetch(`${base}/login`)).status, 200);
    assert.equal((await fetch(`${base}/__dev/workos-setup`)).status, 200);
    assert.equal((await fetch(`${base}/onboarding`)).status, 200);
    assert.equal((await fetch(`${base}/app`)).status, 200);
  });
});

test('development setup accepts a test key in memory only and enables the real email-code endpoints', async () => {
  const serverConfig = loadServerConfig({ TURSO_DATABASE_URL: 'file:./local.db', CORS_ALLOWED_ORIGINS: 'https://preview.kues.test' });
  let clientOptions;
  let sentEmail;
  const authService = {
    async reserveWorkOSCodeRequest({ email }) { return { email: email.toLowerCase(), expiresAt: 'later' }; },
    async createWorkOSSession() { return { user: { id: 'local-user' }, sessionToken: 'session' }; },
  };
  const workosClientFactory = (options) => {
    clientOptions = options;
    return { userManagement: {
      async listUsers() { return { data: [] }; },
      async createMagicAuth({ email }) { sentEmail = email; return { code: '654321' }; },
    } };
  };

  await withServer({
    authService,
    serverConfig,
    allowEphemeralWorkOSTestSetup: true,
    workosClientFactory,
  }, async (base) => {
    const setupPage = await fetch(`${base}/__dev/workos-setup`);
    assert.equal(setupPage.status, 200);
    const setupHtml = await setupPage.text();
    assert.match(setupHtml, /not written to a file or logged/);
    const setupToken = setupHtml.match(/name="keus-setup-token" content="([^"]+)"/)?.[1];
    assert.match(setupToken, /^[A-Za-z0-9_-]{43}$/);

    const crossOriginSetup = await fetch(`${base}/api/dev/workos-setup`, {
      method: 'POST',
      headers: { Origin: 'https://other.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk_test_should_not_be_used', clientId: 'client_test123' }),
    });
    assert.equal(crossOriginSetup.status, 403);

    const previewOrigin = 'https://preview.kues.test';
    const proxiedHeaders = {
      Origin: previewOrigin,
      'X-Forwarded-Proto': 'https',
      'Content-Type': 'application/json',
    };
    const setup = await fetch(`${base}/api/dev/workos-setup`, {
      method: 'POST',
      headers: { ...proxiedHeaders, 'X-Keus-Setup-Token': setupToken },
      body: JSON.stringify({ apiKey: 'sk_test_ephemeral_only', clientId: 'client_test123' }),
    });
    assert.equal(setup.status, 200);
    const setupBody = await setup.json();
    assert.equal(setupBody.configured, true);
    assert.equal(setupBody.scope, 'memory_only');
    assert.match(setupBody.setupToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(setupBody).includes('sk_test_ephemeral_only'), false);
    assert.deepEqual(clientOptions, { apiKey: 'sk_test_ephemeral_only', clientId: 'client_test123' });

    const configResponse = await fetch(`${base}/api/auth/config`);
    assert.deepEqual(await configResponse.json(), {
      provider: 'workos', enabled: true, emailEnabled: true, googleEnabled: false, githubEnabled: false, otherMethodsEnabled: false, testSetupAvailable: true,
    });

    const send = await fetch(`${base}/api/auth/email/start`, {
      method: 'POST',
      headers: proxiedHeaders,
      body: JSON.stringify({ email: 'Person@example.test' }),
    });
    assert.equal(send.status, 202);
    assert.equal(sentEmail, 'person@example.test');
    const sendBody = await send.text();
    assert.equal(sendBody.includes('654321'), false);
    assert.equal(sendBody.includes('sk_test_ephemeral_only'), false);

    const updatedSetupHtml = await (await fetch(`${base}/__dev/workos-setup`)).text();
    const updatedSetupToken = updatedSetupHtml.match(/name="keus-setup-token" content="([^"]+)"/)?.[1];
    const correctedSetup = await fetch(`${base}/api/dev/workos-setup`, {
      method: 'POST',
      headers: { ...proxiedHeaders, 'X-Keus-Setup-Token': updatedSetupToken },
      body: JSON.stringify({ apiKey: 'sk_test_corrected', clientId: 'client_test123' }),
    });
    assert.equal(correctedSetup.status, 200);
    assert.equal(clientOptions.apiKey, 'sk_test_corrected');
  });
});

test('development setup reports safe WorkOS error categories without leaking error messages', async () => {
  const serverConfig = loadServerConfig({ TURSO_DATABASE_URL: 'file:./local.db' });
  const authService = {
    async reserveWorkOSCodeRequest() {},
    async createWorkOSSession() {},
  };
  await withServer({
    serverConfig,
    authService,
    allowEphemeralWorkOSTestSetup: true,
    workosClientFactory: () => {
      throw Object.assign(new Error('secret key should not be included'), { status: 401 });
    },
  }, async (base) => {
    const setupHtml = await (await fetch(`${base}/__dev/workos-setup`)).text();
    const setupToken = setupHtml.match(/name="keus-setup-token" content="([^"]+)"/)?.[1];
    const response = await fetch(`${base}/api/dev/workos-setup`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-Keus-Setup-Token': setupToken },
      body: JSON.stringify({ apiKey: 'sk_test_example', clientId: 'client_test123' }),
    });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: 'workos_key_rejected' });
    assert.equal(body.includes('secret key should not be included'), false);
  });
});

test('auth config endpoint reports WorkOS activation without returning secrets', async () => {
  await withServer({ authService: {}, workosAuth: {} }, async (base) => {
    const response = await fetch(`${base}/api/auth/config`);
    assert.deepEqual(await response.json(), {
      provider: 'workos', enabled: true, emailEnabled: true, googleEnabled: false, githubEnabled: false, otherMethodsEnabled: false, testSetupAvailable: false,
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
