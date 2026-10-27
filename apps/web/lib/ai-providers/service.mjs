import crypto from 'node:crypto';
import net from 'node:net';
import { withWriteTransaction } from '../db/transaction.mjs';

const ALLOWED_PROTOCOLS = new Set([
  'openai_chat',
  'openai_responses',
  'anthropic_messages',
  'google_generative',
]);
const MAX_API_KEY_LENGTH = 4096;

export class AiProviderError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AiProviderError';
    this.code = code;
    this.status = status;
  }
}

function decodeEncryptionKey(value) {
  const input = String(value || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(input)) {
    key = Buffer.from(input, 'hex');
  } else {
    key = Buffer.from(input, 'base64');
    if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) {
      throw new TypeError('ai_provider_encryption_key_invalid');
    }
  }
  if (key.length !== 32) throw new TypeError('ai_provider_encryption_key_invalid');
  return key;
}

function encryptedKeyAad({ id, provider_key, key_version }) {
  return Buffer.from(`keus:ai-provider:${id}:${provider_key}:v${key_version}`, 'utf8');
}

function encryptApiKey(apiKey, key, provider) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(encryptedKeyAad(provider));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decodeBase64Field(value, expectedLength) {
  const input = String(value || '');
  const decoded = Buffer.from(input, 'base64');
  if (decoded.length !== expectedLength || decoded.toString('base64') !== input) {
    throw new Error('invalid_encrypted_field');
  }
  return decoded;
}

function decryptApiKey(row, key) {
  try {
    if (Number(row.key_version) !== 1) throw new Error('key_version_unavailable');
    const nonce = decodeBase64Field(row.api_key_nonce, 12);
    const tag = decodeBase64Field(row.api_key_tag, 16);
    const ciphertext = Buffer.from(String(row.api_key_ciphertext || ''), 'base64');
    if (!ciphertext.length || ciphertext.toString('base64') !== row.api_key_ciphertext) {
      throw new Error('invalid_encrypted_field');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(encryptedKeyAad(row));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new AiProviderError('ai_provider_secret_unavailable', 503);
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cleanString(value, code, maxLength) {
  if (typeof value !== 'string') throw new AiProviderError(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw new AiProviderError(code);
  }
  return normalized;
}

function forbiddenHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.test')
    || host.endsWith('.example') || host.endsWith('.invalid')
    || host === 'metadata.google.internal' || host === 'instance-data.ec2.internal';
}

function normalizeBaseUrl(value) {
  const raw = cleanString(value, 'ai_provider_base_url_invalid', 512);
  if (/%2e/i.test(raw) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)) {
    throw new AiProviderError('ai_provider_base_url_invalid');
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw new AiProviderError('ai_provider_base_url_invalid'); }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.port || forbiddenHostname(hostname) || net.isIP(hostname) || /%2f|%5c/i.test(parsed.pathname)) {
    throw new AiProviderError('ai_provider_base_url_invalid');
  }
  let decodedPath;
  try { decodedPath = decodeURIComponent(parsed.pathname); }
  catch { throw new AiProviderError('ai_provider_base_url_invalid'); }
  if (decodedPath.includes('\\') || decodedPath.split('/').some((part) => part === '.' || part === '..')) {
    throw new AiProviderError('ai_provider_base_url_invalid');
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
  return parsed.toString();
}

function normalizeInput(input) {
  if (!plainObject(input)) throw new AiProviderError('ai_provider_input_invalid');
  const allowedFields = new Set([
    'providerKey', 'displayName', 'apiProtocol', 'baseUrl', 'modelId', 'apiKey', 'enabled', 'isPrimary',
  ]);
  if (Object.keys(input).some((field) => !allowedFields.has(field))) {
    throw new AiProviderError('ai_provider_input_invalid');
  }

  const providerKey = cleanString(input.providerKey, 'ai_provider_key_invalid', 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerKey)) {
    throw new AiProviderError('ai_provider_key_invalid');
  }
  const displayName = cleanString(input.displayName, 'ai_provider_name_invalid', 80);
  const apiProtocol = cleanString(input.apiProtocol, 'ai_provider_protocol_invalid', 40).toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(apiProtocol)) throw new AiProviderError('ai_provider_protocol_invalid');
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const modelId = cleanString(input.modelId, 'ai_provider_model_invalid', 160);
  if (typeof input.apiKey !== 'string') throw new AiProviderError('ai_provider_key_required');
  const apiKey = input.apiKey.trim();
  if (!apiKey || apiKey.length > MAX_API_KEY_LENGTH || /[\r\n\0]/.test(apiKey)) {
    throw new AiProviderError('ai_provider_key_invalid');
  }
  const enabled = input.enabled === undefined ? false : input.enabled;
  const isPrimary = input.isPrimary === undefined ? false : input.isPrimary;
  if (typeof enabled !== 'boolean' || typeof isPrimary !== 'boolean') {
    throw new AiProviderError('ai_provider_status_invalid');
  }
  if (isPrimary && !enabled) throw new AiProviderError('ai_provider_primary_requires_enabled');
  return { providerKey, displayName, apiProtocol, baseUrl, modelId, apiKey, enabled, isPrimary };
}

