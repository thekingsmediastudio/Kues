-- Attach verified Keus accounts to one stable default workspace and persist setup state.
-- The workspace tables remain the tenant boundary; Turso is still shared by the service.
CREATE TABLE IF NOT EXISTS user_default_workspaces (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspaces(id, owner_user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_onboarding (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'completed')),
  profile_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(profile_json)),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A workspace may receive one competition grant per configured competition window.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_competition_window
  ON entitlements(workspace_id, starts_at, ends_at)
  WHERE source = 'competition';
