import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOSAuth } from '../../apps/web/lib/auth/workos-auth.mjs';

const authService = {
  async reserveWorkOSCodeRequest() { return { email: 'person@example.test', expiresAt: '2026-10-27T09:10:00.000Z' }; },
  async createWorkOSSession() { throw new Error('settings_tests_must_not_create_sessions'); },
};

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

test('password changes re-authenticate the current password before calling WorkOS updateUser', async () => {
  const calls = { authentication: null, update: null };
  const adapter = createWorkOSAuth({
    workos: { userManagement: {
      async authenticateWithPassword(input) {
        calls.authentication = input;
        return { user: { id: 'workos-password-owner', email: input.email, emailVerified: true } };
      },
      async updateUser(input) { calls.update = input; return { id: input.userId }; },
    } },
    clientId: 'client-settings',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService,
  });
  const result = await adapter.changePassword({
    userId: 'workos-password-owner', email: 'Person@Example.test',
    currentPassword: 'current secure password', newPassword: 'new secure password',
    ipAddress: '127.0.0.1', userAgent: 'settings-test',
  });
  assert.deepEqual(calls.authentication, {
    clientId: 'client-settings', email: 'person@example.test', password: 'current secure password',
    ipAddress: '127.0.0.1', userAgent: 'settings-test',
  });
  assert.deepEqual(calls.update, { userId: 'workos-password-owner', password: 'new secure password' });
  assert.deepEqual(result, { passwordUpdated: true });

  let updated = false;
  const rejected = createWorkOSAuth({
    workos: { userManagement: {
      async authenticateWithPassword() {
        throw Object.assign(new Error('private provider response'), { status: 401, rawData: { code: 'invalid_credentials' } });
      },
      async updateUser() { updated = true; },
    } },
    clientId: 'client-settings',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService,
  });
  await assert.rejects(rejected.changePassword({
    userId: 'workos-password-owner', email: 'person@example.test',
    currentPassword: 'wrong password', newPassword: 'new secure password',
  }), (error) => error.code === 'invalid_email_or_password' && error.status === 401);
  assert.equal(updated, false);
});

test('email-change send uses the documented WorkOS endpoint and sends only the requested new address', async () => {
  const requests = [];
  const adapter = createWorkOSAuth({
    workos: { userManagement: {} },
    clientId: 'client-settings',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService,
    apiKey: 'server-only-workos-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(200, { expires_at: '2026-10-27T09:10:00.000Z' });
    },
  });
  const result = await adapter.sendEmailChangeCode({ userId: 'user_settings_123', newEmail: 'New.Person@Example.test' });
  assert.equal(result.newEmail, 'new.person@example.test');
  assert.equal(result.expiresAt, '2026-10-27T09:10:00.000Z');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.workos.com/user_management/users/user_settings_123/email_change/send');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer server-only-workos-secret');
  assert.deepEqual(JSON.parse(requests[0].options.body), { new_email: 'new.person@example.test' });
});

test('email-change confirmation requires six digits and verifies the provider-returned identity and email', async () => {
  const requests = [];
  const adapter = createWorkOSAuth({
    workos: { userManagement: {} },
    clientId: 'client-settings',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService,
    apiKey: 'server-only-workos-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(200, { user: { id: 'user_settings_123', email: 'new.person@example.test', email_verified: true } });
    },
  });
  const confirmed = await adapter.confirmEmailChange({
    userId: 'user_settings_123', code: '123456', expectedEmail: 'New.Person@Example.test',
  });
  assert.deepEqual(confirmed.user, {
    id: 'user_settings_123', email: 'new.person@example.test', emailVerified: true,
    firstName: null, lastName: null, profilePictureUrl: null,
  });
  assert.equal(requests[0].url, 'https://api.workos.com/user_management/users/user_settings_123/email_change/confirm');
  assert.deepEqual(JSON.parse(requests[0].options.body), { code: '123456' });

  await assert.rejects(adapter.confirmEmailChange({
    userId: 'user_settings_123', code: '12x456', expectedEmail: 'new.person@example.test',
  }), (error) => error.code === 'invalid_email_change_code' && error.status === 400);
  await assert.rejects(adapter.confirmEmailChange({
    userId: 'user_settings_123', code: '654321', expectedEmail: 'different@example.test',
  }), (error) => error.code === 'email_change_confirmation_failed' && error.status === 502);
});

test('invalid WorkOS email code is generic and cannot update a local address', async () => {
  const adapter = createWorkOSAuth({
    workos: { userManagement: {} },
    clientId: 'client-settings',
    redirectUri: 'https://keus.example.test/auth/callback',
    authService,
    apiKey: 'server-only-workos-secret',
    fetchImpl: async () => response(400, { code: 'invalid_email_change_code', message: 'private provider details' }),
  });
  await assert.rejects(adapter.confirmEmailChange({
    userId: 'user_settings_123', code: '000000', expectedEmail: 'new.person@example.test',
  }), (error) => {
    assert.equal(error.code, 'invalid_email_change_code');
    assert.equal(error.status, 400);
    assert.equal(error.message.includes('private provider details'), false);
    return true;
  });
});
