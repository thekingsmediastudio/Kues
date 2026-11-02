CREATE TABLE IF NOT EXISTS execution_jobs (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 state TEXT NOT NULL,
 digest TEXT NOT NULL,
 plan_cipher TEXT,
 result_cipher TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 prepare_expires_at INTEGER NOT NULL,
 approved_at INTEGER,
 lease_token TEXT,
 lease_until INTEGER,
 vm_id TEXT,
 error_code TEXT,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 cleanup_pending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS execution_jobs_scope ON execution_jobs(user_id,workspace_id,agent_id,created_at);
CREATE INDEX IF NOT EXISTS execution_jobs_recovery ON execution_jobs(state,lease_until);
CREATE TABLE IF NOT EXISTS execution_budget_counters (
 budget_key TEXT PRIMARY KEY,
 used INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL
);
