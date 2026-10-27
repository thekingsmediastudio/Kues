import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkOS } from '@workos-inc/node';
import { createWorkOSAuth } from '../../apps/web/lib/auth/workos-auth.mjs';

const state = 'A'.repeat(43);

function authService({ reserve, session } = {}) {
  return {
    async reserveWorkOSCodeRequest(value) {
      if (reserve) return reserve(value);
      return { email: String(value.email).trim().toLowerCase(), expiresAt: '2026-01-01T00:10:00.000Z' };
    },
    async createWorkOSSession(value) {
      if (session) return session(value);
      return { user: { id: 'local-1', email: value.email }, sessionToken: 'kues-session-token', isNewUser: true, needsOnboarding: true };
    },
  };
}

function verificationRequiredError(token = 'pending-auth-token') {
  return Object.assign(new Error('provider details must remain private'), {
    status: 403,
    rawData: {
      code: 'email_verification_required',
      pending_authentication_token: token,
      email: 'person@example.test',
      email_verification_id: 'email_verification_123',
    },
  });
}

test('installed WorkOS SDK generates provider-specific OAuth URLs locally', async () => {
  const workos = new WorkOS({ apiKey: 'sk_test_local_only', clientId: 'client_kues_local' });
  const adapter = createWorkOSAuth({
    workos,
    clientId: 'client_kues_local',
    redirectUri: 'http://localhost:3100/auth/callback',
    authService: authService(),
  });
  for (const provider of ['GoogleOAuth', 'GitHubOAuth']) {
    const url = new URL(await adapter.getAuthorizationUrl({ state, provider }));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'api.workos.com');
    assert.equal(url.searchParams.get('provider'), provider);
    assert.equal(url.searchParams.get('client_id'), 'client_kues_local');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3100/auth/callback');
    assert.equal(url.searchParams.get('state'), state);
  }
  await assert.rejects(adapter.getAuthorizationUrl({ state, provider: 'authkit' }), /unsupported_oauth_provider/);
});

test('WorkOS adapter uses the fixed callback and caller-supplied CSRF state for OAuth', async () => {
  let options;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        getAuthorizationUrl(value) { options = value; return 'https://authkit.example.test/authorize'; },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://kues.example.test/auth/callback',
    authService: authService(),
  });

  assert.equal(await adapter.getAuthorizationUrl({ state, provider: 'GoogleOAuth' }), 'https://authkit.example.test/authorize');
  assert.deepEqual(options, {
    provider: 'GoogleOAuth',
    clientId: 'client_kues',
    redirectUri: 'https://kues.example.test/auth/callback',
    state,
  });
  await assert.rejects(adapter.getAuthorizationUrl({ state: 'bad', provider: 'GoogleOAuth' }), /invalid_oauth_state/);
  await assert.rejects(adapter.getAuthorizationUrl({ state, provider: 'authkit' }), /unsupported_oauth_provider/);
});

