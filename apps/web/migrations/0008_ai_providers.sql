-- Keus-owned, application-level inference providers. This registry is global to
-- the app (not workspace/user scoped) and is populated only by trusted server code.
-- Never store a plaintext provider API key. The application must AES-256-GCM
-- encrypt keys before writing them; the master encryption key stays in a
-- server-only secret and is never stored in this database.
CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  api_protocol TEXT NOT NULL CHECK (
    api_protocol IN ('openai_chat', 'openai_responses', 'anthropic_messages', 'google_generative')
  ),
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  api_key_ciphertext TEXT,
  api_key_nonce TEXT,
  api_key_tag TEXT,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (api_key_ciphertext IS NULL AND api_key_nonce IS NULL AND api_key_tag IS NULL)
    OR (api_key_ciphertext IS NOT NULL AND api_key_nonce IS NOT NULL AND api_key_tag IS NOT NULL)
  ),
  CHECK (is_primary = 0 OR enabled = 1)
);

-- At most one enabled provider can be the app-wide chat primary.
CREATE UNIQUE INDEX idx_ai_providers_single_primary
  ON ai_providers(is_primary)
  WHERE is_primary = 1;
CREATE INDEX idx_ai_providers_enabled
  ON ai_providers(enabled, provider_key);
