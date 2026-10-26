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
    { sql: "INSERT INTO usage_periods(id, workspace_id, entitlement_id, plan_id, starts_at, ends_at, token_limit) VALUES ('up1', 'w1', 'e1', 'p1', '2025-12-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', ?) ", args: [tokenLimit] },
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

test('failed provider calls can release their reservation without spending quota', async () => {
  const db = await createTestDb({ tokenLimit: 100 });
  try {
    await reserveTokens(db, { workspaceId: 'w1', userId: 'u1', runId: 'r1', idempotencyKey: 'request-release', estimatedTokens: 60, now });
    const release = await releaseTokenReservation(db, { workspaceId: 'w1', idempotencyKey: 'request-release' });
    assert.equal(release.status, 'released');
    assert.equal(release.duplicate, false);
    const duplicate = await releaseTokenReservation(db, { workspaceId: 'w1', idempotencyKey: 'request-release' });
    assert.equal(duplicate.duplicate, true);
    const totals = await db.execute("SELECT consumed_tokens, reserved_tokens FROM usage_periods WHERE id = 'up1'");
    assert.equal(Number(totals.rows[0].consumed_tokens), 0);
    assert.equal(Number(totals.rows[0].reserved_tokens), 0);
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
