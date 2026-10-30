-- Multi-Tier Autonomous Checkout Rails: Agent-driven execution across PayPal Native, Channel3 UCP, and PayPal-Backed Virtual Card Bridge.

CREATE TABLE IF NOT EXISTS agent_checkout_executions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL UNIQUE REFERENCES mandates(id) ON DELETE CASCADE,
  selected_rail TEXT NOT NULL CHECK (selected_rail IN ('paypal_native', 'channel3_ucp', 'card_bridge')),
  agent_reasoning TEXT NOT NULL,
  paypal_authorization_id TEXT NOT NULL,
  merchant_domain TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  rail_execution_id TEXT,
  rail_details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rail_details_json)),
  status TEXT NOT NULL CHECK (status IN ('authorized', 'executed', 'settled', 'voided', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_checkout_executions_ws ON agent_checkout_executions(workspace_id, created_at);
