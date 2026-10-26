import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { AuthError, createAuthService } from '../../apps/web/lib/auth/service.mjs';

const now = '2026-01-01T00:00:00.000Z';

async function createAuthDb() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  return db;
}

test('email sign-in is disabled without a delivery adapter and creates no bearer challenge', async () => {
  const db = await createAuthDb();
  try {
    const auth = createAuthService({ db });
    await assert.rejects(
      auth.requestEmailMagicLink({ email: 'person@example.test', now }),
      (error) => error instanceof AuthError && error.code === 'email_delivery_not_configured'
    );
    const count = await db.execute('SELECT COUNT(*) AS count FROM auth_challenges');
    assert.equal(Number(count.rows[0].count), 0);
  } finally {
    await db.close();
  }
});

test('magic link is stored as a hash, creates a one-time session, and can be revoked', async () => {
  const db = await createAuthDb();
  const sent = [];
  try {
    const auth = createAuthService({
      db,
      emailDelivery: { async sendMagicLink(message) { sent.push(message); } },
    });
    const accepted = await auth.requestEmailMagicLink({ email: 'Person@Example.test', now });
    assert.equal(accepted.accepted, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].email, 'person@example.test');
    assert.equal(Date.parse(sent[0].expiresAt) - Date.parse(now), 15 * 60 * 1000);

    const challenge = await db.execute('SELECT challenge_hash, identifier FROM auth_challenges');
    assert.equal(challenge.rows[0].identifier, 'person@example.test');
    assert.notEqual(challenge.rows[0].challenge_hash, sent[0].token);

    const login = await auth.consumeEmailMagicLink({ token: sent[0].token, now });
    assert.equal(login.user.email, 'person@example.test');
    assert.ok(login.sessionToken);
    assert.deepEqual(await auth.getSession({ token: login.sessionToken, now }), login.user);

    await assert.rejects(
      auth.consumeEmailMagicLink({ token: sent[0].token, now }),
      (error) => error instanceof AuthError && error.code === 'link_already_used'
    );

    assert.deepEqual(await auth.revokeSession({ token: login.sessionToken, now }), { revoked: true });
    assert.equal(await auth.getSession({ token: login.sessionToken, now }), null);
  } finally {
    await db.close();
  }
});

test('WorkOS email-code request ledger stores no code and enforces provider-aligned rate limits', async () => {
  const db = await createAuthDb();
  try {
    const auth = createAuthService({ db });
    for (let index = 0; index < 3; index += 1) {
      const reserved = await auth.reserveWorkOSCodeRequest({
        email: 'Person@Example.test',
        now: new Date(Date.parse(now) + index * 1000).toISOString(),
      });
      assert.equal(reserved.email, 'person@example.test');
      assert.equal(Date.parse(reserved.expiresAt) - (Date.parse(now) + index * 1000), 10 * 60 * 1000);
    }
    await assert.rejects(
      auth.reserveWorkOSCodeRequest({ email: 'person@example.test', now: new Date(Date.parse(now) + 4000).toISOString() }),
      (error) => error instanceof AuthError && error.code === 'too_many_sign_in_requests' && error.status === 429
    );
    const rows = await db.execute({
      sql: "SELECT purpose, identifier, challenge_hash FROM auth_challenges WHERE purpose = 'workos_email_code'",
    });
    assert.equal(rows.rows.length, 3);
    assert.ok(rows.rows.every((row) => row.identifier === 'person@example.test'));
    assert.ok(rows.rows.every((row) => !/^\\d{6}$/.test(row.challenge_hash)));
  } finally {
    await db.close();
  }
});

test('verified WorkOS identity links to the matching Keus account and creates local sessions', async () => {
  const db = await createAuthDb();
  const delivered = [];
  try {
    const auth = createAuthService({
      db,
      emailDelivery: { async sendMagicLink(message) { delivered.push(message); } },
    });
    const emailChallenge = await auth.requestEmailMagicLink({ email: 'Person@Example.test', now });
    const emailLogin = await auth.consumeEmailMagicLink({ token: delivered[0].token, now });

    const workosLogin = await auth.createWorkOSSession({
      providerSubject: 'user_workos_123',
      email: 'person@example.test',
      emailVerified: true,
      displayName: 'Keus User',
      now,
    });
    assert.equal(workosLogin.user.id, emailLogin.user.id);
    assert.equal(workosLogin.user.email, emailLogin.user.email);
    assert.equal(workosLogin.isNewUser, false);
    assert.ok(await auth.getSession({ token: workosLogin.sessionToken, now }));

    const again = await auth.createWorkOSSession({
      providerSubject: 'user_workos_123',
      email: 'person@example.test',
      emailVerified: true,
      now,
    });
    assert.equal(again.user.id, emailLogin.user.id);
    assert.equal(again.isNewUser, false);
    const identities = await db.execute({
      sql: 'SELECT provider, provider_subject FROM auth_identities WHERE user_id = ? ORDER BY provider',
      args: [emailLogin.user.id],
    });
    assert.deepEqual(identities.rows.map((row) => [row.provider, row.provider_subject]), [
      ['email_magic_link', 'person@example.test'],
      ['workos', 'user_workos_123'],
    ]);

    await assert.rejects(
      auth.createWorkOSSession({
        providerSubject: 'user_unverified',
        email: 'unverified@example.test',
        emailVerified: false,
        now,
      }),
      (error) => error instanceof AuthError && error.code === 'email_not_verified'
    );
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS count FROM users')).rows[0].count), 1);
  } finally {
    await db.close();
  }
});

test('first verified WorkOS identity creates a Keus user and authenticated session', async () => {
  const db = await createAuthDb();
  try {
    const auth = createAuthService({ db });
    const result = await auth.createWorkOSSession({
      providerSubject: 'workos_new_user_1', email: 'new.person@example.test', emailVerified: true,
      displayName: 'New Person', now,
    });
    assert.equal(result.user.email, 'new.person@example.test');
    assert.equal(result.isNewUser, true);
    assert.equal(result.user.displayName, 'New Person');
    assert.ok(await auth.getSession({ token: result.sessionToken, now }));
    const userCount = await db.execute('SELECT COUNT(*) AS count FROM users');
    assert.equal(Number(userCount.rows[0].count), 1);
  } finally { await db.close(); }
});

test('email sign-in requests are rate limited per normalized address', async () => {
  const db = await createAuthDb();
  try {
    const auth = createAuthService({ db, emailDelivery: { async sendMagicLink() {} } });
    for (let i = 0; i < 5; i += 1) {
      await auth.requestEmailMagicLink({ email: 'limit@example.test', now });
    }
    await assert.rejects(
      auth.requestEmailMagicLink({ email: 'LIMIT@example.test', now }),
      (error) => error instanceof AuthError && error.code === 'too_many_sign_in_requests' && error.status === 429
    );
  } finally {
    await db.close();
  }
});
