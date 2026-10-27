import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { AiChatHistoryError, createAiChatHistoryService } from '../../apps/web/lib/ai-providers/history.mjs';

const encryptionKey = Buffer.alloc(32, 77).toString('base64');

async function createHistoryFixture() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  await db.batch([
    { sql: "INSERT INTO users (id, email_normalized, display_name) VALUES ('user-1', 'one@example.test', 'One')" },
    { sql: "INSERT INTO users (id, email_normalized, display_name) VALUES ('user-2', 'two@example.test', 'Two')" },
    { sql: "INSERT INTO workspaces (id, owner_user_id, name) VALUES ('workspace-1', 'user-1', 'One workspace')" },
    { sql: "INSERT INTO workspaces (id, owner_user_id, name) VALUES ('workspace-2', 'user-2', 'Two workspace')" },
    { sql: "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('workspace-1', 'user-1', 'owner')" },
    { sql: "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('workspace-2', 'user-2', 'owner')" },
    { sql: "INSERT INTO agents (id, workspace_id, name, role) VALUES ('agent-1', 'workspace-1', 'Desk helper', 'Organizer')" },
    { sql: "INSERT INTO agents (id, workspace_id, name, role) VALUES ('agent-2', 'workspace-1', 'Writing helper', 'Editor')" },
    { sql: "INSERT INTO agents (id, workspace_id, name, role) VALUES ('agent-3', 'workspace-2', 'Private helper', 'Assistant')" },
  ], 'write');
  return { db, history: createAiChatHistoryService({ db, encryptionKey, now: () => new Date('2026-10-28T12:00:00.000Z') }) };
}

test('AI chat history encrypts content at rest and scopes it to workspace, account, and agent', async () => {
  const { db, history } = await createHistoryFixture();
  try {
    const saved = await history.appendExchange({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      agentId: 'agent-1',
      userMessage: 'A non-sensitive test prompt',
      assistantMessage: 'A sample test reply',
    });
    assert.equal(saved.messages.length, 2);
    assert.deepEqual(saved.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'A non-sensitive test prompt' },
      { role: 'assistant', content: 'A sample test reply' },
    ]);

    const stored = await db.execute({
      sql: 'SELECT role, content_ciphertext, content_nonce, content_tag, key_version FROM ai_chat_messages WHERE conversation_id = ? ORDER BY sequence',
      args: [saved.conversationId],
    });
    assert.equal(stored.rows.length, 2);
    for (const row of stored.rows) {
      assert.equal(String(row.content_ciphertext).includes('non-sensitive test prompt'), false);
      assert.equal(String(row.content_ciphertext).includes('sample test reply'), false);
      assert.equal(row.key_version, 1);
      assert.ok(row.content_nonce);
      assert.ok(row.content_tag);
    }

    assert.deepEqual((await history.getHistory({ workspaceId: 'workspace-1', userId: 'user-1', agentId: 'agent-1' })).messages, saved.messages);
    assert.deepEqual(await history.getHistory({ workspaceId: 'workspace-2', userId: 'user-2', agentId: 'agent-3' }), { conversationId: null, messages: [] });
    assert.deepEqual(await history.getHistory({ workspaceId: 'workspace-1', userId: 'user-1', agentId: 'agent-2' }), { conversationId: null, messages: [] });
  } finally {
    await db.close();
  }
});

test('AI chat history provides only a bounded recent context and caps stored history at 100 messages', async () => {
  const { db, history } = await createHistoryFixture();
  try {
    for (let turn = 1; turn <= 51; turn += 1) {
      await history.appendExchange({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        agentId: 'agent-1',
        userMessage: `Prompt ${turn}`,
        assistantMessage: `Reply ${turn}`,
      });
    }
    const all = await history.getHistory({ workspaceId: 'workspace-1', userId: 'user-1', agentId: 'agent-1' });
    assert.equal(all.messages.length, 100);
    assert.deepEqual(all.messages.slice(0, 2).map(({ content }) => content), ['Prompt 2', 'Reply 2']);
    assert.deepEqual(all.messages.slice(-2).map(({ content }) => content), ['Prompt 51', 'Reply 51']);

    const recent = await history.getRecentMessages({ workspaceId: 'workspace-1', userId: 'user-1', agentId: 'agent-1', limit: 11 });
    assert.equal(recent.length, 11);
    assert.deepEqual(recent.slice(-2).map(({ content }) => content), ['Prompt 51', 'Reply 51']);
  } finally {
    await db.close();
  }
});

test('AI chat history rejects oversized content, invalid key material, and tampered ciphertext', async () => {
  const { db, history } = await createHistoryFixture();
  try {
    await assert.rejects(
      history.appendExchange({
        workspaceId: 'workspace-1', userId: 'user-1', agentId: 'agent-1',
        userMessage: 'x'.repeat(4_001), assistantMessage: 'Valid reply',
      }),
      (error) => error instanceof AiChatHistoryError && error.code === 'ai_chat_message_invalid',
    );
    assert.throws(() => createAiChatHistoryService({ db, encryptionKey: 'bad-key' }), /ai_provider_encryption_key_invalid/);

    const saved = await history.appendExchange({
      workspaceId: 'workspace-1', userId: 'user-1', agentId: 'agent-1',
      userMessage: 'Original prompt', assistantMessage: 'Original reply',
    });
    await db.execute({ sql: "UPDATE ai_chat_messages SET content_ciphertext = 'AAAA' WHERE conversation_id = ? AND role = 'user'", args: [saved.conversationId] });
    await assert.rejects(
      history.getHistory({ workspaceId: 'workspace-1', userId: 'user-1', agentId: 'agent-1' }),
      (error) => error instanceof AiChatHistoryError && error.code === 'ai_chat_history_unavailable' && error.status === 503,
    );
  } finally {
    await db.close();
  }
});
