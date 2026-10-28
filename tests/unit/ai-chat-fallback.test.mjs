import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAiChatService } from '../../apps/web/lib/ai-providers/chat.mjs';
import { AiProviderError, createAiProviderService } from '../../apps/web/lib/ai-providers/service.mjs';

const encryptionKey = Buffer.alloc(32, 81).toString('base64');
const messages = [{ role: 'user', content: 'A non-sensitive staging test prompt.' }];

async function createFallbackFixture() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  const aiProviderService = createAiProviderService({ db, encryptionKey });
  await aiProviderService.createProvider({
    input: {
      providerKey: 'primary-provider', displayName: 'Primary', apiProtocol: 'openai_chat',
      baseUrl: 'https://primary.provider.com/v1', modelId: 'primary-model', apiKey: 'local_primary_key_not_real',
      enabled: true, isPrimary: true,
    },
  });
  await aiProviderService.createProvider({
    input: {
      providerKey: 'approved-backup', displayName: 'Approved backup', apiProtocol: 'openai_chat',
      baseUrl: 'https://backup.provider.com/v1', modelId: 'backup-model', apiKey: 'local_backup_key_not_real',
      enabled: true, isPrimary: false, isFallback: true,
    },
  });
  await aiProviderService.createProvider({
    input: {
      providerKey: 'approved-backup-2', displayName: 'Second approved backup', apiProtocol: 'openai_chat',
      baseUrl: 'https://backup2.provider.com/v1', modelId: 'backup-model-2', apiKey: 'local_backup_key_2_not_real',
      enabled: true, isPrimary: false, isFallback: true,
    },
  });
  return { db, aiProviderService };
}

function publicLookup(hostname) {
  assert.match(hostname, /^(primary|backup2?)\.provider\.com$/);
  return [{ address: '93.184.216.34', family: 4 }];
}

test('chat retries a primary network failure through an explicitly marked backup and returns only the final completion internally', async () => {
  const { db, aiProviderService } = await createFallbackFixture();
  const requests = [];
  try {
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: publicLookup,
      requestHttpsImpl: async (request) => {
        requests.push(request);
        if (request.url.hostname === 'primary.provider.com') {
          throw new Error('connector_timeout');
        }
        return {
          status: 200,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'Backup reply.' } }], usage: { prompt_tokens: 8, completion_tokens: 4 } })),
        };
      },
    });
    const result = await chat.complete({ agent: { name: 'Test helper', role: 'Helpful' }, messages });
    assert.equal(result.text, 'Backup reply.');
    assert.equal(result.provider, 'approved-backup');
    assert.equal(result.model, 'backup-model');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackAttempts, 1);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.url.hostname), ['primary.provider.com', 'backup.provider.com']);
    const primaryBody = JSON.parse(requests[0].body.toString('utf8'));
    const backupBody = JSON.parse(requests[1].body.toString('utf8'));
    assert.equal(primaryBody.messages.at(-1).content, messages[0].content);
    assert.deepEqual(backupBody.messages, primaryBody.messages);
    assert.equal(JSON.stringify(result).includes('local_backup_key_not_real'), false);
  } finally {
    await db.close();
  }
});

test('chat tries approved backups in oldest-configured order and stops after the second backup succeeds', async () => {
  const { db, aiProviderService } = await createFallbackFixture();
  const observed = [];
  try {
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: publicLookup,
      requestHttpsImpl: async (request) => {
        observed.push(request.url.hostname);
        if (request.url.hostname !== 'backup2.provider.com') {
          return { status: 503, contentType: 'application/json', body: Buffer.from('{}') };
        }
        return {
          status: 200,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'Second backup reply.' } }] })),
        };
      },
    });
    const result = await chat.complete({ agent: {}, messages });
    assert.equal(result.text, 'Second backup reply.');
    assert.equal(result.provider, 'approved-backup-2');
    assert.equal(result.fallbackAttempts, 2);
    assert.deepEqual(observed, ['primary.provider.com', 'backup.provider.com', 'backup2.provider.com']);

    const stopAfterAuthFailure = [];
    const authFailureChat = createAiChatService({
      aiProviderService,
      resolveHost: publicLookup,
      requestHttpsImpl: async (request) => {
        stopAfterAuthFailure.push(request.url.hostname);
        return { status: request.url.hostname === 'primary.provider.com' ? 503 : 401, contentType: 'application/json', body: Buffer.from('{}') };
      },
    });
    await assert.rejects(
      authFailureChat.complete({ agent: {}, messages }),
      (error) => error instanceof AiProviderError && error.upstreamStatus === 401 && error.fallbackAttempts === 1,
    );
    assert.deepEqual(stopAfterAuthFailure, ['primary.provider.com', 'backup.provider.com']);
  } finally {
    await db.close();
  }
});

