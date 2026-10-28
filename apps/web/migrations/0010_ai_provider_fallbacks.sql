-- Only providers explicitly marked by an admin are eligible for staging chat failover.
ALTER TABLE ai_providers
  ADD COLUMN is_fallback INTEGER NOT NULL DEFAULT 0 CHECK (is_fallback IN (0, 1));

CREATE INDEX idx_ai_providers_fallback_enabled
  ON ai_providers(enabled, is_fallback, created_at, provider_key);
