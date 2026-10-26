-- Persistent, encrypted API connector registry for the Keus API Hub.
-- Provider credentials are AES-256-GCM ciphertext only; never store raw secrets.
CREATE TABLE api_hub_connectors (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header TEXT,
  auth_ciphertext TEXT NOT NULL,
  auth_nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (owner_user_id, name)
);
CREATE INDEX idx_api_hub_connectors_owner ON api_hub_connectors(owner_user_id, created_at);

-- Agent keys are shown once at creation; only a SHA-256 hash is persisted.
CREATE TABLE api_hub_access_tokens (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_api_hub_tokens_owner ON api_hub_access_tokens(owner_user_id, created_at);
CREATE INDEX idx_api_hub_tokens_hash ON api_hub_access_tokens(token_hash, revoked_at, expires_at);

-- Audit metadata only. Never record request/response bodies, provider tokens, or headers.
CREATE TABLE api_hub_audit_events (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id TEXT REFERENCES api_hub_connectors(id) ON DELETE SET NULL,
  access_token_id TEXT REFERENCES api_hub_access_tokens(id) ON DELETE SET NULL,
  operation_name TEXT NOT NULL,
  method TEXT NOT NULL,
  upstream_status INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'upstream_error', 'blocked', 'error')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_api_hub_audit_owner_created ON api_hub_audit_events(owner_user_id, created_at);
CREATE INDEX idx_api_hub_audit_token_created ON api_hub_audit_events(access_token_id, created_at);
