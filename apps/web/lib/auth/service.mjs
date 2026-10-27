import crypto from 'node:crypto';
import { withWriteTransaction } from '../db/transaction.mjs';
import { ensureDefaultWorkspaceInTransaction } from '../workspaces/service.mjs';

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

function normalizeDisplayName(value) {
  const displayName = String(value ?? '').trim().normalize('NFKC');
  if (!displayName || displayName.length > 120 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(displayName)) {
    throw new AuthError('invalid_display_name', 400);
  }
  return displayName;
}

function normalizeTheme(value) {
  const theme = String(value || '').trim().toLowerCase();
  if (!['dark', 'light'].includes(theme)) throw new AuthError('invalid_theme', 400);
  return theme;
}

function normalizedUserId(value) {
  const userId = String(value || '').trim();
  if (!userId || userId.length > 255) throw new AuthError('account_unavailable', 403);
  return userId;
}

function hashSessionToken(value) {
  const token = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthError('authentication_required', 401);
  return sha256(token);
}

function userView(row) {
  return {
    id: row.id,
    email: row.email_normalized,
    displayName: row.display_name,
    theme: row.theme === 'light' ? 'light' : 'dark',
  };
}

export function createAuthService({ db, emailDelivery = null, competition = null } = {}) {
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
      let isNewUser = false;
      if (!user) {
        const userId = crypto.randomUUID();
        await tx.execute({
          sql: `INSERT INTO users(id, email_normalized, display_name, created_at, updated_at)
                VALUES (?, ?, '', ?, ?)`,
          args: [userId, challenge.identifier, consumedAt, consumedAt],
        });
        user = { id: userId, email_normalized: challenge.identifier, display_name: '', status: 'active' };
        isNewUser = true;
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

      const provisioned = await ensureDefaultWorkspaceInTransaction(tx, {
        userId: user.id,
        displayName: user.display_name,
        now: consumedAt,
        competition,
      });
      const onboardingResult = await tx.execute({
        sql: 'SELECT status FROM workspace_onboarding WHERE workspace_id = ?',
        args: [provisioned.workspace.id],
      });
      const needsOnboarding = onboardingResult.rows[0]?.status !== 'completed';

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
        isNewUser,
        needsOnboarding,
      };
    });
  }

  /** Rate-limit WorkOS verification-code and password-reset email requests without storing secrets. */
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
        sql: `SELECT users.id, users.email_normalized, users.display_name, users.status,
                     user_preferences.theme
              FROM auth_identities JOIN users ON users.id = auth_identities.user_id
              LEFT JOIN user_preferences ON user_preferences.user_id = users.id
              WHERE auth_identities.provider = 'workos'
                AND auth_identities.provider_subject = ?`,
        args: [subject],
      });

      let user = linked.rows[0];
      let isNewUser = false;
      if (!user) {
        const existing = await tx.execute({
          sql: `SELECT users.id, users.email_normalized, users.display_name, users.status,
                       user_preferences.theme
                FROM users LEFT JOIN user_preferences ON user_preferences.user_id = users.id
                WHERE users.email_normalized = ?`,
          args: [email],
        });
        user = existing.rows[0];
        const reservedEmail = await tx.execute({
          sql: `SELECT user_id FROM pending_email_changes
                WHERE new_email = ? AND expires_at > ? LIMIT 1`,
          args: [email, createdAt],
        });
        if (reservedEmail.rows.length && reservedEmail.rows[0].user_id !== user?.id) {
          throw new AuthError('email_unavailable', 409);
        }
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
            theme: 'dark',
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
        if (normalizeEmail(user.email_normalized) !== email) {
          const emailOwner = await tx.execute({
            sql: 'SELECT id FROM users WHERE email_normalized = ? AND id <> ? LIMIT 1',
            args: [email, user.id],
          });
          if (emailOwner.rows.length) throw new AuthError('email_unavailable', 409);
          const reservedEmail = await tx.execute({
            sql: `SELECT user_id FROM pending_email_changes
                  WHERE new_email = ? AND user_id <> ? AND expires_at > ? LIMIT 1`,
            args: [email, user.id, createdAt],
          });
          if (reservedEmail.rows.length) throw new AuthError('email_unavailable', 409);
          await tx.execute({
            sql: 'UPDATE users SET email_normalized = ?, updated_at = ? WHERE id = ?',
            args: [email, createdAt, user.id],
          });
          user = { ...user, email_normalized: email };
        }
        await tx.execute({
          sql: `UPDATE auth_identities SET email_at_provider = ?, last_used_at = ?
                WHERE provider = 'workos' AND provider_subject = ?`,
          args: [email, createdAt, subject],
        });
      }

      await tx.execute({
        sql: `INSERT INTO user_preferences(user_id, theme, updated_at)
              VALUES (?, 'dark', ?)
              ON CONFLICT(user_id) DO NOTHING`,
        args: [user.id, createdAt],
      });
      if (!String(user.display_name || '').trim() && name) {
        await tx.execute({
          sql: 'UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?',
          args: [name, createdAt, user.id],
        });
        user = { ...user, display_name: name };
      }
      const provisioned = await ensureDefaultWorkspaceInTransaction(tx, {
        userId: user.id,
        displayName: user.display_name || name,
        now: createdAt,
        competition,
      });
      const onboardingResult = await tx.execute({
        sql: 'SELECT status FROM workspace_onboarding WHERE workspace_id = ?',
        args: [provisioned.workspace.id],
      });
      const needsOnboarding = onboardingResult.rows[0]?.status !== 'completed';

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
        needsOnboarding,
      };
    });
  }

  async function getWorkOSIdentity({ userId: rawUserId } = {}) {
    const userId = normalizedUserId(rawUserId);
    const result = await db.execute({
      sql: `SELECT provider_subject FROM auth_identities
            WHERE user_id = ? AND provider = 'workos' LIMIT 1`,
      args: [userId],
    });
    const providerSubject = result.rows[0]?.provider_subject;
    if (!providerSubject) throw new AuthError('workos_identity_required', 409);
    return { providerSubject };
  }

  async function updateDisplayName({ userId: rawUserId, displayName: rawDisplayName, now = new Date().toISOString() } = {}) {
    const userId = normalizedUserId(rawUserId);
    const displayName = normalizeDisplayName(rawDisplayName);
    const updatedAt = asIso(now);
    return withWriteTransaction(db, async (tx) => {
      const updated = await tx.execute({
        sql: `UPDATE users SET display_name = ?, updated_at = ?
              WHERE id = ? AND status = 'active'`,
        args: [displayName, updatedAt, userId],
      });
      if (Number(updated.rowsAffected) !== 1) throw new AuthError('account_unavailable', 403);
      const result = await tx.execute({
        sql: `SELECT users.id, users.email_normalized, users.display_name, user_preferences.theme
              FROM users LEFT JOIN user_preferences ON user_preferences.user_id = users.id
              WHERE users.id = ?`,
        args: [userId],
      });
      return userView(result.rows[0]);
    });
  }

  async function updateTheme({ userId: rawUserId, theme: rawTheme, now = new Date().toISOString() } = {}) {
    const userId = normalizedUserId(rawUserId);
    const theme = normalizeTheme(rawTheme);
    const updatedAt = asIso(now);
    return withWriteTransaction(db, async (tx) => {
      const activeUser = await tx.execute({
        sql: "SELECT id FROM users WHERE id = ? AND status = 'active'",
        args: [userId],
      });
      if (!activeUser.rows.length) throw new AuthError('account_unavailable', 403);
      await tx.execute({
        sql: `INSERT INTO user_preferences(user_id, theme, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, updated_at = excluded.updated_at`,
        args: [userId, theme, updatedAt],
      });
      return { theme };
    });
  }

  async function reservePendingEmailChange({
    userId: rawUserId,
    newEmail: rawEmail,
    sessionToken,
    now = new Date().toISOString(),
    expiresAt = null,
  } = {}) {
    const userId = normalizedUserId(rawUserId);
    const newEmail = normalizeEmail(rawEmail);
    const sessionTokenHash = hashSessionToken(sessionToken);
    const createdAt = asIso(now);
    const expiry = expiresAt
      ? asIso(expiresAt)
      : new Date(Date.parse(createdAt) + 10 * 60 * 1000).toISOString();
    if (Date.parse(expiry) <= Date.parse(createdAt)) throw new AuthError('email_change_request_expired', 400);
    const requestId = crypto.randomUUID();

    try {
      await withWriteTransaction(db, async (tx) => {
        await tx.execute({
          sql: 'DELETE FROM pending_email_changes WHERE expires_at <= ?',
          args: [createdAt],
        });
        const userResult = await tx.execute({
          sql: `SELECT id, email_normalized, status FROM users WHERE id = ?`,
          args: [userId],
        });
        const user = userResult.rows[0];
        if (!user || user.status !== 'active') throw new AuthError('account_unavailable', 403);
        if (normalizeEmail(user.email_normalized) === newEmail) throw new AuthError('email_unchanged', 400);

        const emailOwner = await tx.execute({
          sql: 'SELECT id FROM users WHERE email_normalized = ? AND id <> ? LIMIT 1',
          args: [newEmail, userId],
        });
        if (emailOwner.rows.length) throw new AuthError('email_unavailable', 409);
        const pendingOwner = await tx.execute({
          sql: 'SELECT user_id FROM pending_email_changes WHERE new_email = ? AND user_id <> ? LIMIT 1',
          args: [newEmail, userId],
        });
        if (pendingOwner.rows.length) throw new AuthError('email_unavailable', 409);

        await tx.execute({
          sql: 'DELETE FROM pending_email_changes WHERE user_id = ?',
          args: [userId],
        });
        await tx.execute({
          sql: `INSERT INTO pending_email_changes
                  (id, user_id, new_email, session_token_hash, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [requestId, userId, newEmail, sessionTokenHash, expiry, createdAt],
        });
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (/UNIQUE constraint failed: pending_email_changes\.(new_email|user_id)/i.test(String(error?.message || error))) {
        throw new AuthError('email_unavailable', 409);
      }
      throw error;
    }
    return { newEmail, expiresAt: expiry };
  }

  async function setPendingEmailChangeExpiry({ userId: rawUserId, sessionToken, expiresAt, now = new Date().toISOString() } = {}) {
    const userId = normalizedUserId(rawUserId);
    const sessionTokenHash = hashSessionToken(sessionToken);
    const expiry = asIso(expiresAt);
    const checkedAt = asIso(now);
    if (Date.parse(expiry) <= Date.parse(checkedAt)) throw new AuthError('email_change_request_expired', 400);
    const result = await db.execute({
      sql: `UPDATE pending_email_changes SET expires_at = ?
            WHERE user_id = ? AND session_token_hash = ? AND expires_at > ?`,
      args: [expiry, userId, sessionTokenHash, checkedAt],
    });
    if (Number(result.rowsAffected) !== 1) throw new AuthError('email_change_request_expired', 400);
    return { expiresAt: expiry };
  }

  async function cancelPendingEmailChange({ userId: rawUserId, sessionToken, now = new Date().toISOString() } = {}) {
    const userId = normalizedUserId(rawUserId);
    const sessionTokenHash = hashSessionToken(sessionToken);
    await db.execute({
      sql: 'DELETE FROM pending_email_changes WHERE user_id = ? AND session_token_hash = ?',
      args: [userId, sessionTokenHash],
    });
    return { cancelled: true };
  }

  async function getPendingEmailChange({ userId: rawUserId, sessionToken, now = new Date().toISOString() } = {}) {
    const userId = normalizedUserId(rawUserId);
    const sessionTokenHash = hashSessionToken(sessionToken);
    const checkedAt = asIso(now);
    const result = await db.execute({
      sql: `SELECT id, new_email, expires_at, failed_attempts
            FROM pending_email_changes
            WHERE user_id = ? AND session_token_hash = ? LIMIT 1`,
      args: [userId, sessionTokenHash],
    });
    const pending = result.rows[0];
    if (!pending) return null;
    if (Date.parse(pending.expires_at) <= Date.parse(checkedAt)) {
      await db.execute({
        sql: 'DELETE FROM pending_email_changes WHERE id = ? AND session_token_hash = ?',
        args: [pending.id, sessionTokenHash],
      });
      return null;
    }
    return {
      newEmail: pending.new_email,
      expiresAt: pending.expires_at,
      failedAttempts: Number(pending.failed_attempts || 0),
    };
  }

  async function recordPendingEmailChangeFailure({ userId: rawUserId, sessionToken, now = new Date().toISOString() } = {}) {
    const userId = normalizedUserId(rawUserId);
    const sessionTokenHash = hashSessionToken(sessionToken);
    const checkedAt = asIso(now);
    return withWriteTransaction(db, async (tx) => {
      const found = await tx.execute({
        sql: `SELECT id, failed_attempts FROM pending_email_changes
              WHERE user_id = ? AND session_token_hash = ? AND expires_at > ? LIMIT 1`,
        args: [userId, sessionTokenHash, checkedAt],
      });
      const row = found.rows[0];
      if (!row) return { attempts: 0, locked: true };
      const attempts = Number(row.failed_attempts || 0) + 1;
      if (attempts >= 5) {
        await tx.execute({
          sql: 'DELETE FROM pending_email_changes WHERE id = ? AND session_token_hash = ?',
          args: [row.id, sessionTokenHash],
        });
      } else {
        await tx.execute({
          sql: 'UPDATE pending_email_changes SET failed_attempts = ? WHERE id = ?',
          args: [attempts, row.id],
        });
      }
      return { attempts, locked: attempts >= 5 };
    });
  }

  async function completePendingEmailChange({
    userId: rawUserId,
    providerSubject: rawSubject,
    newEmail: rawEmail,
    sessionToken,
    now = new Date().toISOString(),
  } = {}) {
    const userId = normalizedUserId(rawUserId);
    const subject = String(rawSubject || '').trim();
    if (!subject || subject.length > 255) throw new AuthError('workos_identity_required', 409);
    const newEmail = normalizeEmail(rawEmail);
    const sessionTokenHash = hashSessionToken(sessionToken);
    const updatedAt = asIso(now);

    return withWriteTransaction(db, async (tx) => {
      const pendingResult = await tx.execute({
        sql: `SELECT id, new_email, expires_at FROM pending_email_changes
              WHERE user_id = ? AND session_token_hash = ? LIMIT 1`,
        args: [userId, sessionTokenHash],
      });
      const pending = pendingResult.rows[0];
      if (!pending || pending.new_email !== newEmail || Date.parse(pending.expires_at) <= Date.parse(updatedAt)) {
        if (pending && Date.parse(pending.expires_at) <= Date.parse(updatedAt)) {
          await tx.execute({ sql: 'DELETE FROM pending_email_changes WHERE id = ?', args: [pending.id] });
        }
        throw new AuthError('invalid_email_change_code', 400);
      }
      const userResult = await tx.execute({
        sql: `SELECT id, email_normalized, display_name, status FROM users WHERE id = ?`,
        args: [userId],
      });
      const user = userResult.rows[0];
      if (!user || user.status !== 'active') throw new AuthError('account_unavailable', 403);
      const identity = await tx.execute({
        sql: `SELECT id FROM auth_identities
              WHERE user_id = ? AND provider = 'workos' AND provider_subject = ? LIMIT 1`,
        args: [userId, subject],
      });
      if (!identity.rows.length) throw new AuthError('workos_identity_required', 409);
      const emailOwner = await tx.execute({
        sql: 'SELECT id FROM users WHERE email_normalized = ? AND id <> ? LIMIT 1',
        args: [newEmail, userId],
      });
      if (emailOwner.rows.length) throw new AuthError('email_unavailable', 409);

      await tx.execute({
        sql: 'UPDATE users SET email_normalized = ?, updated_at = ? WHERE id = ?',
        args: [newEmail, updatedAt, userId],
      });
      await tx.execute({
        sql: `UPDATE auth_identities SET email_at_provider = ?, last_used_at = ?
              WHERE user_id = ? AND provider = 'workos' AND provider_subject = ?`,
        args: [newEmail, updatedAt, userId, subject],
      });
      await tx.execute({
        sql: 'DELETE FROM pending_email_changes WHERE id = ?',
        args: [pending.id],
      });
      const updatedUser = await tx.execute({
        sql: `SELECT users.id, users.email_normalized, users.display_name, user_preferences.theme
              FROM users LEFT JOIN user_preferences ON user_preferences.user_id = users.id
              WHERE users.id = ?`,
        args: [userId],
      });
      return userView(updatedUser.rows[0]);
    });
  }

  async function getSession({ token, now = new Date().toISOString() }) {
    const sessionToken = String(token || '').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
    const checkedAt = asIso(now);
    const result = await db.execute({
      sql: `SELECT users.id, users.email_normalized, users.display_name,
                   user_preferences.theme, sessions.id AS session_id
            FROM sessions JOIN users ON users.id = sessions.user_id
            LEFT JOIN user_preferences ON user_preferences.user_id = users.id
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
    const tokenHash = sha256(sessionToken);
    return withWriteTransaction(db, async (tx) => {
      const result = await tx.execute({
        sql: `UPDATE sessions SET revoked_at = ?
              WHERE token_hash = ? AND revoked_at IS NULL`,
        args: [revokedAt, tokenHash],
      });
      await tx.execute({
        sql: 'DELETE FROM pending_email_changes WHERE session_token_hash = ?',
        args: [tokenHash],
      });
      return { revoked: Number(result.rowsAffected) === 1 };
    });
  }

  return Object.freeze({
    requestEmailMagicLink,
    consumeEmailMagicLink,
    reserveWorkOSCodeRequest,
    createWorkOSSession,
    getWorkOSIdentity,
    updateDisplayName,
    updateTheme,
    reservePendingEmailChange,
    setPendingEmailChangeExpiry,
    cancelPendingEmailChange,
    getPendingEmailChange,
    recordPendingEmailChangeFailure,
    completePendingEmailChange,
    getSession,
    revokeSession,
  });
}
