-- Persist account-scoped appearance preferences and bind email-change codes to
-- the authenticated session that initiated the WorkOS verification flow.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The six-digit code stays with WorkOS. Keus stores only the pending target,
-- expiry, attempt count, and a hash of the initiating session token.
CREATE TABLE IF NOT EXISTS pending_email_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  new_email TEXT NOT NULL UNIQUE,
  session_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_email_changes_expiry
  ON pending_email_changes(expires_at);
