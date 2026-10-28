import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';

test('app AI-provider registry is global, has ciphertext-only key fields, and enforces a single primary', async () => {
  const db = createClient({ url: ':memory:' });
  try {
    await applyMigrations(db);

    const columnsResult = await db.execute('PRAGMA table_info(ai_providers)');
    const columns = new Set(columnsResult.rows.map((row) => String(row.name)));
    for (const column of [
      'provider_key',
      'display_name',
      'api_protocol',
      'base_url',
      'model_id',
      'api_key_ciphertext',
      'api_key_nonce',
      'api_key_tag',
      'enabled',
      'is_primary',
      'is_fallback',
    ]) {
      assert.ok(columns.has(column), `missing ${column}`);
    }
    assert.equal(columns.has('workspace_id'), false, 'provider configuration must be app-wide');
    assert.equal(columns.has('api_key'), false, 'plaintext API keys must not have a database column');

    await db.execute({
      sql: `INSERT INTO ai_providers
        (id, provider_key, display_name, api_protocol, base_url, model_id)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['provider-test-1', 'provider-test', 'Test Provider', 'openai_chat', 'https://provider.example/v1', 'test-model'],
    });
    const defaultFallback = await db.execute({ sql: 'SELECT is_fallback FROM ai_providers WHERE id = ?', args: ['provider-test-1'] });
    assert.equal(Number(defaultFallback.rows[0].is_fallback), 0);
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO ai_providers
          (id, provider_key, display_name, api_protocol, base_url, model_id, is_fallback)
          VALUES (?, ?, ?, ?, ?, ?, 2)`,
        args: ['provider-test-invalid-fallback', 'invalid-fallback', 'Invalid Fallback', 'openai_chat', 'https://provider.example/v1', 'test-model'],
      }),
      /CHECK constraint failed/i,
    );

    await assert.rejects(
      db.execute({
        sql: `INSERT INTO ai_providers
          (id, provider_key, display_name, api_protocol, base_url, model_id, api_key_ciphertext)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: ['provider-test-2', 'partial-key', 'Partial Key', 'openai_chat', 'https://provider.example/v1', 'test-model', 'ciphertext-only'],
      }),
      /CHECK constraint failed/i,
    );

    await db.execute({
      sql: `INSERT INTO ai_providers
        (id, provider_key, display_name, api_protocol, base_url, model_id,
         api_key_ciphertext, api_key_nonce, api_key_tag, enabled, is_primary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      args: ['provider-test-2', 'primary-test', 'Primary Test', 'openai_chat', 'https://provider.example/v1', 'test-model', 'ciphertext', 'nonce', 'tag'],
    });

    await assert.rejects(
      db.execute({
        sql: `INSERT INTO ai_providers
          (id, provider_key, display_name, api_protocol, base_url, model_id, enabled, is_primary)
          VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
        args: ['provider-test-3', 'second-primary', 'Second Primary', 'openai_chat', 'https://provider.example/v1', 'test-model'],
      }),
      /UNIQUE constraint failed/i,
    );

    await assert.rejects(
      db.execute({
        sql: `INSERT INTO ai_providers
          (id, provider_key, display_name, api_protocol, base_url, model_id, is_primary)
          VALUES (?, ?, ?, ?, ?, ?, 1)`,
        args: ['provider-test-4', 'disabled-primary', 'Disabled Primary', 'openai_chat', 'https://provider.example/v1', 'test-model'],
      }),
      /CHECK constraint failed/i,
    );
  } finally {
    await db.close();
  }
});
