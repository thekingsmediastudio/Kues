import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkOS } from '@workos-inc/node';
import { createWorkOSAuth } from '../../apps/web/lib/auth/workos-auth.mjs';

const state = 'A'.repeat(43);
const unusedAuthService = {
  async reserveWorkOSCodeRequest() { throw new Error('must_not_run'); },
  async createWorkOSSession() { throw new Error('must_not_run'); },
};

test('installed WorkOS Node SDK generates the AuthKit authorization URL locally', async () => {
  const workos = new WorkOS({ apiKey: 'sk_test_local_only', clientId: 'client_kues_local' });
  const adapter = createWorkOSAuth({
    workos,
    clientId: 'client_kues_local',
    redirectUri: 'http://localhost:3100/auth/callback',
    authService: unusedAuthService,
  });
  const url = new URL(await adapter.getAuthorizationUrl({ state }));
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'api.workos.com');
  assert.equal(url.searchParams.get('provider'), 'authkit');
  assert.equal(url.searchParams.get('client_id'), 'client_kues_local');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3100/auth/callback');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('screen_hint'), 'sign-in');
  for (const provider of ['GoogleOAuth', 'GitHubOAuth']) {
    const socialUrl = new URL(await adapter.getAuthorizationUrl({ state, provider, screenHint: 'sign-up' }));
    assert.equal(socialUrl.searchParams.get('provider'), provider);
    assert.equal(socialUrl.searchParams.get('screen_hint'), null);
    assert.equal(socialUrl.searchParams.get('redirect_uri'), 'http://localhost:3100/auth/callback');
  }
});

test('WorkOS adapter starts AuthKit with fixed callback and caller-supplied CSRF state', async () => {
  let options;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        getAuthorizationUrl(value) { options = value; return 'https://authkit.example.test/authorize'; },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://kues.example.test/auth/callback',
    authService: unusedAuthService,
  });

  assert.equal(await adapter.getAuthorizationUrl({ state }), 'https://authkit.example.test/authorize');
  assert.deepEqual(options, {
    provider: 'authkit',
    clientId: 'client_kues',
    redirectUri: 'https://kues.example.test/auth/callback',
    state,
    screenHint: 'sign-in',
  });
  await assert.rejects(adapter.getAuthorizationUrl({ state: 'bad' }), /invalid_oauth_state/);
});

test('WorkOS authorization URL supports only Google and GitHub social providers with account intent', async () => {
  const requests = [];
  const adapter = createWorkOSAuth({
    workos: { userManagement: { getAuthorizationUrl(value) { requests.push(value); return 'https://workos.example.test/authorize'; } } },
    clientId: 'client_keus', redirectUri: 'https://keus.example.test/auth/callback', authService: unusedAuthService,
  });
  for (const provider of ['GoogleOAuth', 'GitHubOAuth']) {
    await adapter.getAuthorizationUrl({ state, provider, screenHint: 'sign-up' });
  }
  assert.deepEqual(requests.map(({ provider, screenHint }) => ({ provider, screenHint })), [
    { provider: 'GoogleOAuth', screenHint: undefined },
    { provider: 'GitHubOAuth', screenHint: undefined },
  ]);
  await assert.rejects(adapter.getAuthorizationUrl({ state, provider: 'https://evil.example' }), /unsupported_oauth_provider/);
  await assert.rejects(adapter.getAuthorizationUrl({ state, screenHint: 'signout' }), /invalid_auth_screen/);
});