test('chat retries primary HTTP 429/5xx failures but never fails over on authentication or request errors', async () => {
  const { db, aiProviderService } = await createFallbackFixture();
  try {
    for (const retryableStatus of [429, 503]) {
      const observed = [];
      const chat = createAiChatService({
        aiProviderService,
        resolveHost: publicLookup,
        requestHttpsImpl: async (request) => {
          observed.push(request.url.hostname);
          if (request.url.hostname === 'primary.provider.com') {
            return { status: retryableStatus, contentType: 'application/json', body: Buffer.from('{}') };
          }
          return {
            status: 200,
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'Fallback worked.' } }] })),
          };
        },
      });
      const result = await chat.complete({ agent: {}, messages });
      assert.equal(result.fallbackUsed, true);
      assert.deepEqual(observed, ['primary.provider.com', 'backup.provider.com']);
    }

    const observed = [];
    const nonRetryable = createAiChatService({
      aiProviderService,
      resolveHost: publicLookup,
      requestHttpsImpl: async (request) => {
        observed.push(request.url.hostname);
        return { status: 401, contentType: 'application/json', body: Buffer.from('{}') };
      },
    });
    await assert.rejects(
      nonRetryable.complete({ agent: {}, messages }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_upstream_failed'
        && error.upstreamStatus === 401 && error.fallbackAttempts === undefined,
    );
    assert.deepEqual(observed, ['primary.provider.com']);

    for (const failure of [
      Object.assign(new Error('unexpected_adapter_failure'), { code: 'ERR_ADAPTER_FAILURE' }),
      Object.assign(new Error('certificate_validation_failed'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
      new Error('connector_response_too_large'),
    ]) {
      const attemptedHosts = [];
      const noFailover = createAiChatService({
        aiProviderService,
        resolveHost: publicLookup,
        requestHttpsImpl: async (request) => {
          attemptedHosts.push(request.url.hostname);
          throw failure;
        },
      });
      await assert.rejects(noFailover.complete({ agent: {}, messages }));
      assert.deepEqual(attemptedHosts, ['primary.provider.com']);
    }
  } finally {
    await db.close();
  }
});


test('chat streaming fails over to an approved backup only before the first final-answer chunk', async () => {
  const { db, aiProviderService } = await createFallbackFixture();
  try {
    const { Readable } = await import('node:stream');
    const observed = [];
    const deltas = [];
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: publicLookup,
      requestHttpsStreamImpl: async (request) => {
        observed.push(request.url.hostname);
        const body = JSON.parse(request.body.toString('utf8'));
        assert.equal(body.stream, true);
        assert.equal(request.headers.accept, 'text/event-stream');
        if (request.url.hostname === 'primary.provider.com') {
          return { status: 503, contentType: 'text/event-stream', body: Readable.from([]) };
        }
        const events = [
          'data: {"choices":[{"delta":{"content":"Backup ","reasoning_content":"hidden reasoning"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"content":"answer."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        ];
        return { status: 200, contentType: 'text/event-stream', body: Readable.from(events) };
      },
    });
    const result = await chat.stream({
      agent: { name: 'Test helper', role: 'Helpful' },
      messages,
      onDelta: async (text) => deltas.push(text),
    });
    assert.equal(result.text, 'Backup answer.');
    assert.equal(result.provider, 'approved-backup');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackAttempts, 1);
    assert.deepEqual(observed, ['primary.provider.com', 'backup.provider.com']);
    assert.deepEqual(deltas, ['Backup ', 'answer.']);
    assert.doesNotMatch(deltas.join(''), /hidden reasoning/);
  } finally {
    await db.close();
  }
});

