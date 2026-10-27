import crypto from 'node:crypto';
import { withWriteTransaction } from '../db/transaction.mjs';
import { deriveAiChatHistoryKey } from './service.mjs';

export const AI_CHAT_HISTORY_LIMIT = 100;
const MAX_MESSAGE_LENGTH = 4_000;

export class AiChatHistoryError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AiChatHistoryError';
    this.code = code;
    this.status = status;
  }
}

function requiredText(value, code, maxLength = 255) {
  if (typeof value !== 'string') throw new AiChatHistoryError(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw new AiChatHistoryError(code);
  }
  return normalized;
}

function messageText(value, code, maxLength = MAX_MESSAGE_LENGTH) {
  if (typeof value !== 'string') throw new AiChatHistoryError(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /\0/.test(normalized)) {
    throw new AiChatHistoryError(code);
  }
  return normalized;
}

function messageAad({ workspaceId, userId, agentId, conversationId, messageId, role }) {
  return Buffer.from(
    `keus:ai-chat-history:v1:${workspaceId}:${userId}:${agentId}:${conversationId}:${messageId}:${role}`,
    'utf8',
  );
}

function encryptMessage(content, key, record) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(messageAad(record));
  const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decodeBase64(value, expectedLength) {
  const decoded = Buffer.from(String(value || ''), 'base64');
  if (decoded.length !== expectedLength || decoded.toString('base64') !== value) {
    throw new Error('invalid_encrypted_message');
  }
  return decoded;
}

function decryptMessage(row, key, record) {
  try {
    if (Number(row.key_version) !== 1) throw new Error('unsupported_message_key_version');
    const nonce = decodeBase64(row.content_nonce, 12);
    const tag = decodeBase64(row.content_tag, 16);
    const ciphertext = Buffer.from(String(row.content_ciphertext || ''), 'base64');
    if (!ciphertext.length || ciphertext.toString('base64') !== row.content_ciphertext) {
      throw new Error('invalid_encrypted_message');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(messageAad(record));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new AiChatHistoryError('ai_chat_history_unavailable', 503);
  }
}

function normalizeLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, AI_CHAT_HISTORY_LIMIT);
}

