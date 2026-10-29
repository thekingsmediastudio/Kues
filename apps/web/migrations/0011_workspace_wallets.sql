-- Workspace wallets store vaulted payment credentials (e.g. PayPal Vault v3 payment tokens)
-- per workspace, allowing autonomous agents to execute pre-authorized purchase mandates
-- without requiring human re-login.
CREATE TABLE IF NOT EXISTS workspace_wallets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'paypal_sandbox' CHECK (provider IN ('paypal_sandbox', 'paypal_live')),
  vault_token_id TEXT NOT NULL,
  payer_email TEXT,
  payer_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workspace_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_workspace_wallets_ws ON workspace_wallets(workspace_id);
