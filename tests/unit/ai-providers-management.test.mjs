import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { AiProviderError, createAiProviderService } from '../../apps/web/lib/ai-providers/service.mjs';

const encryptionKey = Buffer.alloc(32, 31).toString('base64');
const originalApiKey = 'local_management_test_key_not_real';
const replacementApiKey = 'local_rotated_test_key_not_real';

function input(overrides = {}) {
  return {
    providerKey: 'primary-provider',
    displayName: 'Primary Provider',
    apiProtocol: 'openai_chat',
    baseUrl: 'https://api.provider.com/v1',
    modelId: 'model-one',
    apiKey: originalApiKey,
    enabled: true,
    isPrimary: true,
    ...overrides,
  };
}

async function updateInput(provider, overrides = {}) {
  return {
    displayName: provider.displayName,
    apiProtocol: provider.apiProtocol,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    apiKey: '',
    enabled: provider.enabled,
    isPrimary: provider.isPrimary,
    ...overrides,
  };
}

test('providers can be listed safely, edited, rotated, promoted, disabled, and deleted', async () => {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  const service = createAiProviderService({ db, encryptionKey });
  try {
    const primary = await service.createProvider({ input: input() });
    const firstStoredResult = await db.execute({
      sql: 'SELECT api_key_ciphertext, api_key_nonce FROM ai_providers WHERE id = ?',
      args: [primary.id],
    });
    const originalStored = firstStoredResult.rows[0];

    const editedPrimary = await service.updateProvider({
      providerId: primary.id,
      input: await updateInput(primary, { displayName: 'Renamed Provider' }),
    });
    assert.equal(editedPrimary.displayName, 'Renamed Provider');
    const retainedStoredResult = await db.execute({
      sql: 'SELECT api_key_ciphertext, api_key_nonce FROM ai_providers WHERE id = ?',
      args: [primary.id],
    });
    assert.equal(retainedStoredResult.rows[0].api_key_ciphertext, originalStored.api_key_ciphertext);
    assert.equal(retainedStoredResult.rows[0].api_key_nonce, originalStored.api_key_nonce);
    assert.equal((await service.getProviderForRuntime({ providerKey: primary.providerKey })).apiKey, originalApiKey);

    const backup = await service.createProvider({
      input: input({
        providerKey: 'backup-provider',
        displayName: 'Backup Provider',
        modelId: 'model-two',
        isPrimary: false,
      }),
    });
    const promoted = await service.updateProvider({
      providerId: backup.id,
      input: await updateInput(backup, { isPrimary: true }),
    });
    assert.equal(promoted.isPrimary, true);
    const listed = await service.listProviders();
    assert.equal(listed.find((item) => item.id === primary.id).isPrimary, false);
    assert.equal(listed.find((item) => item.id === backup.id).isPrimary, true);
    assert.equal(JSON.stringify(listed).includes(originalApiKey), false);
    assert.equal(listed.some((item) => Object.hasOwn(item, 'apiKey')), false);

    const rotated = await service.updateProvider({
      providerId: backup.id,
      input: await updateInput(promoted, { apiKey: replacementApiKey }),
    });
    assert.equal(rotated.isPrimary, true);
    const rotatedStoredResult = await db.execute({
      sql: 'SELECT api_key_ciphertext FROM ai_providers WHERE id = ?',
      args: [backup.id],
    });
    assert.notEqual(rotatedStoredResult.rows[0].api_key_ciphertext, replacementApiKey);
    assert.equal((await service.getProviderForRuntime({ providerKey: backup.providerKey })).apiKey, replacementApiKey);

    const disabled = await service.updateProvider({
      providerId: backup.id,
      input: await updateInput(rotated, { enabled: false, isPrimary: false }),
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.isPrimary, false);
    await assert.rejects(
      service.getProviderForRuntime({ providerKey: backup.providerKey }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_not_found',
    );

    assert.deepEqual(await service.deleteProvider({ providerId: backup.id }), { deleted: true });
    assert.equal((await service.listProviders()).length, 1);
    await assert.rejects(
      service.deleteProvider({ providerId: backup.id }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_not_found',
    );
  } finally {
    await db.close();
  }
});
