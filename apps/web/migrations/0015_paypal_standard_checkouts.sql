CREATE TABLE paypal_standard_checkouts (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 mandate_id TEXT NOT NULL UNIQUE,
 session_hash TEXT NOT NULL,
 state_hash TEXT NOT NULL UNIQUE,
 snapshot_hash TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 currency TEXT NOT NULL CHECK(currency='USD'),
 status TEXT NOT NULL CHECK(status IN ('creating','pending','authorizing','authorized','voiding','voided','cancelled','failed','uncertain','void_uncertain')),
 order_id TEXT UNIQUE,
 approval_url TEXT,
 authorization_id TEXT UNIQUE,
 merchant_id TEXT,
 expires_at INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 authorized_at TEXT,
 FOREIGN KEY(workspace_id,mandate_id) REFERENCES mandates(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX paypal_standard_checkout_scope ON paypal_standard_checkouts(workspace_id,user_id,created_at);
CREATE TABLE paypal_standard_checkout_events (
 id TEXT PRIMARY KEY,
 checkout_id TEXT NOT NULL REFERENCES paypal_standard_checkouts(id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL,
 details_json TEXT NOT NULL CHECK(json_valid(details_json)),
 receipt_hash TEXT NOT NULL,
 created_at TEXT NOT NULL
);
