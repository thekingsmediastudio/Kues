import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAiChatService } from '../../apps/web/lib/ai-providers/chat.mjs';
import { createAiProviderService } from '../../apps/web/lib/ai-providers/service.mjs';

const encryptionKey = Buffer.alloc(32, 63).toString('base64');
const apiKey = 'local_model_catalog_key_not_real';
const publicAddresses = [{ address: '93.184.216.34', family: 4 }];

async function createCatalogFixture({ protocol, baseUrl, modelId = `configured-${protocol}`, requestHttpsImpl }) {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  const aiProviderService = createAiProviderService({ db, encryptionKey });
  await aiProviderService.createProvider({
    input: {
      providerKey: 'catalog-test',
      displayName: 'Catalog test provider',
      apiProtocol: protocol,
      baseUrl,
      modelId,
      apiKey,
      enabled: true,
      isPrimary: true,
    },
  });
  const hostnames = [];
  const chat = createAiChatService({
    aiProviderService,
    resolveHost: async (hostname) => {
      hostnames.push(hostname);
      return publicAddresses;
    },
    requestHttpsImpl,
  });
  return { db, aiProviderService, chat, hostnames };
}

function jsonResponse(payload) {
  return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(payload)) };
}

test('model catalogs use protocol-specific server credentials and pinned HTTPS requests', async () => {
  const fixtures = [
    {
      protocol: 'openai_chat',
      baseUrl: 'https://api.catalog-example.com/openai/v1',
      expectedPath: '/openai/v1/models',
      payload: { data: [{ id: 'chat-model-v2' }] },
      assertAuth(request) { assert.equal(request.headers.authorization, `Bearer ${apiKey}`); },
      expectedHost: 'api.catalog-example.com',
    },
    {
      protocol: 'openai_responses',
      baseUrl: 'https://responses.catalog-example.com/v1',
      expectedPath: '/v1/models',
      payload: { data: [{ id: 'responses-model-v2' }] },
      assertAuth(request) { assert.equal(request.headers.authorization, `Bearer ${apiKey}`); },
      expectedHost: 'responses.catalog-example.com',
    },
    {
      protocol: 'anthropic_messages',
      baseUrl: 'https://anthropic-catalog.example.com/v1',
      expectedPath: '/v1/models',
      payload: { data: [{ id: 'claude-model-v2', display_name: 'Claude model v2' }], has_more: false },
      assertAuth(request) {
        assert.equal(request.headers['x-api-key'], apiKey);
        assert.equal(request.headers['anthropic-version'], '2023-06-01');
        assert.equal(request.url.searchParams.get('limit'), '100');
      },
      expectedHost: 'anthropic-catalog.example.com',
    },
    {
      protocol: 'google_generative',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      expectedPath: '/v1beta/models',
      payload: { models: [{ name: 'models/gemini-model-v2', displayName: 'Gemini model v2', supportedGenerationMethods: ['generateContent'] }] },
      assertAuth(request) {
        assert.equal(request.headers['x-goog-api-key'], apiKey);
        assert.equal(request.url.searchParams.get('pageSize'), '100');
      },
      expectedHost: 'generativelanguage.googleapis.com',
    },
  ];

  for (const fixture of fixtures) {
    const requests = [];
    const created = await createCatalogFixture({
      ...fixture,
      requestHttpsImpl: async (request) => {
        requests.push(request);
        return jsonResponse(fixture.payload);
      },
    });
    try {
      const result = await created.chat.listModels();
      assert.equal(result.catalogAvailable, true, fixture.protocol);
      assert.equal(result.configuredModelId, `configured-${fixture.protocol}`);
      assert.equal(result.models[0].id, result.configuredModelId, 'the configured model stays available first');
      assert.equal(result.models[1].id, fixture.protocol === 'google_generative' ? 'gemini-model-v2' : fixture.payload.data?.[0]?.id || fixture.payload.models?.[0]?.name.replace(/^models\//, ''));
      assert.equal(result.models[1].displayName, fixture.protocol === 'anthropic_messages'
        ? 'Claude model v2'
        : fixture.protocol === 'google_generative' ? 'Gemini model v2' : result.models[1].id);
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.equal(request.method, 'GET');
      assert.equal(request.url.protocol, 'https:');
      assert.equal(request.url.hostname, fixture.expectedHost);
      assert.equal(request.url.pathname, fixture.expectedPath);
      assert.equal(request.maxResponseBytes, 1024 * 1024);
      assert.equal(request.addresses, publicAddresses);
      assert.equal(request.body, undefined);
      assert.equal(request.headers.accept, 'application/json');
      fixture.assertAuth(request);
      assert.deepEqual(created.hostnames, [fixture.expectedHost]);
      assert.equal(JSON.stringify(result).includes(apiKey), false);
      assert.equal(JSON.stringify(result).includes('apiKey'), false);
      const cached = await created.chat.listModels();
      assert.equal(requests.length, 1, 'successful catalog responses are cached server-side');
      assert.deepEqual(cached, result);
      assert.notEqual(cached.models[0], result.models[0], 'callers receive detached catalog objects');
      const configured = await created.aiProviderService.listProviders();
      assert.equal(configured[0].modelId, `configured-${fixture.protocol}`, 'catalog reads do not mutate configured defaults');
    } finally {
      await created.db.close();
    }
  }
});

test('Anthropic and Google model catalogs follow their supported pagination tokens and filter unusable Google models', async () => {
  const anthropicRequests = [];
  const anthropic = await createCatalogFixture({
    protocol: 'anthropic_messages',
    baseUrl: 'https://anthropic-catalog.example.com/v1',
    modelId: 'claude-configured',
    requestHttpsImpl: async (request) => {
      anthropicRequests.push(request);
      if (anthropicRequests.length === 1) {
        return jsonResponse({
          data: [{ id: 'claude-first', display_name: 'Claude first' }],
          has_more: true,
          last_id: 'cursor&after=one',
        });
      }
      return jsonResponse({ data: [{ id: 'claude-second', display_name: 'Claude second' }], has_more: false });
    },
  });
  try {
    const result = await anthropic.chat.listModels();
    assert.equal(result.catalogAvailable, true);
    assert.deepEqual(result.models.map((model) => model.id), ['claude-configured', 'claude-first', 'claude-second']);
    assert.equal(anthropicRequests.length, 2);
    assert.equal(anthropicRequests[0].url.searchParams.has('after_id'), false);
    assert.equal(anthropicRequests[1].url.searchParams.get('after_id'), 'cursor&after=one');
    assert.equal(anthropicRequests[1].headers['x-api-key'], apiKey);
  } finally {
    await anthropic.db.close();
  }

  const googleRequests = [];
  const google = await createCatalogFixture({
    protocol: 'google_generative',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelId: 'gemini-configured',
    requestHttpsImpl: async (request) => {
      googleRequests.push(request);
      if (googleRequests.length === 1) {
        return jsonResponse({
          models: [
            { name: 'models/gemini-first', displayName: 'Gemini first', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embed-only', displayName: 'Embedding only', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'page token&two',
        });
      }
      return jsonResponse({
        models: [{ name: 'models/gemini-second', displayName: 'Gemini second', supportedGenerationMethods: ['generateContent'] }],
      });
    },
  });
  try {
    const result = await google.chat.listModels();
    assert.equal(result.catalogAvailable, true);
    assert.deepEqual(result.models.map((model) => model.id), ['gemini-configured', 'gemini-first', 'gemini-second']);
    assert.equal(googleRequests.length, 2);
    assert.equal(googleRequests[0].url.searchParams.get('pageSize'), '100');
    assert.equal(googleRequests[1].url.searchParams.get('pageToken'), 'page token&two');
    assert.equal(googleRequests.every((request) => request.headers['x-goog-api-key'] === apiKey), true);
  } finally {
    await google.db.close();
  }
});

test('catalog parsing drops provider responses that echo a server credential', async () => {
  const created = await createCatalogFixture({
    protocol: 'openai_chat',
    baseUrl: 'https://catalog-echo.example.com/v1',
    modelId: 'configured-safe-model',
    requestHttpsImpl: async () => jsonResponse({
      data: [
        { id: apiKey, display_name: 'credential echo' },
        { id: 'safe-model', display_name: `reflected ${apiKey}` },
      ],
    }),
  });
  try {
    const result = await created.chat.listModels();
    assert.equal(result.catalogAvailable, true);
    assert.deepEqual(result.models, [
      { id: 'configured-safe-model', displayName: 'configured-safe-model', isConfigured: true },
      { id: 'safe-model', displayName: 'safe-model', isConfigured: false },
    ]);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  } finally {
    await created.db.close();
  }
});

test('catalog failures degrade to the configured model and never expose provider credentials or upstream errors', async () => {
  const requests = [];
  const created = await createCatalogFixture({
    protocol: 'openai_chat',
    baseUrl: 'https://catalog-failure.example.com/v1',
    modelId: 'known-safe-model',
    requestHttpsImpl: async (request) => {
      requests.push(request);
      throw new Error(`upstream failure included ${apiKey}`);
    },
  });
  try {
    const result = await created.chat.listModels();
    assert.deepEqual(result, {
      configuredModelId: 'known-safe-model',
      catalogAvailable: false,
      models: [{ id: 'known-safe-model', displayName: 'known-safe-model', isConfigured: true }],
    });
    assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
    assert.equal(JSON.stringify(result).includes('upstream failure'), false);
  } finally {
    await created.db.close();
  }
});
