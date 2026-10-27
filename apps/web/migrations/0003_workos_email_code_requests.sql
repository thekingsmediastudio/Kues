-- Track WorkOS email verification and password-reset request limits without storing emailed secrets.
CREATE TABLE auth_challenges_workos_code (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_magic_link', 'workos_email_code', 'google_oauth_state', 'passkey_registration', 'passkey_login')),
  identifier TEXT,
  challenge_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO auth_challenges_workos_code
  (id, user_id, purpose, identifier, challenge_hash, expires_at, consumed_at, failed_attempts, created_at)
SELECT id, user_id, purpose, identifier, challenge_hash, expires_at, consumed_at, failed_attempts, created_at
FROM auth_challenges;

DROP TABLE auth_challenges;
ALTER TABLE auth_challenges_workos_code RENAME TO auth_challenges;
CREATE INDEX idx_auth_challenges_expiry ON auth_challenges(expires_at);
CREATE INDEX idx_auth_challenges_email_rate ON auth_challenges(purpose, identifier, created_at);
