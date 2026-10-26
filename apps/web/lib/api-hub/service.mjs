import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { withWriteTransaction } from '../db/transaction.mjs';

const TOKEN_PREFIX = 'khub_';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_OPERATIONS = 50;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUESTS_PER_MINUTE = 60;
const MAX_TOKEN_DAYS = 90;
const RESERVED_HEADERS = new Set([
  'authorization', 'connection', 'content-length', 'cookie', 'host', 'keep-alive',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'accept-encoding',
]);
const SENSITIVE_KEYS = /(?:token|secret|password|authorization|private.?key|client.?secret|api.?key)/i;

export class ApiHubError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'ApiHubError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asIso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid_now_timestamp');
  return date.toISOString();
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function decodeEncryptionKey(value) {
  const input = String(value || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(input)) key = Buffer.from(input, 'hex');
  else {
    key = Buffer.from(input, 'base64');
    if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) {
      throw new TypeError('api_hub_encryption_key_invalid');
    }
  }
  if (key.length !== 32) throw new TypeError('api_hub_encryption_key_invalid');
  return key;
}

function encryptSecret(secret, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptSecret(record, key) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.auth_nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.auth_ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ApiHubError('connector_secret_unavailable', 503);
  }
}

function forbiddenHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.test')
    || host.endsWith('.example') || host.endsWith('.invalid')
    || host === 'metadata.google.internal' || host === 'instance-data.ec2.internal';
}

function isPublicIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 2 || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address) {
  const value = String(address).toLowerCase().split('%')[0];
  // Only global-unicast 2000::/3 is accepted. This excludes loopback, mapped IPv4,
  // unique-local, link-local, multicast, unspecified, and other special-use ranges.
  const first = Number.parseInt(value.split(':').filter(Boolean)[0] || '', 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  if (value.startsWith('2001:db8:') || value === '2001:db8::') return false;
  if (value.startsWith('2001:0:') || value.startsWith('2002:')) return false;
  return true;
}

function isPublicAddress(address) {
  const family = net.isIP(String(address));
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function normalizeBaseUrl(rawValue) {
  const raw = String(rawValue || '').trim();
  if (/%2e/i.test(raw) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)) throw new ApiHubError('connector_base_url_invalid');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new ApiHubError('connector_base_url_invalid'); }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.port || forbiddenHostname(hostname) || net.isIP(hostname) || /%2f|%5c/i.test(parsed.pathname)) {
    throw new ApiHubError('connector_base_url_invalid');
  }
  const decodedPath = (() => {
    try { return decodeURIComponent(parsed.pathname); } catch { return ''; }
  })();
  if (!decodedPath || decodedPath.includes('\\') || decodedPath.split('/').some((part) => part === '.' || part === '..')) {
    throw new ApiHubError('connector_base_url_invalid');
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
  return parsed.toString();
}

function validateHeaderName(rawName, { allowAuthorization = false } = {}) {
  const name = String(rawName || '').trim();
  const lower = name.toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name)
      || RESERVED_HEADERS.has(lower)
      || lower.startsWith('proxy-') || lower.startsWith('sec-') || lower.startsWith('x-forwarded-')
      || (!allowAuthorization && lower === 'authorization')) {
    throw new ApiHubError('connector_header_invalid');
  }
  return name;
}

function validateDefaultHeaders(value) {
  if (value == null) return {};
  if (!plainObject(value) || Object.keys(value).length > 12) throw new ApiHubError('connector_headers_invalid');
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = validateHeaderName(rawName).toLowerCase();
    const headerValue = String(rawValue ?? '').trim();
    if (Object.hasOwn(headers, name) || !headerValue || headerValue.length > 512 || /[\r\n\0]/.test(headerValue)) {
      throw new ApiHubError('connector_headers_invalid');
    }
    headers[name] = headerValue;
  }
  return headers;
}

