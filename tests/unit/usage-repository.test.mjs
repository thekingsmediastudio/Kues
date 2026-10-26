import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { applyMigrations, MigrationDriftError } from '../../apps/web/lib/db/migrate.mjs';
import {
  reserveTokens,
  releaseTokenReservation,
  settleTokenReservation,
  UsageLimitError,
  UsageReservationError,
} from '../../apps/web/lib/db/usage.mjs';

const now = '2026-01-01T00:00:00.000Z';

async function seedTestDb(db, { tokenLimit = 100 } = {}) {
  await applyMigrations(db);
  await db.batch([
    { sql: "INSERT INTO users(id, email_normalized) VALUES ('u1', 'u1@example.test')" },
    { sql: "INSERT INTO workspaces(id, owner_user_id, name) VALUES ('w1', 'u1', 'Test')" },
    { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w1', 'u1', 'owner')" },
    { sql: "INSERT INTO plans(id, code, display_name, billing_interval, included_tokens) VALUES ('p1', 'competition', 'Competition', 'competition', ?) ", args: [tokenLimit] },
    { sql: "INSERT INTO entitlements(id, workspace_id, plan_id, source, starts_at, ends_at) VALUES ('e1', 'w1', 'p1', 'competition', '2025-12-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')" },
    { sql: "INSERT INTO agents(id, workspace_id, name, role) VALUES ('a1', 'w1', 'Scout', 'web_scout')" },
    { sql: "INSERT INTO runs(id, workspace_id, user_id, agent_id, goal, status) VALUES ('r1', 'w1', 'u1', 'a1', 'Find a product', 'running')" },
    { sql: "INSERT INTO usage_periods(id, workspace_id, entitlement_id, plan_id, starts_at, ends_at, token_limit) VALUES ('up1', 'w1', 'e1', 'p1', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ?) ", args: [tokenLimit] },
  ], 'write');
  return db;
}

async function createTestDb(options = {}) {
  return seedTestDb(createClient({ url: ':memory:' }), options);
}

test('migrations apply once, are repeatable, and detect edits to an applied migration', async () => {
  const db = createClient({ url: ':memory:' });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'keus-migrations-'));
  try {
    await fs.copyFile(
      new URL('../../apps/web/migrations/0001_core.sql', import.meta.url),
      path.join(tmp, '0001_core.sql')
    );
    const first = await applyMigrations(db, { migrationsDir: tmp });
    const second = await applyMigrations(db, { migrationsDir: tmp });
    assert.deepEqual(first.applied, ['0001_core.sql']);
    assert.deepEqual(second.applied, []);
    await fs.appendFile(path.join(tmp, '0001_core.sql'), '\n-- changed after apply\n');
    await assert.rejects(applyMigrations(db, { migrationsDir: tmp }), MigrationDriftError);
  } finally {
    await db.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('account quota migration aggregates prior competition usage across workspaces', async () => {
  const db = createClient({ url: ':memory:' });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'keus-account-backfill-'));
  try {
    for (const name of [
      '0001_core.sql',
      '0002_workos_identity.sql',
      '0003_workos_email_code_requests.sql',
      '0004_api_hub.sql',
      '0005_workspace_onboarding.sql',
    ]) {
      await fs.copyFile(
        new URL(`../../apps/web/migrations/${name}`, import.meta.url),
        path.join(tmp, name),
      );
    }
    await applyMigrations(db, { migrationsDir: tmp });
    await db.batch([
      { sql: "INSERT INTO users(id, email_normalized) VALUES ('u1', 'u1@example.test')" },
      { sql: "INSERT INTO users(id, email_normalized) VALUES ('u2', 'u2@example.test')" },
      { sql: "INSERT INTO workspaces(id, owner_user_id, name) VALUES ('w1', 'u1', 'First')" },
      { sql: "INSERT INTO workspaces(id, owner_user_id, name) VALUES ('w2', 'u2', 'Second')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w1', 'u1', 'owner')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w2', 'u2', 'owner')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w2', 'u1', 'member')" },
      { sql: "INSERT INTO plans(id, code, display_name, billing_interval, included_tokens) VALUES ('p1', 'competition', 'Competition', 'competition', 100)" },
      { sql: "INSERT INTO entitlements(id, workspace_id, plan_id, source, starts_at, ends_at) VALUES ('e1', 'w1', 'p1', 'competition', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')" },
      { sql: "INSERT INTO entitlements(id, workspace_id, plan_id, source, starts_at, ends_at) VALUES ('e2', 'w2', 'p1', 'competition', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')" },
      { sql: "INSERT INTO usage_periods(id, workspace_id, entitlement_id, plan_id, starts_at, ends_at, token_limit, consumed_tokens, reserved_tokens) VALUES ('up1', 'w1', 'e1', 'p1', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 100, 25, 0)" },
      { sql: "INSERT INTO usage_periods(id, workspace_id, entitlement_id, plan_id, starts_at, ends_at, token_limit, consumed_tokens, reserved_tokens) VALUES ('up2', 'w2', 'e2', 'p1', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 100, 0, 40)" },
      { sql: "INSERT INTO usage_reservations(id, usage_period_id, workspace_id, user_id, idempotency_key, reserved_tokens, actual_tokens, status, expires_at, settled_at) VALUES ('ur1', 'up1', 'w1', 'u1', 'legacy-settled', 50, 25, 'settled', '2026-01-01T00:10:00.000Z', '2026-01-01T00:01:00.000Z')" },
      { sql: "INSERT INTO usage_reservations(id, usage_period_id, workspace_id, user_id, idempotency_key, reserved_tokens, status, expires_at) VALUES ('ur2', 'up2', 'w2', 'u1', 'legacy-open', 40, 'reserved', '2026-01-01T00:10:00.000Z')" },
      { sql: "INSERT INTO usage_events(id, workspace_id, usage_period_id, reservation_id, user_id, event_key, provider, model, input_tokens, output_tokens, total_tokens, occurred_at) VALUES ('ue1', 'w1', 'up1', 'ur1', 'u1', 'usage:legacy-settled', 'test', 'model', 10, 15, 25, '2026-01-01T00:01:00.000Z')" },
    ], 'write');

    const migration = await applyMigrations(db);
    assert.ok(migration.applied.includes('0006_account_usage_quota.sql'));
    const account = await db.execute("SELECT * FROM account_usage_periods WHERE user_id = 'u1'");
    assert.equal(account.rows.length, 1);
    assert.equal(Number(account.rows[0].consumed_tokens), 25);
    assert.equal(Number(account.rows[0].reserved_tokens), 40);
    assert.equal(Number(account.rows[0].token_limit), 100);

    const reservations = await db.execute("SELECT account_usage_period_id FROM usage_reservations WHERE id IN ('ur1', 'ur2') ORDER BY id");
    assert.deepEqual(reservations.rows.map((row) => row.account_usage_period_id), [account.rows[0].id, account.rows[0].id]);
    const event = await db.execute("SELECT account_usage_period_id FROM usage_events WHERE id = 'ue1'");
    assert.equal(event.rows[0].account_usage_period_id, account.rows[0].id);
    const scopes = await db.execute("SELECT quota_scope FROM usage_periods ORDER BY id");
    assert.deepEqual(scopes.rows.map((row) => row.quota_scope), ['account', 'account']);
  } finally {
    await db.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('token reservations enforce caps, settle provider usage once, and support idempotent retries', async () => {
  const db = await createTestDb({ tokenLimit: 100 });
  try {
    const input = { workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'request-1', estimatedTokens: 80, now };
    const reservation = await reserveTokens(db, input);
    assert.equal(reservation.status, 'reserved');
    assert.equal(reservation.duplicate, false);

    const retry = await reserveTokens(db, input);
    assert.equal(retry.reservationId, reservation.reservationId);
    assert.equal(retry.duplicate, true);

    await assert.rejects(
      reserveTokens(db, { ...input, idempotencyKey: 'request-2', estimatedTokens: 30 }),
      UsageLimitError
    );

    const settlement = await settleTokenReservation(db, {
      workspaceId: 'w1', idempotencyKey: 'request-1', provider: 'workers-ai', model: 'test-model',
      inputTokens: 18, outputTokens: 22, occurredAt: now,
    });
    assert.equal(settlement.totalTokens, 40);
    assert.equal(settlement.duplicate, false);

    const retrySettlement = await settleTokenReservation(db, {
      workspaceId: 'w1', idempotencyKey: 'request-1', provider: 'workers-ai', model: 'test-model',
      inputTokens: 18, outputTokens: 22, occurredAt: now,
    });
    assert.equal(retrySettlement.duplicate, true);

    const totals = await db.execute("SELECT consumed_tokens, reserved_tokens FROM usage_periods WHERE id = 'up1'");
    assert.equal(Number(totals.rows[0].consumed_tokens), 40);
    assert.equal(Number(totals.rows[0].reserved_tokens), 0);
    const events = await db.execute("SELECT input_tokens, output_tokens, total_tokens FROM usage_events WHERE workspace_id = 'w1'");
    assert.deepEqual(events.rows.map((row) => [Number(row.input_tokens), Number(row.output_tokens), Number(row.total_tokens)]), [[18, 22, 40]]);
  } finally {
    await db.close();
  }
});

test('competition quota is per account across workspaces and separate for users sharing one workspace', async () => {
  const db = await createTestDb({ tokenLimit: 100 });
  try {
    await db.batch([
      { sql: "INSERT INTO users(id, email_normalized) VALUES ('u2', 'u2@example.test')" },
      { sql: "INSERT INTO workspaces(id, owner_user_id, name) VALUES ('w2', 'u2', 'Second workspace')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w1', 'u2', 'member')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w2', 'u2', 'owner')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w2', 'u1', 'member')" },
      { sql: "INSERT INTO entitlements(id, workspace_id, plan_id, source, starts_at, ends_at) VALUES ('e2', 'w2', 'p1', 'competition', '2025-12-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')" },
      { sql: "INSERT INTO agents(id, workspace_id, name, role) VALUES ('a2', 'w2', 'Second scout', 'web_scout')" },
      { sql: "INSERT INTO runs(id, workspace_id, user_id, agent_id, goal, status) VALUES ('r2', 'w2', 'u1', 'a2', 'Second workspace run', 'running')" },
      { sql: "INSERT INTO runs(id, workspace_id, user_id, agent_id, goal, status) VALUES ('r3', 'w1', 'u2', 'a1', 'Shared workspace run', 'running')" },
    ], 'write');

    const first = await reserveTokens(db, {
      workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'u1-w1-first', estimatedTokens: 60, now,
    });
    const second = await reserveTokens(db, {
      workspaceId: 'w2', userId: 'u1', runId: 'r2', idempotencyKey: 'u1-w2-second', estimatedTokens: 40, now,
    });
    assert.equal(first.accountUsagePeriodId, second.accountUsagePeriodId);
    await assert.rejects(
      reserveTokens(db, {
        workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'u1-over-cap', estimatedTokens: 1, now,
      }),
      (error) => error instanceof UsageLimitError
        && error.limit === 100 && error.consumed === 0 && error.reserved === 100,
    );

    await settleTokenReservation(db, {
      workspaceId: 'w1', idempotencyKey: 'u1-w1-first', provider: 'workers-ai', model: 'test-model',
      inputTokens: 20, outputTokens: 30, occurredAt: now,
    });
    const afterSettlement = await db.execute({
      sql: 'SELECT consumed_tokens, reserved_tokens FROM account_usage_periods WHERE id = ?',
      args: [first.accountUsagePeriodId],
    });
    assert.equal(Number(afterSettlement.rows[0].consumed_tokens), 50);
    assert.equal(Number(afterSettlement.rows[0].reserved_tokens), 40);

    await reserveTokens(db, {
      workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'u1-w1-final-ten', estimatedTokens: 10, now,
    });
    await assert.rejects(
      reserveTokens(db, {
        workspaceId: 'w2', userId: 'u1', runId: 'r2', idempotencyKey: 'u1-final-over', estimatedTokens: 1, now,
      }),
      UsageLimitError,
    );

    // A second account in the shared workspace receives its own full daily allowance.
    const otherAccount = await reserveTokens(db, {
      workspaceId: 'w1', userId: 'u2', runId: 'r3', idempotencyKey: 'u2-full-quota', estimatedTokens: 100, now,
    });
    assert.notEqual(otherAccount.accountUsagePeriodId, first.accountUsagePeriodId);
    const accountRows = await db.execute({
      sql: 'SELECT user_id, consumed_tokens, reserved_tokens FROM account_usage_periods ORDER BY user_id',
    });
    assert.deepEqual(accountRows.rows.map((row) => [
      row.user_id, Number(row.consumed_tokens), Number(row.reserved_tokens),
    ]), [['u1', 50, 50], ['u2', 0, 100]]);

    const workspacePeriod = await db.execute({
      sql: "SELECT quota_scope, reserved_tokens FROM usage_periods WHERE workspace_id = 'w1'",
    });
    assert.equal(workspacePeriod.rows[0].quota_scope, 'account');
    assert.ok(Number(workspacePeriod.rows[0].reserved_tokens) > 100);
  } finally {
    await db.close();
  }
});

test('expired competition reservations release account quota across workspaces', async () => {
  const db = await createTestDb({ tokenLimit: 100 });
  try {
    await db.batch([
      { sql: "INSERT INTO users(id, email_normalized) VALUES ('u2', 'u2@example.test')" },
      { sql: "INSERT INTO workspaces(id, owner_user_id, name) VALUES ('w2', 'u2', 'Second workspace')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w2', 'u2', 'owner')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w2', 'u1', 'member')" },
      { sql: "INSERT INTO entitlements(id, workspace_id, plan_id, source, starts_at, ends_at) VALUES ('e2', 'w2', 'p1', 'competition', '2025-12-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')" },
      { sql: "INSERT INTO agents(id, workspace_id, name, role) VALUES ('a2', 'w2', 'Second scout', 'web_scout')" },
      { sql: "INSERT INTO runs(id, workspace_id, user_id, agent_id, goal, status) VALUES ('r2', 'w2', 'u1', 'a2', 'Second workspace run', 'running')" },
    ], 'write');

    const expired = await reserveTokens(db, {
      workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'stale-first',
      estimatedTokens: 60, now, ttlSeconds: 1,
    });
    const replacement = await reserveTokens(db, {
      workspaceId: 'w2', userId: 'u1', runId: 'r2', idempotencyKey: 'stale-replacement',
      estimatedTokens: 100, now: '2026-01-01T00:00:02.000Z',
    });
    assert.equal(replacement.accountUsagePeriodId, expired.accountUsagePeriodId);

    const old = await db.execute({
      sql: "SELECT status FROM usage_reservations WHERE idempotency_key = 'stale-first'",
    });
    assert.equal(old.rows[0].status, 'expired');
    const account = await db.execute({
      sql: 'SELECT consumed_tokens, reserved_tokens FROM account_usage_periods WHERE id = ?',
      args: [expired.accountUsagePeriodId],
    });
    assert.equal(Number(account.rows[0].consumed_tokens), 0);
    assert.equal(Number(account.rows[0].reserved_tokens), 100);
    const workspace = await db.execute("SELECT reserved_tokens FROM usage_periods WHERE workspace_id = 'w1'");
    assert.equal(Number(workspace.rows[0].reserved_tokens), 0);
  } finally {
    await db.close();
  }
});

test('competition token quota resets by UTC day and expires at the configured entitlement boundary', async () => {
  const db = await createTestDb({ tokenLimit: 100 });
  try {
    const first = await reserveTokens(db, {
      workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'day-one', estimatedTokens: 80, now,
    });
    await settleTokenReservation(db, {
      workspaceId: 'w1', idempotencyKey: 'day-one', provider: 'workers-ai', model: 'test-model',
      inputTokens: 50, outputTokens: 30, occurredAt: now,
    });
    await assert.rejects(
      reserveTokens(db, {
        workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'day-one-over-cap', estimatedTokens: 21, now,
      }),
      UsageLimitError,
    );

    const nextDay = await reserveTokens(db, {
      workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'day-two', estimatedTokens: 80,
      now: '2026-01-02T00:00:00.000Z',
    });
    assert.equal(nextDay.status, 'reserved');
    const periods = await db.execute("SELECT starts_at, token_limit, consumed_tokens, reserved_tokens FROM usage_periods WHERE workspace_id = 'w1' ORDER BY starts_at");
    assert.equal(periods.rows.length, 2);
    assert.equal(periods.rows[0].starts_at, '2026-01-01T00:00:00.000Z');
    assert.equal(periods.rows[1].starts_at, '2026-01-02T00:00:00.000Z');
    assert.equal(Number(periods.rows[1].token_limit), 100);
    assert.equal(Number(periods.rows[1].reserved_tokens), 80);

    await assert.rejects(
      reserveTokens(db, {
        workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'after-competition', estimatedTokens: 1,
        now: '2026-02-01T00:00:00.000Z',
      }),
      (error) => error instanceof UsageReservationError && error.code === 'active_entitlement_required',
    );
  } finally {
    await db.close();
  }
});

test('metered usage after competition requires an active paid subscription entitlement', async () => {
  const db = await createTestDb({ tokenLimit: 100 });
  try {
    await db.batch([
      { sql: "INSERT INTO plans(id, code, display_name, billing_interval, included_tokens) VALUES ('p2', 'paid-monthly', 'Paid monthly', 'month', 500)" },
      { sql: "INSERT INTO subscriptions(id, workspace_id, plan_id, provider, external_subscription_id, status, current_period_start, current_period_end) VALUES ('s1', 'w1', 'p2', 'test-provider', 'sub-1', 'active', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')" },
      { sql: "INSERT INTO entitlements(id, workspace_id, plan_id, subscription_id, source, starts_at, ends_at) VALUES ('e2', 'w1', 'p2', 's1', 'subscription', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')" },
    ], 'write');
    const reservation = await reserveTokens(db, {
      workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'paid-period', estimatedTokens: 450,
      now: '2026-02-10T12:00:00.000Z',
    });
    assert.equal(reservation.status, 'reserved');
    const period = await db.execute({
      sql: "SELECT entitlement_id, plan_id, starts_at, ends_at, token_limit FROM usage_periods WHERE id = ?",
      args: [reservation.usagePeriodId],
    });
    assert.equal(period.rows[0].entitlement_id, 'e2');
    assert.equal(period.rows[0].plan_id, 'p2');
    assert.equal(period.rows[0].starts_at, '2026-02-01T00:00:00.000Z');
    assert.equal(Number(period.rows[0].token_limit), 500);

    await db.execute("UPDATE subscriptions SET status = 'past_due' WHERE id = 's1'");
    await assert.rejects(
      reserveTokens(db, {
        workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'past-due', estimatedTokens: 1,
        now: '2026-02-10T12:01:00.000Z',
      }),
      (error) => error instanceof UsageReservationError && error.code === 'active_entitlement_required',
    );
  } finally {
    await db.close();
  }
});

test('usage reservation checks workspace membership and run ownership', async () => {
  const db = await createTestDb({ tokenLimit: 100 });
  try {
    await db.execute("INSERT INTO users(id, email_normalized) VALUES ('u2', 'u2@example.test')");
    await assert.rejects(
      reserveTokens(db, { workspaceId: 'w1', userId: 'u2', idempotencyKey: 'other-workspace', estimatedTokens: 1, now }),
      (error) => error instanceof UsageReservationError && error.code === 'workspace_access_denied',
    );
    await db.execute("INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w1', 'u2', 'member')");
    await assert.rejects(
      reserveTokens(db, { workspaceId: 'w1', userId: 'u2', runId: 'r1', idempotencyKey: 'other-run', estimatedTokens: 1, now }),
      (error) => error instanceof UsageReservationError && error.code === 'run_access_denied',
    );
  } finally {
    await db.close();
  }
});

test('failed provider calls can release their reservation without spending quota', async () => {
  const db = await createTestDb({ tokenLimit: 100 });
  try {
    const reservation = await reserveTokens(db, {
      workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'request-release', estimatedTokens: 60, now,
    });
    const beforeRelease = await db.execute({
      sql: 'SELECT reserved_tokens FROM account_usage_periods WHERE id = ?',
      args: [reservation.accountUsagePeriodId],
    });
    assert.equal(Number(beforeRelease.rows[0].reserved_tokens), 60);
    const release = await releaseTokenReservation(db, { workspaceId: 'w1', idempotencyKey: 'request-release' });
    assert.equal(release.status, 'released');
    assert.equal(release.duplicate, false);
    const duplicate = await releaseTokenReservation(db, { workspaceId: 'w1', idempotencyKey: 'request-release' });
    assert.equal(duplicate.duplicate, true);
    const totals = await db.execute("SELECT consumed_tokens, reserved_tokens FROM usage_periods WHERE id = 'up1'");
    assert.equal(Number(totals.rows[0].consumed_tokens), 0);
    assert.equal(Number(totals.rows[0].reserved_tokens), 0);
    const accountTotals = await db.execute({
      sql: 'SELECT consumed_tokens, reserved_tokens FROM account_usage_periods WHERE id = ?',
      args: [reservation.accountUsagePeriodId],
    });
    assert.equal(Number(accountTotals.rows[0].consumed_tokens), 0);
    assert.equal(Number(accountTotals.rows[0].reserved_tokens), 0);
  } finally {
    await db.close();
  }
});

test('concurrent reservations cannot collectively exceed the active token limit', async () => {
  const db = await createTestDb({ tokenLimit: 100 });
  try {
    const base = { workspaceId: 'w1', userId: 'u1', runId: 'r1', estimatedTokens: 60, now };
    const results = await Promise.allSettled([
      reserveTokens(db, { ...base, idempotencyKey: 'parallel-a' }),
      reserveTokens(db, { ...base, idempotencyKey: 'parallel-b' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof UsageLimitError, String(rejected[0].reason));
    const totals = await db.execute("SELECT consumed_tokens, reserved_tokens FROM usage_periods WHERE id = 'up1'");
    assert.equal(Number(totals.rows[0].reserved_tokens), 60);
  } finally {
    await db.close();
  }
});

test('independent database clients cannot exceed one account quota through different workspaces', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'keus-account-race-'));
  const url = `file:${path.join(tmp, 'usage.db')}`;
  const first = createClient({ url });
  const second = createClient({ url });
  try {
    await seedTestDb(first, { tokenLimit: 100 });
    await applyMigrations(second);
    await first.batch([
      { sql: "INSERT INTO users(id, email_normalized) VALUES ('u2', 'u2@example.test')" },
      { sql: "INSERT INTO workspaces(id, owner_user_id, name) VALUES ('w2', 'u2', 'Second workspace')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w2', 'u2', 'owner')" },
      { sql: "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ('w2', 'u1', 'member')" },
      { sql: "INSERT INTO entitlements(id, workspace_id, plan_id, source, starts_at, ends_at) VALUES ('e2', 'w2', 'p1', 'competition', '2025-12-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')" },
      { sql: "INSERT INTO agents(id, workspace_id, name, role) VALUES ('a2', 'w2', 'Second scout', 'web_scout')" },
      { sql: "INSERT INTO runs(id, workspace_id, user_id, agent_id, goal, status) VALUES ('r2', 'w2', 'u1', 'a2', 'Second workspace run', 'running')" },
    ], 'write');

    const results = await Promise.allSettled([
      reserveTokens(first, {
        workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'account-race-a', estimatedTokens: 60, now,
      }),
      reserveTokens(second, {
        workspaceId: 'w2', userId: 'u1', runId: 'r2', idempotencyKey: 'account-race-b', estimatedTokens: 60, now,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected?.reason instanceof UsageLimitError, String(rejected?.reason));
    const totals = await first.execute("SELECT consumed_tokens, reserved_tokens FROM account_usage_periods WHERE user_id = 'u1'");
    assert.equal(Number(totals.rows[0].reserved_tokens), 60);
  } finally {
    await first.close();
    await second.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('independent local database clients retry write contention and still enforce the shared quota', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'keus-usage-race-'));
  const url = `file:${path.join(tmp, 'usage.db')}`;
  const first = createClient({ url });
  const second = createClient({ url });
  try {
    await seedTestDb(first, { tokenLimit: 100 });
    await applyMigrations(second);
    const base = { workspaceId: 'w1', userId: 'u1', runId: 'r1', estimatedTokens: 60, now };
    const results = await Promise.allSettled([
      reserveTokens(first, { ...base, idempotencyKey: 'remote-a' }),
      reserveTokens(second, { ...base, idempotencyKey: 'remote-b' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected?.reason instanceof UsageLimitError, String(rejected?.reason));
    const totals = await first.execute("SELECT consumed_tokens, reserved_tokens FROM usage_periods WHERE id = 'up1'");
    assert.equal(Number(totals.rows[0].reserved_tokens), 60);
  } finally {
    await first.close();
    await second.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