test('WorkOS email code request sends through WorkOS and never returns the code', async () => {
  let reserved;
  let sent;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        getAuthorizationUrl() { return 'https://authkit.example.test'; },
        async createMagicAuth(value) { sent = value; return { code: '123456' }; },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://kues.example.test/auth/callback',
    authService: {
      async reserveWorkOSCodeRequest(value) { reserved = value; return { email: 'person@example.test', expiresAt: '2026-01-01T00:10:00.000Z' }; },
      async createWorkOSSession() { throw new Error('must_not_run'); },
    },
  });

  const result = await adapter.requestEmailCode({ email: 'Person@Example.test', now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(reserved, { email: 'Person@Example.test', now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(sent, { email: 'person@example.test' });
  assert.deepEqual(result, { accepted: true, expiresAt: '2026-01-01T00:10:00.000Z' });
  assert.equal(JSON.stringify(result).includes('123456'), false);
});

test('WorkOS email code errors identify rejected staging credentials without exposing provider details', async () => {
  const adapter = createWorkOSAuth({
    workos: { userManagement: { async createMagicAuth() {
      throw Object.assign(new Error('sensitive provider response'), { status: 401 });
    } } },
    clientId: 'client_kues',
    redirectUri: 'https://kues.example.test/auth/callback',
    authService: {
      async reserveWorkOSCodeRequest() { return { email: 'person@example.test', expiresAt: 'later' }; },
      async createWorkOSSession() { throw new Error('must_not_run'); },
    },
  });
  await assert.rejects(adapter.requestEmailCode({ email: 'person@example.test' }), (error) => {
    assert.equal(error.code, 'workos_key_rejected');
    assert.equal(error.status, 503);
    assert.equal(error.message.includes('sensitive provider response'), false);
    return true;
  });
});

test('WorkOS email code verification links only verified user and returns a Keus session', async () => {
  let exchange;
  let session;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        getAuthorizationUrl() { return 'https://authkit.example.test'; },
        async authenticateWithMagicAuth(value) {
          exchange = value;
          return {
            accessToken: 'never-persist-this',
            refreshToken: 'never-persist-this-either',
            user: { id: 'user_123', email: 'person@example.test', emailVerified: true, firstName: 'Keus', lastName: 'Tester' },
          };
        },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://kues.example.test/auth/callback',
    authService: {
      async reserveWorkOSCodeRequest() { throw new Error('must_not_run'); },
      async createWorkOSSession(value) { session = value; return { user: { id: 'local-1' }, sessionToken: 'token' }; },
    },
  });

  const result = await adapter.verifyEmailCode({
    email: 'Person@Example.test', code: '123456', ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(exchange, {
    clientId: 'client_kues', email: 'person@example.test', code: '123456',
    ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(session, {
    providerSubject: 'user_123', email: 'person@example.test', emailVerified: true,
    displayName: 'Keus Tester', now: undefined,
  });
  assert.deepEqual(result.user, { id: 'local-1' });
  assert.equal('accessToken' in result, false);
  await assert.rejects(
    adapter.verifyEmailCode({ email: 'person@example.test', code: 'bad' }),
    /invalid_or_expired_code/
  );
});

test('WorkOS OAuth callback exchanges authorization code and maps only verified identity into Keus', async () => {
  let exchange;
  let session;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        getAuthorizationUrl() { return 'https://authkit.example.test'; },
        async authenticateWithCode(value) {
          exchange = value;
          return {
            accessToken: 'never-persist-this',
            refreshToken: 'never-persist-this-either',
            user: {
              id: 'user_123', email: 'person@example.test', emailVerified: true,
              firstName: 'Keus', lastName: 'Tester',
            },
          };
        },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://kues.example.test/auth/callback',
    authService: {
      async reserveWorkOSCodeRequest() { throw new Error('must_not_run'); },
      async createWorkOSSession(value) { session = value; return { user: { id: 'local-1' }, sessionToken: 'token' }; },
    },
  });

  const result = await adapter.completeLogin({
    code: 'one-time-code', ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(exchange, {
    code: 'one-time-code', clientId: 'client_kues',
    ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(session, {
    providerSubject: 'user_123',
    email: 'person@example.test',
    emailVerified: true,
    displayName: 'Keus Tester',
    now: undefined,
  });
  assert.deepEqual(result.user, { id: 'local-1' });
  assert.equal('accessToken' in result, false);
});