function validateOperation(raw) {
  if (!plainObject(raw)) throw new ApiHubError('connector_operation_invalid');
  const name = String(raw.name || '').trim();
  const method = String(raw.method || '').trim().toUpperCase();
  const path = String(raw.path || '').trim();
  const description = String(raw.description || '').trim().slice(0, 240);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !ALLOWED_METHODS.has(method)
      || !path.startsWith('/') || path.length > 512 || path.includes('?') || path.includes('#')
      || path.includes('\\') || path.includes('//') || /%2e|%2f|%5c/i.test(path)) {
    throw new ApiHubError('connector_operation_invalid');
  }
  const withoutParams = path.replace(/\{[A-Za-z][A-Za-z0-9_]*\*?\}/g, 'x');
  if (/[{}]/.test(withoutParams) || withoutParams.split('/').some((part) => part === '.' || part === '..')) {
    throw new ApiHubError('connector_operation_invalid');
  }
  const params = [...path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)(\*)?\}/g)];
  const names = params.map((match) => match[1]);
  if (new Set(names).size !== names.length) throw new ApiHubError('connector_operation_invalid');
  return { name, method, path, description };
}

function validateConnectorInput(input) {
  if (!plainObject(input)) throw new ApiHubError('connector_input_invalid');
  const name = String(input.name || '').trim();
  if (!name || name.length > 80 || /[\r\n\0]/.test(name)) throw new ApiHubError('connector_name_invalid');
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const authType = String(input.authType || 'none').trim().toLowerCase();
  if (!['none', 'bearer', 'header'].includes(authType)) throw new ApiHubError('connector_auth_type_invalid');
  const authSecret = String(input.authSecret || '');
  if (authSecret.length > 4096 || /[\r\n\0]/.test(authSecret)) throw new ApiHubError('connector_auth_secret_invalid');
  let authHeader = null;
  if (authType === 'none' && authSecret) throw new ApiHubError('connector_auth_secret_invalid');
  if (authType !== 'none' && !authSecret) throw new ApiHubError('connector_auth_secret_required');
  if (authType === 'header') authHeader = validateHeaderName(input.authHeader);
  const defaultHeaders = validateDefaultHeaders(input.defaultHeaders);
  const operationsRaw = input.operations;
  if (!Array.isArray(operationsRaw) || !operationsRaw.length || operationsRaw.length > MAX_OPERATIONS) {
    throw new ApiHubError('connector_operations_invalid');
  }
  const operations = operationsRaw.map(validateOperation);
  if (new Set(operations.map((operation) => operation.name)).size !== operations.length) {
    throw new ApiHubError('connector_operations_invalid');
  }
  return { name, baseUrl, authType, authHeader, authSecret, defaultHeaders, operations };
}

function buildOperationUrl(baseUrlValue, operation, pathParams, query) {
  if (!plainObject(pathParams || {}) || !plainObject(query || {})) throw new ApiHubError('invoke_parameters_invalid');
  const matches = [...operation.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)(\*)?\}/g)];
  const expected = new Set(matches.map((match) => match[1]));
  if (Object.keys(pathParams || {}).some((name) => !expected.has(name))) throw new ApiHubError('invoke_path_parameter_invalid');
  let path = operation.path.replace(/\{([A-Za-z][A-Za-z0-9_]*)(\*)?\}/g, (_placeholder, name, greedy) => {
    const value = pathParams[name];
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length > 512) {
      throw new ApiHubError('invoke_path_parameter_required');
    }
    const raw = String(value);
    if (/[\r\n\0\\]/.test(raw) || /%2e|%2f|%5c/i.test(raw) || raw === '.' || raw === '..') throw new ApiHubError('invoke_path_parameter_invalid');
    if (greedy) {
      const segments = raw.split('/');
      if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new ApiHubError('invoke_path_parameter_invalid');
      }
      return segments.map((segment) => encodeURIComponent(segment)).join('/');
    }
    return encodeURIComponent(raw);
  });
  if (/[{}]/.test(path)) throw new ApiHubError('invoke_path_parameter_invalid');
  const base = new URL(baseUrlValue);
  const relativePath = path.replace(/^\/+/, '');
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const target = new URL(relativePath, `${base.origin}${basePath}`);
  if (target.origin !== base.origin || !target.pathname.startsWith(basePath)) throw new ApiHubError('invoke_path_invalid');
  let pairCount = 0;
  for (const [key, value] of Object.entries(query || {})) {
    if (!/^[A-Za-z0-9_.~-]{1,100}$/.test(key) || SENSITIVE_KEYS.test(key)) throw new ApiHubError('invoke_query_invalid');
    const values = Array.isArray(value) ? value : [value];
    if (values.length > 20) throw new ApiHubError('invoke_query_invalid');
    for (const item of values) {
      if (!['string', 'number', 'boolean'].includes(typeof item) || String(item).length > 1024) {
        throw new ApiHubError('invoke_query_invalid');
      }
      target.searchParams.append(key, String(item));
      pairCount += 1;
      if (pairCount > 50) throw new ApiHubError('invoke_query_invalid');
    }
  }
  return target;
}

