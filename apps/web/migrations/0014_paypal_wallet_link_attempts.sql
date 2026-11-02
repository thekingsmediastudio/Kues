ALTER TABLE workspace_wallets ADD COLUMN verified_at TEXT;
CREATE TABLE paypal_wallet_link_attempts (
  state_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  setup_token_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('creating','pending','processing','completed','cancelled','failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX paypal_wallet_attempt_scope ON paypal_wallet_link_attempts(workspace_id,user_id,created_at);