test('new WorkOS email signup creates an unverified password user and starts the verification challenge', async () => {
  const calls = { created: null, authenticated: null, reserved: null, session: null };
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        async createUser(value) {
          calls.created = value;
          return { id: 'user_123', email: value.email, emailVerified: false };
        },
        async authenticateWithPassword(value) {
          calls.authenticated = value;
          throw verificationRequiredError();
        },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService({
      reserve: async (value) => {
        calls.reserved = value;
        return { email: value.email.toLowerCase(), expiresAt: 'later' };
      },
      session: async (value) => {
        calls.session = value;
        return { user: { id: 'local-1' }, sessionToken: 'session' };
      },
    }),
  });

  const result = await adapter.signUpWithPassword({
    email: 'Person@Example.test', password: 'correct horse battery',
    ipAddress: '127.0.0.1', userAgent: 'test-agent', now: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(calls.reserved, { email: 'person@example.test', now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(calls.created, {
    email: 'person@example.test', password: 'correct horse battery', emailVerified: false,
  });
  assert.deepEqual(calls.authenticated, {
    clientId: 'client_kues', email: 'person@example.test', password: 'correct horse battery',
    ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(result, {
    needsEmailVerification: true,
    email: 'person@example.test',
    challenge: { kind: 'pending', token: 'pending-auth-token', email: 'person@example.test' },
  });
  assert.equal(calls.session, null);
  assert.equal(JSON.stringify(result).includes('correct horse battery'), false);
});

test('WorkOS verification code completes pending password authentication and links the verified identity', async () => {
  let exchange;
  let session;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        async authenticateWithEmailVerification(value) {
          exchange = value;
          return {
            accessToken: 'never-persist-this', refreshToken: 'never-persist-this-either',
            user: { id: 'user_123', email: 'person@example.test', emailVerified: true, firstName: 'Keus', lastName: 'Tester' },
          };
        },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService({
      session: async (value) => {
        session = value;
        return { user: { id: 'local-1' }, sessionToken: 'token' };
      },
    }),
  });

  const result = await adapter.verifyPasswordEmail({
    challenge: { kind: 'pending', token: 'pending-auth-token', email: 'person@example.test' },
    email: 'person@example.test', code: '123456', ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(exchange, {
    clientId: 'client_kues', pendingAuthenticationToken: 'pending-auth-token', code: '123456',
    ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(session, {
    providerSubject: 'user_123', email: 'person@example.test', emailVerified: true,
    displayName: 'Keus Tester', now: undefined,
  });
  assert.deepEqual(result.user, { id: 'local-1' });
  assert.equal('accessToken' in result, false);
});

test('existing passwordless WorkOS account is preserved and offered a password reset, not duplicated', async () => {
  let resetRequest;
  let sessionIdentity;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        async createUser() { throw Object.assign(new Error('already registered'), { status: 409 }); },
        async createPasswordReset(value) {
          resetRequest = value;
          return { passwordResetToken: 'must-not-leak', passwordResetUrl: 'https://workos.example.test/reset' };
        },
        async authenticateWithPassword({ email }) {
          return {
            user: { id: 'existing-workos-user', email, emailVerified: true, firstName: 'Existing', lastName: 'Member' },
            accessToken: 'not-persisted', refreshToken: 'not-persisted',
          };
        },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService({ session: async (value) => {
      sessionIdentity = value;
      return { user: { id: 'local-existing-user' }, sessionToken: 'existing-session' };
    } }),
  });

  const result = await adapter.signUpWithPassword({ email: 'Person@Example.test', password: 'new strong password' });
  assert.deepEqual(resetRequest, { email: 'person@example.test' });
  assert.deepEqual(result, { needsEmailVerification: false, passwordResetStarted: true, email: 'person@example.test' });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);

  // After the owner uses the reset email to set the first password, the same WorkOS user ID
  // is linked back to the existing local Keus account and workspace.
  const signedIn = await adapter.signInWithPassword({ email: 'person@example.test', password: 'owner-chosen-password' });
  assert.deepEqual(sessionIdentity, {
    providerSubject: 'existing-workos-user', email: 'person@example.test', emailVerified: true,
    displayName: 'Existing Member', now: undefined,
  });
  assert.deepEqual(signedIn.user, { id: 'local-existing-user' });
});

test('password sign-in creates a Keus session only for a verified WorkOS user', async () => {
  let credentials;
  let session;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        async authenticateWithPassword(value) {
          credentials = value;
          return {
            accessToken: 'not-returned', refreshToken: 'not-returned',
            user: { id: 'user_456', email: 'person@example.test', emailVerified: true, firstName: 'Test', lastName: 'User' },
          };
        },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService({ session: async (value) => { session = value; return { user: { id: 'local-2' }, sessionToken: 'local-session' }; } }),
  });

  const result = await adapter.signInWithPassword({
    email: 'Person@Example.test', password: 'correct horse battery', ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(credentials, {
    clientId: 'client_kues', email: 'person@example.test', password: 'correct horse battery',
    ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(session, {
    providerSubject: 'user_456', email: 'person@example.test', emailVerified: true,
    displayName: 'Test User', now: undefined,
  });
  assert.deepEqual(result, {
    needsEmailVerification: false, email: 'person@example.test',
    user: { id: 'local-2' }, sessionToken: 'local-session',
  });
  assert.equal(JSON.stringify(result).includes('not-returned'), false);
});

test('unverified password sign-in returns a pending WorkOS token and sends no app session', async () => {
  const adapter = createWorkOSAuth({
    workos: { userManagement: { async authenticateWithPassword() { throw verificationRequiredError('pending-for-login'); } } },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService({ session: async () => { throw new Error('must_not_run'); } }),
  });
  const result = await adapter.signInWithPassword({ email: 'person@example.test', password: 'correct horse battery' });
  assert.equal(result.needsEmailVerification, true);
  assert.deepEqual(result.challenge, { kind: 'pending', token: 'pending-for-login', email: 'person@example.test' });
});

test('forgot-password sends a reset through WorkOS and never returns the reset token', async () => {
  let reset;
  const adapter = createWorkOSAuth({
    workos: { userManagement: { async createPasswordReset(value) { reset = value; return { passwordResetToken: 'secret-reset-token' }; } } },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService(),
  });
  const result = await adapter.startPasswordReset({ email: 'Person@Example.test' });
  assert.deepEqual(reset, { email: 'person@example.test' });
  assert.deepEqual(result, { accepted: true, email: 'person@example.test' });
  assert.equal(JSON.stringify(result).includes('secret-reset-token'), false);
});

test('unknown password-reset email gets the same accepted result without account enumeration', async () => {
  const adapter = createWorkOSAuth({
    workos: { userManagement: { async createPasswordReset() { throw Object.assign(new Error('unknown user'), { status: 404 }); } } },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService(),
  });
  assert.deepEqual(await adapter.startPasswordReset({ email: 'unknown@example.test' }), {
    accepted: true, email: 'unknown@example.test',
  });
});

test('password authentication maps invalid credentials without exposing provider messages', async () => {
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        async authenticateWithPassword() {
          throw Object.assign(new Error('sensitive provider body'), {
            status: 400, rawData: { code: 'invalid_credentials', message: 'sensitive provider body' },
          });
        },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService(),
  });
  await assert.rejects(adapter.signInWithPassword({ email: 'person@example.test', password: 'wrong password' }), (error) => {
    assert.equal(error.code, 'invalid_email_or_password');
    assert.equal(error.status, 401);
    assert.equal(error.message.includes('sensitive provider body'), false);
    return true;
  });
});

test('WorkOS OAuth callback rejects Magic Auth even if an authorization code is presented', async () => {
  let sessionCreated = false;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        async authenticateWithCode() {
          return {
            authenticationMethod: 'MagicAuth',
            user: { id: 'user_magic', email: 'person@example.test', emailVerified: true },
          };
        },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService({ session: async () => { sessionCreated = true; throw new Error('must_not_run'); } }),
  });
  await assert.rejects(adapter.completeLogin({ code: 'magic-auth-code' }), (error) => {
    assert.equal(error.code, 'password_auth_required');
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(sessionCreated, false);
});

test('WorkOS OAuth callback exchanges authorization code and maps only verified identity into Keus', async () => {
  let exchange;
  let session;
  const adapter = createWorkOSAuth({
    workos: {
      userManagement: {
        async authenticateWithCode(value) {
          exchange = value;
          return {
            accessToken: 'never-persist-this', refreshToken: 'never-persist-this-either',
            user: { id: 'user_123', email: 'person@example.test', emailVerified: true, firstName: 'Keus', lastName: 'Tester' },
          };
        },
      },
    },
    clientId: 'client_kues',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService: authService({ session: async (value) => { session = value; return { user: { id: 'local-1' }, sessionToken: 'token' }; } }),
  });

  const result = await adapter.completeLogin({ code: 'one-time-code', ipAddress: '127.0.0.1', userAgent: 'test-agent' });
  assert.deepEqual(exchange, {
    code: 'one-time-code', clientId: 'client_kues', ipAddress: '127.0.0.1', userAgent: 'test-agent',
  });
  assert.deepEqual(session, {
    providerSubject: 'user_123', email: 'person@example.test', emailVerified: true,
    displayName: 'Keus Tester', now: undefined,
  });
  assert.deepEqual(result.user, { id: 'local-1' });
  assert.equal('accessToken' in result, false);
});