async function resolvePublicAddresses(hostname, resolveHost) {
  const cleanHost = String(hostname || '').replace(/^\[|\]$/g, '');
  if (forbiddenHostname(cleanHost) || net.isIP(cleanHost)) throw new ApiHubError('connector_destination_blocked', 403);
  let addresses;
  try { addresses = await resolveHost(cleanHost); } catch { throw new ApiHubError('connector_host_unavailable', 502); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new ApiHubError('connector_destination_blocked', 403);
  }
  return addresses;
}

export function createPinnedLookup(preferred) {
  if (!preferred || !net.isIP(String(preferred.address || '')) || ![4, 6].includes(Number(preferred.family))) {
    throw new TypeError('pinned_address_invalid');
  }
  return (_hostname, options, callback) => {
    // Node may request all addresses for autoSelectFamily. In that mode, lookup
    // callbacks must receive an array of { address, family } records.
    const lookupOptions = typeof options === 'function' ? {} : (options || {});
    const done = typeof options === 'function' ? options : callback;
    if (typeof done !== 'function') throw new TypeError('lookup_callback_required');
    const answer = { address: String(preferred.address), family: Number(preferred.family) };
    if (lookupOptions.all === true) done(null, [answer]);
    else done(null, answer.address, answer.family);
  };
}

