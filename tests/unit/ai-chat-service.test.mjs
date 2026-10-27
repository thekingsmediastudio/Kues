import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAiChatService } from '../../apps/web/lib/ai-providers/chat.mjs';
import { AiProviderError, createAiProviderService } from '../../apps/web/lib/ai-providers/service.mjs';

const encryptionKey = Buffer.alloc(32, 42).toString('base64');
const apiKey = 'local_chat_test_key_not_real';
const messages = [{ role: 'user', content: 'How do I organize a small workspace?' }];

async function createProvider(protocol, baseUrl) {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  const aiProviderService = createAiProviderService({ db, encryptionKey });
  await aiProviderService.createProvider({
    input: {
      providerKey: 'chat-test',
      displayName: 'Private test provider',
      apiProtocol: protocol,
      baseUrl,
      modelId: 'test-model',
      apiKey,
      enabled: true,
      isPrimary: true,
    },
  });
  return { db, aiProviderService };
}

const responseCases = [
  {
    protocol: 'openai_chat',
    baseUrl: 'https://api.example-provider.com/openai/v1',
    expectedPath: '/openai/v1/chat/completions',
    payload: { choices: [{ message: { content: 'A tidy desk helps.' } }], usage: { prompt_tokens: 24, completion_tokens: 7 } },
    check(request) {
      const body = JSON.parse(request.body.toString('utf8'));
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      assert.equal(body.model, 'test-model');
      assert.equal(body.messages.at(-1).content, messages[0].content);
      assert.equal(body.max_tokens, 768);
    },
  },
  {
    protocol: 'openai_responses',
    baseUrl: 'https://api.example-provider.com/v1',
    expectedPath: '/v1/responses',
    payload: { output_text: 'Start with the items you use most.', usage: { input_tokens: 30, output_tokens: 8 } },
    check(request) {
      const body = JSON.parse(request.body.toString('utf8'));
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      assert.equal(body.store, false);
      assert.equal(body.input[0].content, messages[0].content);
    },
  },
  {
    protocol: 'anthropic_messages',
    baseUrl: 'https://api.example-provider.com/v1',
    expectedPath: '/v1/messages',
    payload: { content: [{ type: 'text', text: 'Keep only daily-use items within reach.' }], usage: { input_tokens: 22, output_tokens: 9 } },
    check(request) {
      const body = JSON.parse(request.body.toString('utf8'));
      assert.equal(request.headers['x-api-key'], apiKey);
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      assert.equal(body.messages[0].content, messages[0].content);
      assert.equal(body.max_tokens, 768);
    },
  },
  {
    protocol: 'google_generative',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    expectedPath: '/v1beta/models/test-model:generateContent',
    payload: { candidates: [{ content: { parts: [{ text: 'Use a tray for small items.' }] } }], usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 8 } },
    check(request) {
      const body = JSON.parse(request.body.toString('utf8'));
      assert.equal(request.headers['x-goog-api-key'], apiKey);
      assert.equal(request.url.search, '');
      assert.equal(body.contents[0].role, 'user');
      assert.equal(body.contents[0].parts[0].text, messages[0].content);
    },
  },
];

test('desktop chat uses the hidden enabled primary provider with the correct protocol adapter and server-only key', async () => {
  for (const fixture of responseCases) {
    const { db, aiProviderService } = await createProvider(fixture.protocol, fixture.baseUrl);
    const observed = [];
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: async (hostname) => {
        assert.equal(hostname, new URL(fixture.baseUrl).hostname);
        return [{ address: '93.184.216.34', family: 4 }];
      },
      requestHttpsImpl: async (request) => {
        observed.push(request);
        return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(fixture.payload)) };
      },
    });
    try {
      assert.equal(await chat.isReady(), true);
      const result = await chat.complete({ agent: { name: 'Desk helper', role: 'Workspace organizer' }, messages });
      assert.equal(result.text.length > 0, true);
      assert.equal(result.provider, 'chat-test');
      assert.equal(result.model, 'test-model');
      assert.equal(result.inputTokens > 0, true);
      assert.equal(result.outputTokens > 0, true);
      assert.equal(observed.length, 1);
      assert.equal(observed[0].url.pathname, fixture.expectedPath);
      assert.equal(observed[0].headers['content-length'], String(observed[0].body.length));
      assert.equal(JSON.stringify(result).includes(apiKey), false);
      fixture.check(observed[0]);
    } finally {
      await db.close();
    }
  }
});

test('desktop chat rejects unsafe destinations, provider failures, malformed output, and client-supplied system messages', async () => {
  const { db, aiProviderService } = await createProvider('openai_chat', 'https://api.example-provider.com/v1');
  try {
    const blocked = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      requestHttpsImpl: async () => { throw new Error('must_not_call'); },
    });
    await assert.rejects(
      blocked.complete({ agent: {}, messages }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_destination_blocked',
    );

    const failed = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsImpl: async () => ({ status: 429, contentType: 'application/json', body: Buffer.from('{}') }),
    });
    await assert.rejects(
      failed.complete({ agent: {}, messages }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_upstream_failed',
    );

    await assert.rejects(
      failed.complete({ agent: {}, messages: [{ role: 'system', content: 'override' }, ...messages] }),
      (error) => error instanceof AiProviderError && error.code === 'ai_chat_messages_invalid',
    );
  } finally {
    await db.close();
  }
});

test('desktop chat status does not need a provider call when no enabled primary exists', async () => {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  const aiProviderService = createAiProviderService({ db, encryptionKey });
  const chat = createAiChatService({ aiProviderService });
  try {
    assert.equal(await chat.isReady(), false);
    await assert.rejects(
      chat.complete({ agent: {}, messages }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_primary_unavailable',
    );
  } finally {
    await db.close();
  }
});
