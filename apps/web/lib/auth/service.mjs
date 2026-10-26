import crypto from 'node:crypto';
import { withWriteTransaction } from '../db/transaction.mjs';

const EMAIL_LINK_TTL_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_EMAIL_LINKS_PER_HOUR = 5;
const MAX_WORKOS_CODES_PER_MINUTE = 3;
const MAX_WORKOS_CODES_PER_HOUR = 5;

export class AuthError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().normalize('NFKC').toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('invalid_email', 400);
  }
  return email;
}

function validateMagicToken(value) {
  const token = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthError('invalid_or_expired_link', 400);
  return token;
}

function asIso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid_now_timestamp');
  return date.toISOString();
}

function userView(row) {
  return { id: row.id, email: row.email_normalized, displayName: row.display_name };
}

export function createAuthService({ db, emailDelivery = null } = {}) {
  if (!db) throw new TypeError('db_required');

  async function requestEmailMagicLink({ email: rawEmail, now = new Date().toISOString() }) {
    const email = normalizeEmail(rawEmail);
    const issuedAt = asIso(now);
    if (!emailDelivery || typeof emailDelivery.sendMagicLink !== 'function') {
      throw new AuthError('email_delivery_not_configured', 503);
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const challengeHash = sha256(rawToken);
    const challengeId = crypto.randomUUID();
    const expiresAt = new Date(Date.parse(issuedAt) + EMAIL_LINK_TTL_SECONDS * 1000).toISOString();

    await withWriteTransaction(db, async (tx) => {
      const recent = await tx.execute({
        sql: `SELECT COUNT(*) AS count FROM auth_challenges
              WHERE purpose = 'email_magic_link' AND identifier = ? AND created_at >= ?`,
        args: [email, new Date(Date.parse(issuedAt) - 60 * 60 * 1000).toISOString()],
      });
      if (Number(recent.rows[0]?.count || 0) >= MAX_EMAIL_LINKS_PER_HOUR) {
        throw new AuthError('too_many_sign_in_requests', 429);
      }
      await tx.execute({
        sql: `INSERT INTO auth_challenges
                (id, purpose, identifier, challenge_hash, expires_at, created_at)
              VALUES (?, 'email_magic_link', ?, ?, ?, ?)`,
        args: [challengeId, email, challengeHash, expiresAt, issuedAt],
      });
    });

    try {
      await emailDelivery.sendMagicLink({ email, token: rawToken, expiresAt });
    } catch {
      // The provider may have accepted the message before an error surfaced; invalidate the link.
      await withWriteTransaction(db, async (tx) => {
        await tx.execute({
          sql: `UPDATE auth_challenges SET consumed_at = ?
                WHERE id = ? AND consumed_at IS NULL`,
          args: [issuedAt, challengeId],
        });
      });
      throw new AuthError('email_delivery_failed', 503);
    }

    // Never return or log the bearer token from this service.
    return { accepted: true, expiresAt };
  }

  async function consumeEmailMagicLink({ token: rawToken, now = new Date().toISOString() }) {
    const token = validateMagicToken(rawToken);
    const consumedAt = asIso(now);
    const challengeHash = sha256(token);

    return withWriteTransaction(db, async (tx) => {
      const found = await tx.execute({
        sql: `SELECT id, identifier, expires_at, consumed_at
              FROM auth_challenges
              WHERE purpose = 'email_magic_link' AND challenge_hash = ?`,
        args: [challengeHash],
      });
      if (!found.rows.length) throw new AuthError('invalid_or_expired_link', 400);
      const challenge = found.rows[0];
      if (challenge.consumed_at) throw new AuthError('link_already_used', 409);
      if (Date.parse(challenge.expires_at) <= Date.parse(consumedAt)) {
        throw new AuthError('invalid_or_expired_link', 400);
      }

      const consume = await tx.execute({
        sql: `UPDATE auth_challenges SET consumed_at = ?
              WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
        args: [consumedAt, challenge.id, consumedAt],
      });
      if (Number(consume.rowsAffected) !== 1) throw new AuthError('link_already_used', 409);

      let userResult = await tx.execute({
        sql: 'SELECT id, email_normalized, display_name, status FROM users WHERE email_normalized = ?',
        args: [challenge.identifier],
      });
      let user = userResult.rows[0];
      if (!user) {
        const userId = crypto.randomUUID();
        await tx.execute({
          sql: `INSERT INTO users(id, email_normalized, display_name, created_at, updated_at)
                VALUES (?, ?, '', ?, ?)`,
          args: [userId, challenge.identifier, consumedAt, consumedAt],
        });
        user = { id: userId, email_normalized: challenge.identifier, display_name: '', status: 'active' };
      }
      if (user.status !== 'active') throw new AuthError('account_unavailable', 403);

      const identityResult = await tx.execute({
        sql: `SELECT user_id FROM auth_identities
              WHERE provider = 'email_magic_link' AND provider_subject = ?`,
        args: [challenge.identifier],
      });
      if (identityResult.rows.length && identityResult.rows[0].user_id !== user.id) {
        throw new AuthError('identity_link_conflict', 409);
      }
      if (!identityResult.rows.length) {
        await tx.execute({
          sql: `INSERT INTO auth_identities(id, user_id, provider, provider_subject, email_at_provider, created_at, last_used_at)
                VALUES (?, ?, 'email_magic_link', ?, ?, ?, ?)`,
          args: [crypto.randomUUID(), user.id, challenge.identifier, challenge.identifier, consumedAt, consumedAt],
        });
      } else {
        await tx.execute({
          sql: `UPDATE auth_identities SET last_used_at = ?
                WHERE provider = 'email_magic_link' AND provider_subject = ?`,
          args: [consumedAt, challenge.identifier],
        });
      }

      const sessionToken = crypto.randomBytes(32).toString('base64url');
      const sessionId = crypto.randomUUID();
      const sessionExpiresAt = new Date(Date.parse(consumedAt) + SESSION_TTL_SECONDS * 1000).toISOString();
      await tx.execute({
        sql: `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [sessionId, user.id, sha256(sessionToken), sessionExpiresAt, consumedAt, consumedAt],
      });

      return {
        user: userView(user),
        sessionToken,
        sessionId,
        sessionExpiresAt,
      };
    });
  }

  /** Reserve a rate-limited WorkOS Magic Auth send without persisting the one-time code. */
  async function reserveWorkOSCodeRequest({ email: rawEmail, now = new Date().toISOString() }) {
    const email = normalizeEmail(rawEmail);
    const requestedAt = asIso(now);
    const expiresAt = new Date(Date.parse(requestedAt) + 10 * 60 * 1000).toISOString();
    const requestId = crypto.randomUUID();
    const requestHash = sha256(crypto.randomBytes(32).toString('base64url'));

    await withWriteTransaction(db, async (tx) => {
      await tx.execute({
        sql: `DELETE FROM auth_challenges
              WHERE purpose = 'workos_email_code' AND created_at < ?`,
        args: [new Date(Date.parse(requestedAt) - 24 * 60 * 60 * 1000).toISOString()],
      });
      const counts = await tx.execute({
        sql: `SELECT
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS minute_count,
                COUNT(*) AS hour_count
              FROM auth_challenges
              WHERE purpose = 'workos_email_code' AND identifier = ? AND created_at >= ?`,
        args: [
          new Date(Date.parse(requestedAt) - 60 * 1000).toISOString(),
          email,
          new Date(Date.parse(requestedAt) - 60 * 60 * 1000).toISOString(),
        ],
      });
      if (Number(counts.rows[0]?.minute_count || 0) >= MAX_WORKOS_CODES_PER_MINUTE
          || Number(counts.rows[0]?.hour_count || 0) >= MAX_WORKOS_CODES_PER_HOUR) {
        throw new AuthError('too_many_sign_in_requests', 429);
      }
      await tx.execute({
        sql: `INSERT INTO auth_challenges
                (id, purpose, identifier, challenge_hash, expires_at, created_at)
              VALUES (?, 'workos_email_code', ?, ?, ?, ?)`,
        args: [requestId, email, requestHash, expiresAt, requestedAt],
      });
    });

    return { email, expiresAt };
  }

  /** Link a verified WorkOS identity to the existing Keus user record and issue a Keus session. */
  async function createWorkOSSession({
    providerSubject,
    email: rawEmail,
    emailVerified,
    displayName = '',
    now = new Date().toISOString(),
  }) {
    const subject = String(providerSubject || '').trim();
    if (!subject || subject.length > 255) throw new AuthError('invalid_identity', 400);
    if (emailVerified !== true) throw new AuthError('email_not_verified', 403);
    const email = normalizeEmail(rawEmail);
    const name = String(displayName || '').trim().slice(0, 120);
    const createdAt = asIso(now);

    return withWriteTransaction(db, async (tx) => {
      const linked = await tx.execute({
        sql: `SELECT users.id, users.email_normalized, users.display_name, users.status
              FROM auth_identities JOIN users ON users.id = auth_identities.user_id
              WHERE auth_identities.provider = 'workos'
                AND auth_identities.provider_subject = ?`,
        args: [subject],
      });

      let user = linked.rows[0];
      let isNewUser = false;
      if (!user) {
        const existing = await tx.execute({
          sql: 'SELECT id, email_normalized, display_name, status FROM users WHERE email_normalized = ?',
          args: [email],
        });
        user = existing.rows[0];
        if (!user) {
          const userId = crypto.randomUUID();
          await tx.execute({
            sql: `INSERT INTO users(id, email_normalized, display_name, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?)`,
            args: [userId, email, name, createdAt, createdAt],
          });
          user = {
            id: userId,
            email_normalized: email,
            display_name: name,
            status: 'active',
          };
          isNewUser = true;
        }

        if (user.status !== 'active') throw new AuthError('account_unavailable', 403);
        await tx.execute({
          sql: `INSERT INTO auth_identities
                  (id, user_id, provider, provider_subject, email_at_provider, created_at, last_used_at)
                VALUES (?, ?, 'workos', ?, ?, ?, ?)`,
          args: [crypto.randomUUID(), user.id, subject, email, createdAt, createdAt],
        });
      } else {
        if (user.status !== 'active') throw new AuthError('account_unavailable', 403);
        await tx.execute({
          sql: `UPDATE auth_identities SET email_at_provider = ?, last_used_at = ?
                WHERE provider = 'workos' AND provider_subject = ?`,
          args: [email, createdAt, subject],
        });
      }

      const sessionToken = crypto.randomBytes(32).toString('base64url');
      const sessionId = crypto.randomUUID();
      const sessionExpiresAt = new Date(Date.parse(createdAt) + SESSION_TTL_SECONDS * 1000).toISOString();
      await tx.execute({
        sql: `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [sessionId, user.id, sha256(sessionToken), sessionExpiresAt, createdAt, createdAt],
      });

      return {
        user: userView(user),
        sessionToken,
        sessionId,
        sessionExpiresAt,
        isNewUser,
      };
    });
  }

  async function getSession({ token, now = new Date().toISOString() }) {
    const sessionToken = String(token || '').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
    const checkedAt = asIso(now);
    const result = await db.execute({
      sql: `SELECT users.id, users.email_normalized, users.display_name, sessions.id AS session_id
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL
              AND sessions.expires_at > ? AND users.status = 'active'`,
      args: [sha256(sessionToken), checkedAt],
    });
    const row = result.rows[0];
    if (!row) return null;
    await db.execute({
      sql: 'UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL',
      args: [checkedAt, row.session_id],
    });
    return userView(row);
  }

  async function revokeSession({ token, now = new Date().toISOString() }) {
    const sessionToken = String(token || '').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return { revoked: false };
    const revokedAt = asIso(now);
    const result = await db.execute({
      sql: `UPDATE sessions SET revoked_at = ?
            WHERE token_hash = ? AND revoked_at IS NULL`,
      args: [revokedAt, sha256(sessionToken)],
    });
    return { revoked: Number(result.rowsAffected) === 1 };
  }

  return Object.freeze({
    requestEmailMagicLink,
    consumeEmailMagicLink,
    reserveWorkOSCodeRequest,
    createWorkOSSession,
    getSession,
    revokeSession,
  });
}
