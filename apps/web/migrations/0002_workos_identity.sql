-- Add WorkOS AuthKit as a linked identity provider without changing local user IDs,
-- sessions, or usage/account ownership. Do not edit the already-applied 0001 migration.
CREATE TABLE auth_identities_workos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('email_magic_link', 'google_oauth', 'workos')),
  provider_subject TEXT NOT NULL,
  email_at_provider TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  UNIQUE (provider, provider_subject)
);

INSERT INTO auth_identities_workos
  (id, user_id, provider, provider_subject, email_at_provider, created_at, last_used_at)
SELECT id, user_id, provider, provider_subject, email_at_provider, created_at, last_used_at
FROM auth_identities;

DROP TABLE auth_identities;
ALTER TABLE auth_identities_workos RENAME TO auth_identities;
CREATE INDEX idx_auth_identities_user ON auth_identities(user_id);