function requestHttps({ url, method, headers, body, addresses, maxResponseBytes = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    const preferred = addresses.find((item) => item.family === 4) || addresses[0];
    const request = https.request(url, {
      method,
      headers,
      agent: false,
      servername: url.hostname,
      lookup: createPinnedLookup(preferred),
      timeout: 12_000,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          const error = new Error('connector_response_too_large');
          response.destroy(error);
          request.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: Number(response.statusCode || 0),
        contentType: String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase(),
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('connector_timeout')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function redactResponse(value, secrets, depth = 0) {
  if (depth > 30) return '[TRUNCATED]';
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) {
      if (secret.length >= 4) result = result.split(secret).join('[REDACTED]');
    }
    return result;
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactResponse(item, secrets, depth + 1));
  if (plainObject(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      result[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redactResponse(item, secrets, depth + 1);
    }
    return result;
  }
  return value;
}

function safeConnector(row) {
  let operations = [];
  try { operations = JSON.parse(row.operations_json); } catch {}
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    authType: row.auth_type,
    authHeader: row.auth_header || null,
    operations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeUpstreamData(rawBody, contentType, secrets) {
  if (!rawBody.length) return null;
  const text = rawBody.toString('utf8');
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new ApiHubError('connector_response_invalid_json', 502); }
    return redactResponse(parsed, secrets);
  }
  if (contentType.startsWith('text/')) return redactResponse(text, secrets);
  throw new ApiHubError('connector_response_type_unsupported', 502);
}

export function createApiHubService({
  db,
  encryptionKey,
  fetchImpl = requestHttps,
  resolveHost = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  now = () => new Date(),
} = {}) {
  if (!db) throw new TypeError('db_required');
  const key = decodeEncryptionKey(encryptionKey);
  const rateWindows = new Map();

  function consumeAgentRateLimit(tokenId) {
    const current = Date.parse(asIso(now()));
    let window = rateWindows.get(tokenId);
    if (!window || current - window.startedAt >= 60_000 || current < window.startedAt) {
      window = { startedAt: current, count: 0 };
      rateWindows.set(tokenId, window);
    }
    if (window.count >= MAX_REQUESTS_PER_MINUTE) throw new ApiHubError('agent_rate_limited', 429);
    window.count += 1;
    if (rateWindows.size > 5000) {
      for (const [id, item] of rateWindows) {
        if (current - item.startedAt > 60_000) rateWindows.delete(id);
      }
    }
  }

  async function listConnectors({ ownerUserId }) {
    const result = await db.execute({
      sql: `SELECT id, name, base_url, auth_type, auth_header,
                   operations_json, created_at, updated_at
            FROM api_hub_connectors WHERE owner_user_id = ? ORDER BY created_at DESC`,
      args: [ownerUserId],
    });
    return result.rows.map(safeConnector);
  }

  async function createConnector({ ownerUserId, input }) {
    const normalized = validateConnectorInput(input);
    const id = crypto.randomUUID();
    const timestamp = asIso(now());
    const encrypted = encryptSecret(JSON.stringify({ authSecret: normalized.authSecret, defaultHeaders: normalized.defaultHeaders }), key);
    try {
      await withWriteTransaction(db, async (tx) => {
        await tx.execute({
          sql: `INSERT INTO api_hub_connectors
                  (id, owner_user_id, name, base_url, auth_type, auth_header,
                   auth_ciphertext, auth_nonce, auth_tag, operations_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
          args: [
            id, ownerUserId, normalized.name, normalized.baseUrl, normalized.authType,
            normalized.authHeader, encrypted.ciphertext, encrypted.nonce, encrypted.tag,
            JSON.stringify(normalized.operations), timestamp, timestamp,
          ],
        });
      });
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message || ''))) throw new ApiHubError('connector_name_exists', 409);
      throw error;
    }
    return (await listConnectors({ ownerUserId })).find((connector) => connector.id === id);
  }

  async function updateConnector({ ownerUserId, connectorId, input }) {
    const existingResult = await db.execute({
      sql: 'SELECT * FROM api_hub_connectors WHERE id = ? AND owner_user_id = ?',
      args: [connectorId, ownerUserId],
    });
    const existing = existingResult.rows[0];
    if (!existing) throw new ApiHubError('connector_not_found', 404);

    let existingAuth;
    try { existingAuth = JSON.parse(decryptSecret(existing, key)); }
    catch (error) {
      if (error instanceof ApiHubError) throw error;
      throw new ApiHubError('connector_secret_unavailable', 503);
    }

    const authType = String(input?.authType ?? existing.auth_type).trim().toLowerCase();
    const submittedSecret = String(input?.authSecret || '');
    let authSecret;
    if (authType === 'none') {
      if (submittedSecret) throw new ApiHubError('connector_auth_secret_invalid');
      authSecret = '';
    } else if (submittedSecret) {
      authSecret = submittedSecret;
    } else if (authType === existing.auth_type && existingAuth.authSecret) {
      // Empty secret means retain the current provider credential; never reveal it to the editor.
      authSecret = existingAuth.authSecret;
    } else {
      throw new ApiHubError('connector_auth_secret_required');
    }

    const defaultHeaders = Object.hasOwn(input || {}, 'defaultHeaders')
      ? input.defaultHeaders
      : existingAuth.defaultHeaders;
    const normalized = validateConnectorInput({ ...input, authType, authSecret, defaultHeaders });
    const encrypted = encryptSecret(JSON.stringify({ authSecret: normalized.authSecret, defaultHeaders: normalized.defaultHeaders }), key);
    const timestamp = asIso(now());
    try {
      const result = await db.execute({
        sql: `UPDATE api_hub_connectors
              SET name = ?, base_url = ?, auth_type = ?, auth_header = ?,
                  auth_ciphertext = ?, auth_nonce = ?, auth_tag = ?, operations_json = ?, updated_at = ?
              WHERE id = ? AND owner_user_id = ?`,
        args: [
          normalized.name, normalized.baseUrl, normalized.authType, normalized.authHeader,
          encrypted.ciphertext, encrypted.nonce, encrypted.tag, JSON.stringify(normalized.operations),
          timestamp, connectorId, ownerUserId,
        ],
      });
      if (Number(result.rowsAffected || 0) !== 1) throw new ApiHubError('connector_not_found', 404);
    } catch (error) {
      if (error instanceof ApiHubError) throw error;
      if (/UNIQUE constraint failed/i.test(String(error?.message || ''))) throw new ApiHubError('connector_name_exists', 409);
      throw error;
    }
    return (await listConnectors({ ownerUserId })).find((connector) => connector.id === connectorId);
  }

  async function deleteConnector({ ownerUserId, connectorId }) {
    const result = await db.execute({
      sql: 'DELETE FROM api_hub_connectors WHERE id = ? AND owner_user_id = ?',
      args: [connectorId, ownerUserId],
    });
    if (Number(result.rowsAffected || 0) !== 1) throw new ApiHubError('connector_not_found', 404);
    return { deleted: true };
  }

  async function listTokens({ ownerUserId }) {
    const result = await db.execute({
      sql: `SELECT id, label, scopes_json, created_at, expires_at, last_used_at, revoked_at
            FROM api_hub_access_tokens WHERE owner_user_id = ? ORDER BY created_at DESC`,
      args: [ownerUserId],
    });
    return result.rows.map((row) => ({
      id: row.id,
      label: row.label,
      scopes: JSON.parse(row.scopes_json),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at || null,
      revokedAt: row.revoked_at || null,
    }));
  }

  async function listAudit({ ownerUserId, limit = 50 }) {
    const count = Math.max(1, Math.min(100, Number(limit) || 50));
    const result = await db.execute({
      sql: `SELECT id, connector_id, access_token_id, operation_name, method,
                   upstream_status, outcome, created_at
            FROM api_hub_audit_events WHERE owner_user_id = ?
            ORDER BY created_at DESC LIMIT ?`,
      args: [ownerUserId, count],
    });
    return result.rows.map((row) => ({
      id: row.id,
      connectorId: row.connector_id,
      accessTokenId: row.access_token_id,
      operation: row.operation_name,
      method: row.method,
      upstreamStatus: row.upstream_status == null ? null : Number(row.upstream_status),
      outcome: row.outcome,
      createdAt: row.created_at,
    }));
  }

  async function createAccessToken({ ownerUserId, label: rawLabel, scopes: rawScopes, expiresInDays = 30 }) {
    const label = String(rawLabel || '').trim();
    const days = Number(expiresInDays);
    if (!label || label.length > 80 || /[\r\n\0]/.test(label)) throw new ApiHubError('token_label_invalid');
    if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) throw new ApiHubError('token_expiry_invalid');
    if (!Array.isArray(rawScopes) || rawScopes.length < 1 || rawScopes.length > 100) throw new ApiHubError('token_scopes_invalid');
    const scopes = [...new Set(rawScopes.map((scope) => String(scope || '').trim()))];
    if (scopes.length !== rawScopes.length || scopes.some((scope) => !/^[0-9a-f-]{36}:[a-z][a-z0-9_-]{0,63}$/.test(scope))) {
      throw new ApiHubError('token_scopes_invalid');
    }

    const connectors = await listConnectors({ ownerUserId });
    const available = new Set(connectors.flatMap((connector) => connector.operations.map((operation) => `${connector.id}:${operation.name}`)));
    if (scopes.some((scope) => !available.has(scope))) throw new ApiHubError('token_scope_not_found', 400);

    const rawToken = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const id = crypto.randomUUID();
    const createdAt = asIso(now());
    const expiresAt = new Date(Date.parse(createdAt) + days * 24 * 60 * 60 * 1000).toISOString();
    await withWriteTransaction(db, async (tx) => {
      await tx.execute({
        sql: `INSERT INTO api_hub_access_tokens
                (id, owner_user_id, label, token_hash, scopes_json, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, ownerUserId, label, sha256(rawToken), JSON.stringify(scopes), createdAt, expiresAt],
      });
    });
    return { id, label, scopes, createdAt, expiresAt, token: rawToken };
  }

  async function revokeAccessToken({ ownerUserId, tokenId }) {
    const revokedAt = asIso(now());
    const result = await db.execute({
      sql: `UPDATE api_hub_access_tokens SET revoked_at = ?
            WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      args: [revokedAt, tokenId, ownerUserId],
    });
    if (Number(result.rowsAffected || 0) !== 1) throw new ApiHubError('token_not_found', 404);
    return { revoked: true };
  }

  async function findAccessToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (!new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`).test(token)) throw new ApiHubError('agent_token_invalid', 401);
    const checkedAt = asIso(now());
    const result = await db.execute({
      sql: `SELECT id, owner_user_id, scopes_json, expires_at, revoked_at
            FROM api_hub_access_tokens WHERE token_hash = ?`,
      args: [sha256(token)],
    });
    const row = result.rows[0];
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.parse(checkedAt)) {
      throw new ApiHubError('agent_token_invalid', 401);
    }
    return { ...row, scopes: JSON.parse(row.scopes_json) };
  }

  async function audit({ ownerUserId, connectorId, tokenId, operationName, method, status, outcome }) {
    await db.execute({
      sql: `INSERT INTO api_hub_audit_events
              (id, owner_user_id, connector_id, access_token_id, operation_name, method,
               upstream_status, outcome, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [crypto.randomUUID(), ownerUserId, connectorId, tokenId, operationName, method, status, outcome, asIso(now())],
    });
  }

  async function listManifest({ token: rawToken }) {
    const token = await findAccessToken(rawToken);
    consumeAgentRateLimit(token.id);
    const connectors = await listConnectors({ ownerUserId: token.owner_user_id });
    const allowed = new Set(token.scopes);
    const manifest = connectors.map((connector) => ({
      id: connector.id,
      name: connector.name,
      operations: connector.operations
        .filter((operation) => allowed.has(`${connector.id}:${operation.name}`))
        .map(({ name, method, path, description }) => ({ name, method, path, description })),
    })).filter((connector) => connector.operations.length);
    return { service: 'keus-api-hub', version: '1', connectors: manifest };
  }

  async function invoke({
    token: rawToken,
    connectorId,
    operationName: requestedOperationName,
    operation: requestedOperation,
    pathParams = {},
    query = {},
    body,
    confirmWrite = false,
  }) {
    const operationName = String(requestedOperationName || requestedOperation || '').trim();
    const token = await findAccessToken(rawToken);
    consumeAgentRateLimit(token.id);
    const connectorResult = await db.execute({
      sql: `SELECT * FROM api_hub_connectors WHERE id = ? AND owner_user_id = ?`,
      args: [String(connectorId || ''), token.owner_user_id],
    });
    const connector = connectorResult.rows[0];
    if (!connector) throw new ApiHubError('connector_not_found', 404);
    let operations;
    try { operations = JSON.parse(connector.operations_json); } catch { throw new ApiHubError('connector_unavailable', 503); }
    const operation = operations.find((candidate) => candidate.name === operationName);
    if (!operation) throw new ApiHubError('operation_not_found', 404);
    const scope = `${connector.id}:${operation.name}`;
    if (!token.scopes.includes(scope)) throw new ApiHubError('agent_scope_denied', 403);
    const isWrite = !['GET', 'HEAD'].includes(operation.method);
    if (isWrite && confirmWrite !== true) throw new ApiHubError('write_confirmation_required', 409);
    if (isWrite && (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > MAX_REQUEST_BYTES)) {
      throw new ApiHubError('invoke_body_too_large', 413);
    }
    if (!isWrite && body !== undefined) throw new ApiHubError('invoke_body_not_allowed', 400);

    const timestamp = asIso(now());
    await db.execute({
      sql: 'UPDATE api_hub_access_tokens SET last_used_at = ? WHERE id = ?',
      args: [timestamp, token.id],
    });

    let upstreamStatus = null;
    let outcome = 'error';
    try {
      const baseUrl = normalizeBaseUrl(connector.base_url);
      const url = buildOperationUrl(baseUrl, operation, pathParams, query);
      const addresses = await resolvePublicAddresses(url.hostname, resolveHost);
      let authConfig;
      try { authConfig = JSON.parse(decryptSecret(connector, key)); } catch (error) {
        if (error instanceof ApiHubError) throw error;
        throw new ApiHubError('connector_secret_unavailable', 503);
      }
      const authSecret = String(authConfig.authSecret || '');
      const defaultHeaders = validateDefaultHeaders(authConfig.defaultHeaders || {});
      const headers = {
        'user-agent': 'Keus-API-Hub/1.0',
        accept: 'application/json, text/plain;q=0.9',
        'accept-encoding': 'identity',
        ...defaultHeaders,
      };
      if (connector.auth_type === 'bearer') headers.authorization = `Bearer ${authSecret}`;
      else if (connector.auth_type === 'header') headers[connector.auth_header.toLowerCase()] = authSecret;

      let requestBody;
      if (body !== undefined) {
        requestBody = Buffer.from(JSON.stringify(body), 'utf8');
        if (requestBody.length > MAX_REQUEST_BYTES) throw new ApiHubError('invoke_body_too_large', 413);
        headers['content-type'] = 'application/json';
      }
      const upstream = await fetchImpl({ url, method: operation.method, headers, body: requestBody, addresses, maxResponseBytes: MAX_RESPONSE_BYTES });
      upstreamStatus = upstream.status;
      if (upstream.status >= 300 && upstream.status < 400) throw new ApiHubError('connector_redirect_blocked', 502);
      const data = sanitizeUpstreamData(upstream.body, upstream.contentType, [authSecret]);
      outcome = upstream.status >= 200 && upstream.status < 300 ? 'success' : 'upstream_error';
      let auditLogged = true;
      try {
        await audit({
          ownerUserId: token.owner_user_id, connectorId: connector.id, tokenId: token.id,
          operationName: operation.name, method: operation.method, status: upstreamStatus, outcome,
        });
      } catch {
        // Do not turn a completed provider write into a retry-looking failure if audit storage is briefly unavailable.
        auditLogged = false;
      }
      return { connectorId: connector.id, operation: operation.name, upstreamStatus: upstream.status, data, auditLogged };
    } catch (error) {
      if (error instanceof ApiHubError) {
        outcome = error.code === 'connector_destination_blocked' || error.code === 'write_confirmation_required'
          ? 'blocked' : 'error';
        try {
          await audit({
            ownerUserId: token.owner_user_id, connectorId: connector.id, tokenId: token.id,
            operationName: operation.name, method: operation.method, status: upstreamStatus, outcome,
          });
        } catch {}
        throw error;
      }
      try {
        await audit({
          ownerUserId: token.owner_user_id, connectorId: connector.id, tokenId: token.id,
          operationName: operation.name, method: operation.method, status: upstreamStatus, outcome: 'error',
        });
      } catch {}
      throw new ApiHubError(error?.message === 'connector_response_too_large'
        ? 'connector_response_too_large' : 'connector_request_failed', 502);
    }
  }

  return Object.freeze({
    listConnectors,
    createConnector,
    updateConnector,
    deleteConnector,
    listTokens,
    listAudit,
    createAccessToken,
    revokeAccessToken,
    listManifest,
    invoke,
  });
}
