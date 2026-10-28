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
