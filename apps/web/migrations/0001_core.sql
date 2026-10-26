-- Keus core schema, SQLite/libSQL (Turso) compatible.
-- Never store raw session tokens, magic-link tokens, OAuth codes, payment card data,
-- or WebAuthn private keys in this database.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email_normalized TEXT UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Email magic-link and Google OAuth identities; passkey credentials live separately.
CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('email_magic_link', 'google_oauth')),
  provider_subject TEXT NOT NULL,
  email_at_provider TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  UNIQUE (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);

-- Store only hashes of one-time email links / OAuth state / WebAuthn registration challenges.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_magic_link', 'google_oauth_state', 'passkey_registration', 'passkey_login')),
  identifier TEXT,
  challenge_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry ON auth_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_email_rate ON auth_challenges(purpose, identifier, created_at);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports_json)),
  rp_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user ON passkey_credentials(user_id);

-- The browser receives the raw cookie token; only its SHA-256 hash is persisted here.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (id, owner_user_id)
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

-- Catalog is intentionally unseeded until competition quota/pricing rules are confirmed.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('competition', 'month', 'year')),
  included_tokens INTEGER NOT NULL CHECK (included_tokens >= 0),
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- SaaS subscription records; deliberately separate from PayPal agent-purchase transactions.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  external_customer_id TEXT,
  external_subscription_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, external_subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_workspace_status ON subscriptions(workspace_id, status);

-- A competition/free grant can be time-bounded without a subscription-provider record.
CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('competition', 'subscription', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_workspace_window ON entitlements(workspace_id, status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT 'bulb',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_agents_workspace_status ON agents(workspace_id, status);

CREATE TABLE IF NOT EXISTS spend_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT,
  max_per_order_minor INTEGER NOT NULL CHECK (max_per_order_minor > 0),
  max_per_run_minor INTEGER NOT NULL CHECK (max_per_run_minor > 0),
  daily_budget_minor INTEGER NOT NULL CHECK (daily_budget_minor > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  allowed_domains_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_domains_json)),
  blocked_payees_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocked_payees_json)),
  blocked_conditions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocked_conditions_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_policy_workspace_default ON spend_policies(workspace_id) WHERE agent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_policy_agent ON spend_policies(workspace_id, agent_id) WHERE agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'completed', 'blocked', 'failed', 'cancelled')),
  mode TEXT NOT NULL DEFAULT 'demo' CHECK (mode IN ('demo', 'live_search', 'sandbox_purchase')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_runs_workspace_created ON runs(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at);

CREATE TABLE IF NOT EXISTS product_offers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_listing_id TEXT,
  source_url TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  merchant_domain TEXT NOT NULL,
  title TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  availability TEXT,
  evidence_hash TEXT NOT NULL,
  evidence_ref TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_product_offers_run ON product_offers(workspace_id, run_id, observed_at);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(workspace_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  spend_policy_id TEXT REFERENCES spend_policies(id) ON DELETE RESTRICT,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  decision_code TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  mandate_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_policy_decisions_run ON policy_decisions(workspace_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  policy_decision_id TEXT NOT NULL REFERENCES policy_decisions(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  payee TEXT NOT NULL,
  merchant_domain TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  challenge_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'authorized', 'awaiting_approval', 'approved', 'captured', 'voided', 'expired', 'rejected')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_mandates_workspace_status ON mandates(workspace_id, status, expires_at);

-- Transaction approval is its own ceremony, separate from account sign-in challenges.
CREATE TABLE IF NOT EXISTS mandate_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mandate_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  credential_id TEXT REFERENCES passkey_credentials(credential_id) ON DELETE SET NULL,
  challenge_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'rejected', 'expired', 'replayed')),
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, mandate_id) REFERENCES mandates(workspace_id, id) ON DELETE CASCADE
);

-- A reservation lets the service enforce a token cap before an AI call, then settle actual usage.
CREATE TABLE IF NOT EXISTS usage_periods (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entitlement_id TEXT NOT NULL REFERENCES entitlements(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  token_limit INTEGER NOT NULL CHECK (token_limit >= 0),
  consumed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (consumed_tokens >= 0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ends_at > starts_at),
  UNIQUE (workspace_id, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_usage_periods_active ON usage_periods(workspace_id, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS usage_reservations (
  id TEXT PRIMARY KEY,
  usage_period_id TEXT NOT NULL REFERENCES usage_periods(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  run_id TEXT,
  idempotency_key TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
  actual_tokens INTEGER CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  settled_at TEXT,
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_usage_reservations_open ON usage_reservations(usage_period_id, status, expires_at);

-- Append usage facts with separate input/output counts; total must equal their sum.
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_period_id TEXT NOT NULL REFERENCES usage_periods(id) ON DELETE RESTRICT,
  reservation_id TEXT UNIQUE REFERENCES usage_reservations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  run_id TEXT,
  event_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens = input_tokens + output_tokens),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_time ON usage_events(workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_run ON usage_events(workspace_id, run_id);

-- SaaS billing webhooks are deduplicated by provider event ID; store hashes, not raw payloads.
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT,
  UNIQUE (provider, external_event_id)
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  external_payment_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, external_payment_id)
);

-- Agent shopping payments are explicitly Sandbox-only and never represent SaaS subscriptions.
CREATE TABLE IF NOT EXISTS agent_payment_transactions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'paypal_sandbox' CHECK (provider = 'paypal_sandbox'),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  external_order_id TEXT UNIQUE,
  authorization_id TEXT UNIQUE,
  capture_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('created', 'authorized', 'captured', 'voided', 'refunded', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, mandate_id) REFERENCES mandates(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  mandate_id TEXT UNIQUE REFERENCES mandates(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('authorized', 'captured', 'voided', 'refunded', 'blocked')),
  receipt_hash TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_receipts_workspace_created ON receipts(workspace_id, created_at);
