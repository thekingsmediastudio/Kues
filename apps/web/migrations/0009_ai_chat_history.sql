-- Persist per-account, per-agent test chat threads. Message content is AES-GCM ciphertext only.
CREATE TABLE IF NOT EXISTS ai_chat_conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, user_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_conversations_user_updated
  ON ai_chat_conversations(workspace_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_ciphertext TEXT NOT NULL CHECK (length(content_ciphertext) > 0),
  content_nonce TEXT NOT NULL CHECK (length(content_nonce) > 0),
  content_tag TEXT NOT NULL CHECK (length(content_tag) > 0),
  key_version INTEGER NOT NULL CHECK (key_version = 1),
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES ai_chat_conversations(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (conversation_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_conversation_sequence
  ON ai_chat_messages(conversation_id, sequence DESC);
