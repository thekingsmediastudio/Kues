-- Metered competition allowance is per account, not per workspace. Keep the quota
-- ledger in the shared database and link each reservation/event to the account bucket.
CREATE TABLE IF NOT EXISTS account_usage_periods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  token_limit INTEGER NOT NULL CHECK (token_limit >= 0),
  consumed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (consumed_tokens >= 0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ends_at > starts_at),
  UNIQUE (user_id, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_account_usage_periods_window
  ON account_usage_periods(user_id, starts_at, ends_at);

ALTER TABLE usage_periods ADD COLUMN quota_scope TEXT NOT NULL DEFAULT 'workspace'
  CHECK (quota_scope IN ('workspace', 'account'));
ALTER TABLE usage_reservations ADD COLUMN account_usage_period_id TEXT
  REFERENCES account_usage_periods(id) ON DELETE RESTRICT;
ALTER TABLE usage_events ADD COLUMN account_usage_period_id TEXT
  REFERENCES account_usage_periods(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_usage_reservations_account_open
  ON usage_reservations(account_usage_period_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_account_time
  ON usage_events(account_usage_period_id, occurred_at);

-- Backfill any previously recorded competition usage before switching the quota
-- boundary. Settled usage comes from immutable events; only currently open
-- reservations continue to reserve capacity. Aggregate across all workspaces owned
-- or used by the same account for each daily window.
WITH account_activity AS (
  SELECT r.user_id,
         p.starts_at,
         p.ends_at,
         p.token_limit,
         0 AS consumed_tokens,
         SUM(CASE WHEN r.status = 'reserved' THEN r.reserved_tokens ELSE 0 END) AS reserved_tokens
  FROM usage_reservations r
  JOIN usage_periods p ON p.id = r.usage_period_id
  JOIN plans pl ON pl.id = p.plan_id
  WHERE pl.billing_interval = 'competition'
  GROUP BY r.user_id, p.starts_at, p.ends_at, p.token_limit

  UNION ALL

  SELECT e.user_id,
         p.starts_at,
         p.ends_at,
         p.token_limit,
         SUM(e.total_tokens) AS consumed_tokens,
         0 AS reserved_tokens
  FROM usage_events e
  JOIN usage_periods p ON p.id = e.usage_period_id
  JOIN plans pl ON pl.id = p.plan_id
  WHERE pl.billing_interval = 'competition'
  GROUP BY e.user_id, p.starts_at, p.ends_at, p.token_limit
)
INSERT INTO account_usage_periods
  (id, user_id, starts_at, ends_at, token_limit, consumed_tokens, reserved_tokens)
SELECT 'aup_mig_' || lower(hex(randomblob(16))),
       user_id,
       starts_at,
       MIN(ends_at),
       MIN(token_limit),
       SUM(consumed_tokens),
       SUM(reserved_tokens)
FROM account_activity
GROUP BY user_id, starts_at;

UPDATE usage_reservations
SET account_usage_period_id = (
  SELECT a.id
  FROM account_usage_periods a
  JOIN usage_periods p ON p.starts_at = a.starts_at
  WHERE a.user_id = usage_reservations.user_id
    AND p.id = usage_reservations.usage_period_id
)
WHERE account_usage_period_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM usage_periods p
    JOIN plans pl ON pl.id = p.plan_id
    WHERE p.id = usage_reservations.usage_period_id
      AND pl.billing_interval = 'competition'
  );

UPDATE usage_events
SET account_usage_period_id = (
  SELECT a.id
  FROM account_usage_periods a
  JOIN usage_periods p ON p.starts_at = a.starts_at
  WHERE a.user_id = usage_events.user_id
    AND p.id = usage_events.usage_period_id
)
WHERE account_usage_period_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM usage_periods p
    JOIN plans pl ON pl.id = p.plan_id
    WHERE p.id = usage_events.usage_period_id
      AND pl.billing_interval = 'competition'
  );

UPDATE usage_periods
SET quota_scope = 'account'
WHERE plan_id IN (SELECT id FROM plans WHERE billing_interval = 'competition');