function safeProvider(row) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    apiProtocol: row.api_protocol,
    baseUrl: row.base_url,
    modelId: row.model_id,
    enabled: Number(row.enabled) === 1,
    isPrimary: Number(row.is_primary) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAiProviderService({ db, encryptionKey, now = () => new Date() } = {}) {
  if (!db) throw new TypeError('db_required');
  const key = decodeEncryptionKey(encryptionKey);

  async function createProvider({ input }) {
    const normalized = normalizeInput(input);
    const id = crypto.randomUUID();
    const keyVersion = 1;
    const timestamp = new Date(now()).toISOString();
    const encrypted = encryptApiKey(normalized.apiKey, key, {
      id,
      provider_key: normalized.providerKey,
      key_version: keyVersion,
    });
    try {
      await withWriteTransaction(db, async (tx) => {
        await tx.execute({
          sql: `INSERT INTO ai_providers
                  (id, provider_key, display_name, api_protocol, base_url, model_id,
                   api_key_ciphertext, api_key_nonce, api_key_tag, key_version, enabled,
                   is_primary, settings_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
          args: [
            id, normalized.providerKey, normalized.displayName, normalized.apiProtocol,
            normalized.baseUrl, normalized.modelId, encrypted.ciphertext, encrypted.nonce,
            encrypted.tag, keyVersion, normalized.enabled ? 1 : 0, normalized.isPrimary ? 1 : 0,
            timestamp, timestamp,
          ],
        });
      });
    } catch (error) {
      const detail = String(error?.message || '');
      if (/UNIQUE constraint failed: ai_providers\.is_primary/i.test(detail)) {
        throw new AiProviderError('ai_provider_primary_exists', 409);
      }
      if (/UNIQUE constraint failed/i.test(detail)) {
        throw new AiProviderError('ai_provider_already_exists', 409);
      }
      throw error;
    }
    const result = await db.execute({
      sql: `SELECT id, provider_key, display_name, api_protocol, base_url, model_id,
                   enabled, is_primary, created_at, updated_at
            FROM ai_providers WHERE id = ?`,
      args: [id],
    });
    return safeProvider(result.rows[0]);
  }

  async function listProviders() {
    const result = await db.execute(`
      SELECT id, provider_key, display_name, api_protocol, base_url, model_id,
             enabled, is_primary, created_at, updated_at
      FROM ai_providers ORDER BY created_at DESC, provider_key ASC
    `);
    return result.rows.map(safeProvider);
  }

  // This is an internal server-side accessor for future provider calls, not an HTTP response.
  async function getProviderForRuntime({ providerKey }) {
    const normalizedKey = String(providerKey || '').trim().toLowerCase();
    if (!normalizedKey) throw new AiProviderError('ai_provider_key_invalid');
    const result = await db.execute({
      sql: `SELECT id, provider_key, display_name, api_protocol, base_url, model_id,
                   api_key_ciphertext, api_key_nonce, api_key_tag, key_version,
                   enabled, is_primary, created_at, updated_at
            FROM ai_providers WHERE provider_key = ? AND enabled = 1`,
      args: [normalizedKey],
    });
    const row = result.rows[0];
    if (!row) throw new AiProviderError('ai_provider_not_found', 404);
    return { ...safeProvider(row), apiKey: decryptApiKey(row, key) };
  }

  return Object.freeze({ createProvider, listProviders, getProviderForRuntime });
}