test('chat does not fail over after any final-answer text has been emitted; interrupted text is returned only for safe settlement', async () => {
  const { db, aiProviderService } = await createFallbackFixture();
  try {
    const { Readable } = await import('node:stream');
    const observed = [];
    const deltas = [];
    const brokenBody = Readable.from((async function* () {
      yield 'data: {"choices":[{"delta":{"content":"Primary partial."},"finish_reason":null}]}\n\n';
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    }()));
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: publicLookup,
      requestHttpsStreamImpl: async (request) => {
        observed.push(request.url.hostname);
        return { status: 200, contentType: 'text/event-stream', body: brokenBody };
      },
    });
    await assert.rejects(
      chat.stream({ agent: {}, messages, onDelta: async (text) => deltas.push(text) }),
      (error) => error instanceof AiProviderError
        && error.code === 'ai_provider_stream_interrupted'
        && error.partialCompletion?.text === 'Primary partial.'
        && error.partialCompletion?.provider === 'primary-provider'
        && error.fallbackAttempts === 0,
    );
    assert.deepEqual(observed, ['primary.provider.com']);
    assert.deepEqual(deltas, ['Primary partial.']);
  } finally {
    await db.close();
  }
});

test('chat streaming ignores reasoning-only events and emits only final answer text', async () => {
  const { Readable } = await import('node:stream');
  const provider = {
    providerKey: 'test-provider', apiProtocol: 'openai_responses', apiKey: 'local_key_not_real',
    baseUrl: 'https://primary.provider.com/v1', modelId: 'test-model',
  };
  const chat = createAiChatService({
    aiProviderService: {
      async getPrimaryProviderForRuntime() { return provider; },
      async getFallbackProvidersForRuntime() { return []; },
    },
    resolveHost: publicLookup,
    requestHttpsStreamImpl: async (request) => {
      assert.equal(new URL(request.url).pathname, '/v1/responses');
      const payload = JSON.parse(request.body.toString('utf8'));
      assert.equal(payload.stream, true);
      const events = [
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"secret chain of thought"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Visible answer."}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
      ];
      return { status: 200, contentType: 'text/event-stream', body: Readable.from(events) };
    },
  });
  const deltas = [];
  const result = await chat.stream({ agent: {}, messages, onDelta: async (text) => deltas.push(text) });
  assert.equal(result.text, 'Visible answer.');
  assert.deepEqual(deltas, ['Visible answer.']);
  assert.equal(result.inputTokens, 5);
  assert.equal(result.outputTokens, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret chain of thought/);
});


test('Anthropic and Google streams emit visible text blocks but suppress thinking parts', async () => {
  const { Readable } = await import('node:stream');
  const cases = [
    {
      provider: {
        providerKey: 'anthropic-provider', apiProtocol: 'anthropic_messages', apiKey: 'local_key_not_real',
        baseUrl: 'https://primary.provider.com/v1', modelId: 'claude-test',
      },
      events: [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private thought"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Visible "}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
      expect: (request) => {
        assert.equal(new URL(request.url).pathname, '/v1/messages');
        assert.equal(JSON.parse(request.body.toString('utf8')).stream, true);
      },
      visible: 'Visible ',
    },
    {
      provider: {
        providerKey: 'google-provider', apiProtocol: 'google_generative', apiKey: 'local_key_not_real',
        baseUrl: 'https://primary.provider.com/v1beta', modelId: 'gemini-test',
      },
      events: [
        'data: {"candidates":[{"content":{"parts":[{"text":"private thought","thought":true},{"text":"Visible ","thought":false},{"text":"also hidden","type":"thinking"}]}}],"usageMetadata":{"promptTokenCount":4}}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"answer."}]},"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":2}}\n\n',
      ],
      expect: (request) => {
        const url = new URL(request.url);
        assert.equal(url.pathname, '/v1beta/models/gemini-test:streamGenerateContent');
        assert.equal(url.searchParams.get('alt'), 'sse');
      },
      visible: 'Visible answer.',
    },
  ];
  for (const scenario of cases) {
    const chat = createAiChatService({
      aiProviderService: {
        async getPrimaryProviderForRuntime() { return scenario.provider; },
        async getFallbackProvidersForRuntime() { return []; },
      },
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsStreamImpl: async (request) => {
        scenario.expect(request);
        return { status: 200, contentType: 'text/event-stream', body: Readable.from(scenario.events) };
      },
    });
    const deltas = [];
    const result = await chat.stream({ agent: {}, messages, onDelta: async (text) => deltas.push(text) });
    assert.equal(result.text, scenario.visible);
    assert.equal(deltas.join(''), scenario.visible);
    assert.doesNotMatch(JSON.stringify(result), /private thought|also hidden/);
  }
});
