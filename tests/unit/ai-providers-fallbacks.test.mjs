import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { AiProviderError, createAiProviderService } from '../../apps/web/lib/ai-providers/service.mjs';

const encryptionKey = Buffer.alloc(32, 63).toString('base64');
const apiKey = 'local_fallback_test_key_not_real';

function providerInput(providerKey, overrides = {}) {
  return {
    providerKey,
    displayName: providerKey,
    apiProtocol: 'openai_chat',
    baseUrl: 'https://api.provider.com/v1',
    modelId: `${providerKey}-model`,
    apiKey,
    enabled: true,
    isPrimary: false,
    isFallback: false,
    ...overrides,
  };
}

async function fixture() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  let tick = 0;
  const service = createAiProviderService({
    db,
    encryptionKey,
    now: () => new Date(Date.parse('2026-10-28T12:00:00.000Z') + tick++),
  });
  return { db, service };
}

test('AI provider admin can mark up to two enabled non-primary providers as encrypted failover backups', async () => {
  const { db, service } = await fixture();
  try {
    await service.createProvider({ input: providerInput('primary', { isPrimary: true }) });
    const oldestBackup = await service.createProvider({ input: providerInput('backup-z', { isFallback: true }) });
    const newestBackup = await service.createProvider({ input: providerInput('backup-a', { isFallback: true }) });
    assert.equal(oldestBackup.isFallback, true);
    assert.equal(newestBackup.isFallback, true);
    assert.equal(Object.hasOwn(oldestBackup, 'apiKey'), false);
    assert.deepEqual((await service.getFallbackProvidersForRuntime()).map((provider) => provider.providerKey), ['backup-z', 'backup-a']);
    assert.equal((await service.getFallbackProvidersForRuntime())[0].apiKey, apiKey);
    assert.equal((await service.listProviders()).filter((provider) => provider.isFallback).length, 2);

    await assert.rejects(
      service.createProvider({ input: providerInput('backup-c', { isFallback: true }) }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_fallback_limit_reached' && error.status === 409,
    );
    const regularProvider = await service.createProvider({ input: providerInput('regular-provider') });
    await assert.rejects(
      service.updateProvider({
        providerId: regularProvider.id,
        input: {
          displayName: regularProvider.displayName,
          apiProtocol: regularProvider.apiProtocol,
          baseUrl: regularProvider.baseUrl,
          modelId: regularProvider.modelId,
          enabled: true,
          isPrimary: false,
          isFallback: true,
          apiKey: '',
        },
      }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_fallback_limit_reached',
    );
    await assert.rejects(
      service.createProvider({ input: providerInput('disabled-backup', { enabled: false, isFallback: true }) }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_fallback_requires_enabled',
    );
    await assert.rejects(
      service.createProvider({ input: providerInput('primary-backup', { isPrimary: true, isFallback: true }) }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_fallback_cannot_be_primary',
    );

    const promoted = await service.updateProvider({
      providerId: oldestBackup.id,
      input: {
        displayName: oldestBackup.displayName,
        apiProtocol: oldestBackup.apiProtocol,
        baseUrl: oldestBackup.baseUrl,
        modelId: oldestBackup.modelId,
        enabled: true,
        isPrimary: true,
        isFallback: false,
        apiKey: '',
      },
    });
    assert.equal(promoted.isPrimary, true);
    assert.equal(promoted.isFallback, false);
    const markedAfterPromotion = await service.updateProvider({
      providerId: regularProvider.id,
      input: {
        displayName: regularProvider.displayName,
        apiProtocol: regularProvider.apiProtocol,
        baseUrl: regularProvider.baseUrl,
        modelId: regularProvider.modelId,
        enabled: true,
        isPrimary: false,
        isFallback: true,
        apiKey: '',
      },
    });
    assert.equal(markedAfterPromotion.isFallback, true);
    assert.equal((await service.listProviders()).filter((provider) => provider.isFallback).length, 2);
  } finally {
    await db.close();
  }
});