export function createAiChatHistoryService({ db, encryptionKey, now = () => new Date() } = {}) {
  if (!db) throw new TypeError('db_required');
  const key = deriveAiChatHistoryKey(encryptionKey);

  async function findConversation({ workspaceId, userId, agentId }) {
    const result = await db.execute({
      sql: `SELECT id FROM ai_chat_conversations
            WHERE workspace_id = ? AND user_id = ? AND agent_id = ? LIMIT 1`,
      args: [workspaceId, userId, agentId],
    });
    return result.rows[0] || null;
  }

  async function readMessages({ workspaceId, userId, agentId, conversationId, limit }) {
    const result = await db.execute({
      sql: `SELECT id, sequence, role, content_ciphertext, content_nonce, content_tag,
                   key_version, created_at
            FROM ai_chat_messages
            WHERE workspace_id = ? AND conversation_id = ?
            ORDER BY sequence DESC LIMIT ?`,
      args: [workspaceId, conversationId, normalizeLimit(limit, AI_CHAT_HISTORY_LIMIT)],
    });
    return result.rows.reverse().map((row) => {
      const record = { workspaceId, userId, agentId, conversationId, messageId: row.id, role: row.role };
      return {
        role: row.role,
        content: decryptMessage(row, key, record),
        createdAt: row.created_at,
      };
    });
  }

  async function getHistory({ workspaceId: rawWorkspaceId, userId: rawUserId, agentId: rawAgentId }) {
    const workspaceId = requiredText(rawWorkspaceId, 'workspace_id_invalid');
    const userId = requiredText(rawUserId, 'user_id_invalid');
    const agentId = requiredText(rawAgentId, 'agent_id_invalid');
    try {
      const conversation = await findConversation({ workspaceId, userId, agentId });
      if (!conversation) return { conversationId: null, messages: [] };
      return {
        conversationId: conversation.id,
        messages: await readMessages({ workspaceId, userId, agentId, conversationId: conversation.id, limit: AI_CHAT_HISTORY_LIMIT }),
      };
    } catch (error) {
      if (error instanceof AiChatHistoryError) throw error;
      throw new AiChatHistoryError('ai_chat_history_unavailable', 503);
    }
  }

  async function getRecentMessages({ workspaceId: rawWorkspaceId, userId: rawUserId, agentId: rawAgentId, limit = 11 }) {
    const workspaceId = requiredText(rawWorkspaceId, 'workspace_id_invalid');
    const userId = requiredText(rawUserId, 'user_id_invalid');
    const agentId = requiredText(rawAgentId, 'agent_id_invalid');
    try {
      const conversation = await findConversation({ workspaceId, userId, agentId });
      if (!conversation) return [];
      return (await readMessages({ workspaceId, userId, agentId, conversationId: conversation.id, limit }))
        .map(({ role, content }) => ({ role, content }));
    } catch (error) {
      if (error instanceof AiChatHistoryError) throw error;
      throw new AiChatHistoryError('ai_chat_history_unavailable', 503);
    }
  }

  async function appendExchange({
    workspaceId: rawWorkspaceId,
    userId: rawUserId,
    agentId: rawAgentId,
    userMessage: rawUserMessage,
    assistantMessage: rawAssistantMessage,
  }) {
    const workspaceId = requiredText(rawWorkspaceId, 'workspace_id_invalid');
    const userId = requiredText(rawUserId, 'user_id_invalid');
    const agentId = requiredText(rawAgentId, 'agent_id_invalid');
    const userMessage = messageText(rawUserMessage, 'ai_chat_message_invalid');
    const assistantMessage = messageText(rawAssistantMessage, 'ai_chat_reply_invalid', 20_000);
    const timestamp = new Date(now()).toISOString();

    let conversationId;
    try {
      conversationId = await withWriteTransaction(db, async (tx) => {
        const agent = await tx.execute({
          sql: `SELECT id FROM agents WHERE id = ? AND workspace_id = ? LIMIT 1`,
          args: [agentId, workspaceId],
        });
        if (!agent.rows.length) throw new AiChatHistoryError('ai_chat_agent_unavailable', 404);

        const candidateId = crypto.randomUUID();
        await tx.execute({
          sql: `INSERT INTO ai_chat_conversations (id, workspace_id, user_id, agent_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (workspace_id, user_id, agent_id) DO NOTHING`,
          args: [candidateId, workspaceId, userId, agentId, timestamp, timestamp],
        });
        const conversationResult = await tx.execute({
          sql: `SELECT id FROM ai_chat_conversations
                WHERE workspace_id = ? AND user_id = ? AND agent_id = ? LIMIT 1`,
          args: [workspaceId, userId, agentId],
        });
        const id = conversationResult.rows[0]?.id;
        if (!id) throw new AiChatHistoryError('ai_chat_history_unavailable', 503);

        const sequenceResult = await tx.execute({
          sql: 'SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM ai_chat_messages WHERE conversation_id = ?',
          args: [id],
        });
        const firstSequence = Number(sequenceResult.rows[0]?.last_sequence || 0) + 1;
        const entries = [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: assistantMessage },
        ];
        for (const [index, entry] of entries.entries()) {
          const messageId = crypto.randomUUID();
          const sequence = firstSequence + index;
          const record = { workspaceId, userId, agentId, conversationId: id, messageId, role: entry.role };
          const encrypted = encryptMessage(entry.content, key, record);
          await tx.execute({
            sql: `INSERT INTO ai_chat_messages
                    (id, workspace_id, conversation_id, sequence, role, content_ciphertext,
                     content_nonce, content_tag, key_version, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            args: [messageId, workspaceId, id, sequence, entry.role, encrypted.ciphertext, encrypted.nonce, encrypted.tag, timestamp],
          });
        }
        await tx.execute({
          sql: 'UPDATE ai_chat_conversations SET updated_at = ? WHERE id = ? AND workspace_id = ?',
          args: [timestamp, id, workspaceId],
        });
        await tx.execute({
          sql: `DELETE FROM ai_chat_messages
                WHERE conversation_id = ?
                  AND sequence <= (SELECT COALESCE(MAX(sequence), 0) - ? FROM ai_chat_messages WHERE conversation_id = ?)`,
          args: [id, AI_CHAT_HISTORY_LIMIT, id],
        });
        return id;
      });
    } catch (error) {
      if (error instanceof AiChatHistoryError) throw error;
      throw new AiChatHistoryError('ai_chat_history_unavailable', 503);
    }

    const history = await getHistory({ workspaceId, userId, agentId });
    return { ...history, conversationId };
  }

  return Object.freeze({ getHistory, getRecentMessages, appendExchange });
}
