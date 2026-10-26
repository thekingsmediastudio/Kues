import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const schema = fs.readFileSync(new URL('../../apps/web/migrations/0001_core.sql', import.meta.url), 'utf8');
const authProviderMigration = fs.readFileSync(new URL('../../apps/web/migrations/0002_workos_identity.sql', import.meta.url), 'utf8');
const workosEmailCodeMigration = fs.readFileSync(new URL('../../apps/web/migrations/0003_workos_email_code_requests.sql', import.meta.url), 'utf8');

test('core migration covers account identities, sessions, passkeys, and workspaces', () => {
  for (const table of ['users', 'auth_identities', 'auth_challenges', 'passkey_credentials', 'sessions', 'workspaces', 'workspace_members']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
  }
  assert.match(schema, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(schema, /public_key BLOB NOT NULL/);
  assert.match(schema, /idx_auth_challenges_email_rate ON auth_challenges\(purpose, identifier, created_at\)/);
  assert.match(authProviderMigration, /'email_magic_link', 'google_oauth', 'workos'/);
  assert.match(authProviderMigration, /INSERT INTO auth_identities_workos[\s\S]*FROM auth_identities/);
  assert.match(workosEmailCodeMigration, /'workos_email_code'/);
  assert.match(workosEmailCodeMigration, /INSERT INTO auth_challenges_workos_code[\s\S]*FROM auth_challenges/);
});

test('token quota model records input/output separately and supports idempotent reservations', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS usage_periods/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS usage_reservations/);
  assert.match(schema, /UNIQUE \(workspace_id, idempotency_key\)/);
  assert.match(schema, /input_tokens INTEGER NOT NULL CHECK \(input_tokens >= 0\)/);
  assert.match(schema, /output_tokens INTEGER NOT NULL CHECK \(output_tokens >= 0\)/);
  assert.match(schema, /total_tokens INTEGER NOT NULL CHECK \(total_tokens = input_tokens \+ output_tokens\)/);
});

test('SaaS billing and Sandbox agent-purchase records are separate', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS subscriptions/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS subscription_payments/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS agent_payment_transactions/);
  assert.match(schema, /provider TEXT NOT NULL DEFAULT 'paypal_sandbox' CHECK \(provider = 'paypal_sandbox'\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS billing_webhook_events/);
});
