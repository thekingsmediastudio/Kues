import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { AiProviderError, createAiProviderService } from '../../apps/web/lib/ai-providers/service.mjs';

const encryptionKey = Buffer.alloc(32, 17).toString('base64');
const testApiKey = 'local_test_provider_key_not_real';

async function createTestService() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  const service = createAiProviderService({
    db,
    encryptionKey,
    now: () => new Date('2026-10-27T12:00:00.000Z'),
  });
  return { db, service };
}

function providerInput(overrides = {}) {
  return {
    providerKey: 'test-provider',
    displayName: 'Test Provider',
    apiProtocol: 'openai_chat',
    baseUrl: 'https://api.provider.com/v1',
    modelId: 'test-model',
    apiKey: testApiKey,
    enabled: true,
    isPrimary: true,
    ...overrides,
  };
}

test('AI provider keys are AES-GCM encrypted at rest and only decrypted by the server runtime accessor', async () => {
  const { db, service } = await createTestService();
  try {
    const provider = await service.createProvider({ input: providerInput() });
    assert.equal(provider.providerKey, 'test-provider');
    assert.equal(provider.baseUrl, 'https://api.provider.com/v1/');
    assert.equal(provider.enabled, true);
    assert.equal(provider.isPrimary, true);
    assert.equal(Object.hasOwn(provider, 'apiKey'), false);
    assert.equal(JSON.stringify(provider).includes(testApiKey), false);

    const storedResult = await db.execute({
      sql: `SELECT api_key_ciphertext, api_key_nonce, api_key_tag, key_version
            FROM ai_providers WHERE provider_key = ?`,
      args: ['test-provider'],
    });
    const stored = storedResult.rows[0];
    assert.ok(stored);
    assert.notEqual(stored.api_key_ciphertext, testApiKey);
    assert.equal(Buffer.from(stored.api_key_nonce, 'base64').length, 12);
    assert.equal(Buffer.from(stored.api_key_tag, 'base64').length, 16);
    assert.equal(Number(stored.key_version), 1);

    const runtimeProvider = await service.getProviderForRuntime({ providerKey: 'test-provider' });
    assert.equal(runtimeProvider.apiKey, testApiKey);
    assert.equal(runtimeProvider.providerKey, provider.providerKey);
    assert.equal(await service.hasPrimaryProvider(), true);
    const primaryProvider = await service.getPrimaryProviderForRuntime();
    assert.equal(primaryProvider.apiKey, testApiKey);
    assert.equal(primaryProvider.modelId, 'test-model');
    assert.equal(primaryProvider.isPrimary, true);

    await db.execute({
      sql: 'UPDATE ai_providers SET api_key_tag = ? WHERE provider_key = ?',
      args: [Buffer.alloc(16, 99).toString('base64'), 'test-provider'],
    });
    await assert.rejects(
      service.getProviderForRuntime({ providerKey: 'test-provider' }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_secret_unavailable' && error.status === 503,
    );
  } finally {
    await db.close();
  }
});

test('AI provider service validates configuration and rejects duplicate or unsafe records', async () => {
  const { db, service } = await createTestService();
  try {
    await service.createProvider({ input: providerInput() });
    await assert.rejects(
      service.createProvider({ input: providerInput({ isPrimary: false }) }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_already_exists' && error.status === 409,
    );
    await assert.rejects(
      service.createProvider({ input: providerInput({ providerKey: 'second-provider' }) }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_primary_exists' && error.status === 409,
    );
    await assert.rejects(
      service.createProvider({ input: providerInput({ providerKey: 'bad-provider', enabled: false, isPrimary: true }) }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_primary_requires_enabled',
    );
    await assert.rejects(
      service.createProvider({ input: providerInput({ providerKey: 'unsafe-url', baseUrl: 'http://127.0.0.1:9000/v1', isPrimary: false }) }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_base_url_invalid',
    );
    await assert.rejects(
      service.createProvider({ input: { ...providerInput({ isPrimary: false }), settings: { apiKey: 'plaintext' } } }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_input_invalid',
    );
  } finally {
    await db.close();
  }
});

test('AI provider service rejects missing or malformed encryption keys', async () => {
  const db = createClient({ url: ':memory:' });
  try {
    assert.throws(() => createAiProviderService({ db }), /ai_provider_encryption_key_invalid/);
    assert.throws(() => createAiProviderService({ db, encryptionKey: 'not-a-key' }), /ai_provider_encryption_key_invalid/);
  } finally {
    await db.close();
  }
});
