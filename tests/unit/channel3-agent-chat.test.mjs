import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import { createServer } from '../../apps/web/server.mjs';
import { createAuthService } from '../../apps/web/lib/auth/service.mjs';
import { createWorkspaceService } from '../../apps/web/lib/workspaces/service.mjs';
import { createChannel3Client } from '../../apps/web/lib/channel3/client.mjs';
import { getProductOffersForRun } from '../../apps/web/lib/channel3/discovery.mjs';

async function withServer(config, { authService = null, workspaceService = null, aiChatService = null, aiChatHistoryService = null, aiProviderService = null, usageService = null, channel3Client = null, db = null } = {}, run) {
  const server = createServer({
    config,
    authService,
    workspaceService,
    aiChatService,
    aiChatHistoryService,
    aiProviderService,
    usageService,
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
    providerSubject: 'sub_test_c3_agent_user',
    email: 'agent_tester@example.test',
    emailVerified: true,
    displayName: 'Agent Tester',
  });

  const bootstrap = await workspaceService.getBootstrap({ userId: session.user.id });
  let agentId = bootstrap.agents[0]?.id;
  if (!agentId) {
    const created = await workspaceService.createAgent({
      userId: session.user.id,
      input: {
        name: 'Mina Scout',
        role: 'Web & commerce scout',
        avatar: 'magnifier',
        color: '#4c8dff',
        approvalPath: 'desktop',
        orderCap: 100,
        dailyCap: 200,
        apps: ['channel3'],
        memoryPills: [],
      },
    });
    agentId = created.createdAgentId || created.agents?.[0]?.id;
  }

  const usageService = {
    reserveTokens: async () => ({ allowed: true }),
    settleTokenReservation: async () => ({ settled: true }),
    releaseTokenReservation: async () => {},
  };

  const aiChatHistoryService = {
    appendExchange: async () => {},
    getRecentMessages: async () => [],
    recordPendingToolAction: async () => {},
  };

  return {
    db,
    authService,
    workspaceService,
    usageService,
    aiChatHistoryService,
    sessionToken: session.sessionToken,
    user: session.user,
    workspace: bootstrap.workspace,
    agentId,
  };
}

test('agent tool use: when model emits search_products, chat returns discovered products and evidence in UI response', async () => {
  const ctx = await setupContext();
  const config = loadServerConfig({
    AI_PROVIDER_CHAT_TEST_ENABLED: '1',
    AI_PROVIDER_ADMIN_EMAILS: 'agent_tester@example.test',
    AI_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_wos',
    WORKOS_CLIENT_ID: 'client_wos',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  });

  const mockChannel3Fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        products: [
          {
            id: 'c3_wool_blanket',
            title: 'Heritage Wool Throw Blanket',
            brand: 'Highland Weavers',
            images: ['https://highlandweavers.example.com/throw.jpg'],
            offers: [
              {
                price: 110.0,
                currency: 'USD',
                merchant: 'Highland Direct',
                merchant_domain: 'highlandweavers.example.com',
                url: 'https://highlandweavers.example.com/throw-blanket',
                availability: 'in_stock',
              },
            ],
          },
        ],
      };
    },
  });

  const channel3Client = createChannel3Client({
    apiKey: 'sk_live_c3_test_key',
    fetchImpl: mockChannel3Fetch,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  // Mock aiChatService that simulates the agent calling the search_products tool
  const aiChatService = {
    isReady: async () => true,
    stream: async ({ onDelta }) => {
      const toolMarker = '[[KEUS_WORKSPACE_TOOL:{"name":"search_products","arguments":{"query":"wool blanket"}}]]';
      await onDelta(toolMarker);
      return {
        text: toolMarker,
        provider: 'mock-provider',
        model: 'mock-model',
        inputTokens: 25,
        outputTokens: 40,
      };
    },
    complete: async () => {
      const toolMarker = '[[KEUS_WORKSPACE_TOOL:{"name":"search_products","arguments":{"query":"wool blanket"}}]]';
      return {
        text: toolMarker,
        provider: 'mock-provider',
        model: 'mock-model',
        inputTokens: 25,
        outputTokens: 40,
      };
    },
  };

  const aiProviderService = {
    getActiveChatProvider: async () => ({
      providerKey: 'mock',
      providerDisplayName: 'Mock Provider',
      modelId: 'mock-model',
    }),
    listProviders: async () => [],
  };

  await withServer(config, { ...ctx, aiChatService, aiProviderService, channel3Client }, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${ctx.sessionToken}`,
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId: ctx.agentId,
        message: 'Can you find me a nice wool blanket?',
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.reply);
    assert.match(data.reply, /Heritage Wool Throw Blanket/);
    assert.match(data.reply, /!\[Heritage Wool Throw Blanket\]\(https:\/\/highlandweavers\.example\.com\/throw\.jpg\)/);
    assert.match(data.reply, /Highland Direct/);
    assert.match(data.reply, /\$110\.00 USD/);
    assert.match(data.reply, /Channel3 \(Live Search\)/);
    assert.match(data.reply, /Run ID/);
    assert.match(data.reply, /Evidence/);
    assert.match(data.reply, /sha256:[a-f0-9]{12}/);

    // Verify evidence is actually recorded in DB
    const runIdMatch = data.reply.match(/Run ID:\* `(run_[a-f0-9]{32})`/);
    assert.ok(runIdMatch, 'Run ID should be present in response');
    const offers = await getProductOffersForRun({ db: ctx.db, workspaceId: ctx.workspace.id, runId: runIdMatch[1] });
    assert.equal(offers.length, 1);
    assert.equal(offers[0].title, 'Heritage Wool Throw Blanket');
    assert.equal(offers[0].merchantDomain, 'highlandweavers.example.com');
  });
});

test('agent tool use: sample fixtures are used and labeled when Channel3 is unconfigured', async () => {
  const ctx = await setupContext();
  const config = loadServerConfig({
    AI_PROVIDER_CHAT_TEST_ENABLED: '1',
    AI_PROVIDER_ADMIN_EMAILS: 'agent_tester@example.test',
    AI_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_wos',
    WORKOS_CLIENT_ID: 'client_wos',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  });

  const unconfiguredClient = createChannel3Client({ apiKey: '' });

  const aiChatService = {
    isReady: async () => true,
    complete: async () => {
      const toolMarker = '[[KEUS_WORKSPACE_TOOL:{"name":"search_products","arguments":{"query":"ceramic"}}]]';
      return {
        text: toolMarker,
        provider: 'mock-provider',
        model: 'mock-model',
        inputTokens: 25,
        outputTokens: 40,
      };
    },
  };

  const aiProviderService = {
    getActiveChatProvider: async () => ({
      providerKey: 'mock',
      providerDisplayName: 'Mock Provider',
      modelId: 'mock-model',
    }),
    listProviders: async () => [],
  };

  await withServer(config, { ...ctx, aiChatService, aiProviderService, channel3Client: unconfiguredClient }, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${ctx.sessionToken}`,
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId: ctx.agentId,
        message: 'Search for ceramic tabletop items',
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.reply, /Ceramic Tabletop Bundle/);
    assert.match(data.reply, /!\[Ceramic Tabletop Bundle/);
    assert.match(data.reply, /Studio Kera/);
    assert.match(data.reply, /\$78\.50 USD/);
    assert.match(data.reply, /Channel3 \(Sample Fixtures\)/);
    assert.match(data.reply, /Run ID/);
  });
});
