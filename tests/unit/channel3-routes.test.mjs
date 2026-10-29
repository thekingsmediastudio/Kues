import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import { createServer } from '../../apps/web/server.mjs';
import { createAuthService } from '../../apps/web/lib/auth/service.mjs';
import { createWorkspaceService } from '../../apps/web/lib/workspaces/service.mjs';
import { createChannel3Client } from '../../apps/web/lib/channel3/client.mjs';

async function withServer(config, { authService = null, workspaceService = null, channel3Client = null, db = null } = {}, run) {
  const server = createServer({
    config,
    authService,
    workspaceService,
    channel3Client,
    db,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function setupContext() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);

  const authService = createAuthService({ db });
  const workspaceService = createWorkspaceService({ db });

  const session = await authService.createWorkOSSession({
    providerSubject: 'sub_test_c3_route_user',
    email: 'c3test@example.test',
    emailVerified: true,
    displayName: 'C3 Tester',
  });

  const bootstrap = await workspaceService.getBootstrap({ userId: session.user.id });

  return {
    db,
    authService,
    workspaceService,
    sessionToken: session.sessionToken,
    user: session.user,
    workspace: bootstrap.workspace,
    agent: bootstrap.agents[0],
  };
}

test('product discovery route rejects unauthenticated requests with 401', async () => {
  const ctx = await setupContext();
  const config = loadServerConfig({});

  await withServer(config, ctx, async (base) => {
    const res = await fetch(`${base}/api/products/search?q=sweater`);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error, 'authentication_required');
  });
});

test('product discovery route validates query parameter q', async () => {
  const ctx = await setupContext();
  const config = loadServerConfig({});

  await withServer(config, ctx, async (base) => {
    const res = await fetch(`${base}/api/products/search?q=   `, {
      headers: { Cookie: `kues_session=${ctx.sessionToken}` },
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'query_required');
  });
});

test('product discovery route uses fixture fallback when unconfigured, ties evidence to a run', async () => {
  const ctx = await setupContext();
  const config = loadServerConfig({});
  const client = createChannel3Client({ apiKey: '' });

  await withServer(config, { ...ctx, channel3Client: client }, async (base) => {
    const res = await fetch(`${base}/api/products/search?q=ceramic`, {
      headers: { Cookie: `kues_session=${ctx.sessionToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.isLive, false);
    assert.equal(json.notice, 'sample_fixture');
    assert.ok(json.products.length > 0);
    assert.ok(json.runId);

    // Verify run and offers were tied together in DB
    const offersRes = await fetch(`${base}/api/products/offers?runId=${json.runId}`, {
      headers: { Cookie: `kues_session=${ctx.sessionToken}` },
    });
    assert.equal(offersRes.status, 200);
    const offersJson = await offersRes.json();
    assert.equal(offersJson.ok, true);
    assert.equal(offersJson.count, json.products.length);
    assert.equal(offersJson.offers[0].merchantDomain, 'studiokera.example.com');
    assert.match(offersJson.offers[0].evidenceHash, /^sha256:[a-f0-9]{64}$/);
  });
});

test('product discovery route dispatches to live Channel3 client when configured', async () => {
  const ctx = await setupContext();
  const config = loadServerConfig({ CHANNEL3_API_KEY: 'sk_live_dummy_key' });

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        products: [
          {
            id: 'c3_live_123',
            title: 'Mechanical Keyring Carabiner',
            brand: 'Orbit',
            offers: [
              {
                price: 42.50,
                currency: 'USD',
                merchant: 'Orbit Gear',
                merchant_domain: 'orbitgear.example.com',
                url: 'https://orbitgear.example.com/carabiner',
                availability: 'in_stock',
              },
            ],
          },
        ],
      };
    },
  });

  const liveClient = createChannel3Client({
    apiKey: 'sk_live_dummy_key',
    fetchImpl: mockFetch,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  await withServer(config, { ...ctx, channel3Client: liveClient }, async (base) => {
    const res = await fetch(`${base}/api/products/search?q=carabiner`, {
      headers: { Cookie: `kues_session=${ctx.sessionToken}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.isLive, true);
    assert.equal(json.source, 'channel3');
    assert.equal(json.count, 1);
    assert.equal(json.products[0].id, 'c3_live_123');
    assert.equal(json.products[0].title, 'Mechanical Keyring Carabiner');
    assert.equal(json.products[0].amountMinor, 4250);
    assert.match(json.products[0].evidenceHash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(json.runId);

    // Verify persisted offer in DB
    const offersRes = await fetch(`${base}/api/products/offers?runId=${json.runId}`, {
      headers: { Cookie: `kues_session=${ctx.sessionToken}` },
    });
    assert.equal(offersRes.status, 200);
    const offersJson = await offersRes.json();
    assert.equal(offersJson.count, 1);
    assert.equal(offersJson.offers[0].source, 'channel3');
    assert.equal(offersJson.offers[0].merchantDomain, 'orbitgear.example.com');
  });
});

test('product offers endpoint validates method and runId', async () => {
  const ctx = await setupContext();
  const config = loadServerConfig({});

  await withServer(config, ctx, async (base) => {
    const postRes = await fetch(`${base}/api/products/offers?runId=test`, {
      method: 'POST',
      headers: { Cookie: `kues_session=${ctx.sessionToken}` },
    });
    assert.equal(postRes.status, 405);

    const noRunRes = await fetch(`${base}/api/products/offers`, {
      headers: { Cookie: `kues_session=${ctx.sessionToken}` },
    });
    assert.equal(noRunRes.status, 400);
    const json = await noRunRes.json();
    assert.equal(json.error, 'run_id_required');
  });
});
