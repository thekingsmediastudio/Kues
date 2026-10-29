import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createChannel3Client, Channel3Error } from '../../apps/web/lib/channel3/client.mjs';
import {
  createAgentRun,
  discoverProducts,
  getProductOffersForRun,
  recordDiscoveredOffers,
} from '../../apps/web/lib/channel3/discovery.mjs';

async function setupTestDatabase() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);

  const wsId = 'ws_discovery_test';
  const userId = 'usr_discovery_test';
  const agentId = 'ag_path_finder';

  await db.execute({
    sql: 'INSERT INTO users (id, email_normalized, status) VALUES (?, ?, ?)',
    args: [userId, 'shopper@example.test', 'active'],
  });
  await db.execute({
    sql: 'INSERT INTO workspaces (id, owner_user_id, name, status) VALUES (?, ?, ?, ?)',
    args: [wsId, userId, 'Discovery Workspace', 'active'],
  });
  await db.execute({
    sql: `INSERT INTO agents (workspace_id, id, name, role, avatar, status, settings_json)
          VALUES (?, ?, 'Path Finder', 'Web & commerce scout', 'magnifier', 'active', ?)`,
    args: [wsId, agentId, JSON.stringify({ color: '#4c8dff', approvalPath: 'desktop', orderCap: 10000, dailyCap: 20000 })],
  });

  return { db, wsId, userId, agentId };
}

test('createAgentRun creates a runs row and run_events entry', async () => {
  const { db, wsId, userId, agentId } = await setupTestDatabase();

  const run = await createAgentRun({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    goal: 'Find ceramic pitcher',
    mode: 'live_search',
  });

  assert.match(run.runId, /^run_[a-f0-9]{32}$/);
  assert.equal(run.status, 'running');
  assert.equal(run.mode, 'live_search');

  const inDbResult = await db.execute({
    sql: 'SELECT * FROM runs WHERE id = ?',
    args: [run.runId],
  });
  assert.equal(inDbResult.rows[0].goal, 'Find ceramic pitcher');

  const eventResult = await db.execute({
    sql: 'SELECT * FROM run_events WHERE run_id = ?',
    args: [run.runId],
  });
  assert.equal(eventResult.rows[0].event_type, 'run_started');
});

test('discoverProducts with sample fixtures ties evidence to a newly created run in DB', async () => {
  const { db, wsId, userId, agentId } = await setupTestDatabase();
  const client = createChannel3Client({ apiKey: '' });

  const result = await discoverProducts({
    channel3Client: client,
    query: 'ceramic',
    db,
    workspaceId: wsId,
    userId,
    agentId,
    allowFixtureFallback: true,
  });

  assert.equal(result.isLive, false);
  assert.equal(result.source, 'channel3_sample');
  assert.ok(result.runId);
  assert.equal(result.offersPersisted, true);
  assert.ok(result.products.length > 0);

  // Verify offers in DB
  const offers = await getProductOffersForRun({ db, workspaceId: wsId, runId: result.runId });
  assert.ok(offers.length > 0);
  assert.equal(offers[0].merchantDomain, 'studiokera.example.com');
  assert.equal(offers[0].amountMinor, 7850);
  assert.match(offers[0].evidenceHash, /^sha256:[a-f0-9]{64}$/);

  // Check run updated to completed
  const runRowResult = await db.execute({
    sql: 'SELECT status, completed_at FROM runs WHERE id = ?',
    args: [result.runId],
  });
  assert.equal(runRowResult.rows[0].status, 'completed');
  assert.ok(runRowResult.rows[0].completed_at);
});

test('discoverProducts with mock live Channel3 client persists live offers with isLive: true', async () => {
  const { db, wsId, userId, agentId } = await setupTestDatabase();

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        products: [
          {
            id: 'c3_live_mug',
            title: 'Handcrafted Ceramic Mug',
            brand: 'ClayWorks',
            offers: [
              {
                merchant: 'ClayWorks Shop',
                merchant_domain: 'clayworks.example.com',
                url: 'https://clayworks.example.com/mug',
                price: 32.0,
                currency: 'USD',
                availability: 'in_stock',
              },
            ],
          },
        ],
      };
    },
  });

  const client = createChannel3Client({
    apiKey: 'sk_live_test_api_key',
    fetchImpl: mockFetch,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  const result = await discoverProducts({
    channel3Client: client,
    query: 'mug',
    db,
    workspaceId: wsId,
    userId,
    agentId,
  });

  assert.equal(result.isLive, true);
  assert.equal(result.source, 'channel3');
  assert.equal(result.count, 1);
  assert.equal(result.products[0].merchantDomain, 'clayworks.example.com');
  assert.equal(result.products[0].amountMinor, 3200);

  const offers = await getProductOffersForRun({ db, workspaceId: wsId, runId: result.runId });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].title, 'Handcrafted Ceramic Mug');
  assert.equal(offers[0].source, 'channel3');
  assert.equal(offers[0].amountMinor, 3200);
});

test('discoverProducts fails honestly when Channel3 is unconfigured and fallback is disallowed', async () => {
  const { db, wsId, userId } = await setupTestDatabase();
  const unconfiguredClient = createChannel3Client({ apiKey: '' });

  await assert.rejects(
    async () => discoverProducts({
      channel3Client: unconfiguredClient,
      query: 'running shoes',
      db,
      workspaceId: wsId,
      userId,
      allowFixtureFallback: false,
    }),
    (err) => {
      assert(err instanceof Channel3Error);
      assert.equal(err.code, 'channel3_not_configured');
      assert.equal(err.status, 503);
      return true;
    }
  );
});
