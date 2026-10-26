import crypto from 'node:crypto';
import { withWriteTransaction } from '../db/transaction.mjs';
import {
  ensureCompetitionEntitlementInTransaction,
  findActiveUsageEntitlement,
  usageAccessView,
} from '../db/entitlements.mjs';

const AVATARS = new Set(['bulb', 'laptop', 'shield', 'cart', 'car', 'parcel', 'magnifier', 'tag', 'wallet', 'van']);
const COLORS = new Set(['#32d583', '#f5b942', '#4c8dff', '#b57cff', '#ff7777']);
const APPROVAL_PATHS = new Set(['desktop', 'keyfob']);
const AGENT_PREFIX = 'onb_';

export class WorkspaceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'WorkspaceError';
    this.code = code;
    this.status = status;
  }
}

function isoNow(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now_must_be_iso_datetime');
  return date.toISOString();
}

function shortHash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function requiredText(value, field, maxLength) {
  const text = String(value ?? '').trim().normalize('NFKC');
  if (!text || text.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new WorkspaceError(`invalid_${field}`, 400);
  }
  return text;
}

function boundedStringArray(value, field, { maxItems = 20, maxLength = 80 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new WorkspaceError(`invalid_${field}`, 400);
  return value.map((entry) => requiredText(entry, field, maxLength));
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function defaultWorkspaceName(displayName) {
  const name = String(displayName || '').trim().normalize('NFKC').slice(0, 80);
  return name ? `${name}'s Keus workspace` : 'My Keus workspace';
}

function onboardingAgentId(workspaceId) {
  return `${AGENT_PREFIX}${shortHash(workspaceId, 32)}`;
}

/**
 * Provision (or repair) the account's one default workspace inside the caller's DB transaction.
 * The deterministic fallback id makes first-login retries idempotent without creating duplicates.
 */
export async function ensureDefaultWorkspaceInTransaction(tx, {
  userId,
  displayName = '',
  now = new Date().toISOString(),
  competition = null,
}) {
  const createdAt = isoNow(now);
  const userResult = await tx.execute({
    sql: `SELECT id, email_normalized, display_name, status FROM users WHERE id = ?`,
    args: [String(userId || '').trim()],
  });
  const user = userResult.rows[0];
  if (!user || user.status !== 'active') throw new WorkspaceError('account_unavailable', 403);

  let workspaceResult = await tx.execute({
    sql: `SELECT w.id, w.owner_user_id, w.name, w.status
          FROM user_default_workspaces d
          JOIN workspaces w ON w.id = d.workspace_id
          WHERE d.user_id = ?`,
    args: [user.id],
  });
  let workspace = workspaceResult.rows[0];

  // Reuse an existing owned workspace if one predates the default-workspace pointer.
  if (!workspace) {
    const legacy = await tx.execute({
      sql: `SELECT id, owner_user_id, name, status
            FROM workspaces WHERE owner_user_id = ?
            ORDER BY created_at ASC, id ASC LIMIT 1`,
      args: [user.id],
    });
    workspace = legacy.rows[0] || null;
  }

  if (!workspace) {
    const id = `ws_${shortHash(user.id, 32)}`;
    await tx.execute({
      sql: `INSERT INTO workspaces(id, owner_user_id, name, status, created_at, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?)
            ON CONFLICT(id) DO NOTHING`,
      args: [id, user.id, defaultWorkspaceName(displayName || user.display_name), createdAt, createdAt],
    });
    const created = await tx.execute({
      sql: `SELECT id, owner_user_id, name, status FROM workspaces WHERE id = ?`,
      args: [id],
    });
    workspace = created.rows[0] || null;
    if (!workspace || workspace.owner_user_id !== user.id) {
      throw new WorkspaceError('default_workspace_provisioning_conflict', 409);
    }
  }

  if (workspace.owner_user_id !== user.id) throw new WorkspaceError('workspace_owner_mismatch', 403);

  await tx.execute({
    sql: `INSERT INTO workspace_members(workspace_id, user_id, role, created_at)
          VALUES (?, ?, 'owner', ?)
          ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'owner'`,
    args: [workspace.id, user.id, createdAt],
  });
  await tx.execute({
    sql: `INSERT INTO user_default_workspaces(user_id, workspace_id, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO NOTHING`,
    args: [user.id, workspace.id, createdAt],
  });

  const pointer = await tx.execute({
    sql: 'SELECT workspace_id FROM user_default_workspaces WHERE user_id = ?',
    args: [user.id],
  });
  const pointerId = pointer.rows[0]?.workspace_id;
  if (!pointerId) throw new WorkspaceError('default_workspace_provisioning_failed', 500);
  if (pointerId !== workspace.id) {
    const selected = await tx.execute({
      sql: `SELECT id, owner_user_id, name, status FROM workspaces WHERE id = ?`,
      args: [pointerId],
    });
    workspace = selected.rows[0] || null;
    if (!workspace || workspace.owner_user_id !== user.id) {
      throw new WorkspaceError('default_workspace_provisioning_conflict', 409);
    }
    await tx.execute({
      sql: `INSERT INTO workspace_members(workspace_id, user_id, role, created_at)
            VALUES (?, ?, 'owner', ?)
            ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'owner'`,
      args: [workspace.id, user.id, createdAt],
    });
  }

  if (workspace.status !== 'active') throw new WorkspaceError('workspace_unavailable', 403);
  await tx.execute({
    sql: `INSERT INTO workspace_onboarding(workspace_id, status, profile_json, created_at, updated_at)
          VALUES (?, 'not_started', '{}', ?, ?)
          ON CONFLICT(workspace_id) DO NOTHING`,
    args: [workspace.id, createdAt, createdAt],
  });
  await ensureCompetitionEntitlementInTransaction(tx, {
    workspaceId: workspace.id,
    competition,
    now: createdAt,
  });

  return { user, workspace };
}

function normalizeOnboardingInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkspaceError('json_object_required', 400);
  }
  const name = requiredText(input.name, 'agent_name', 30);
  const role = requiredText(input.role, 'agent_role', 60);
  const color = String(input.color || '').trim().toLowerCase();
  const avatar = String(input.avatar || '').trim().toLowerCase();
  const approvalPath = String(input.approvalPath || '').trim().toLowerCase();
  if (!COLORS.has(color)) throw new WorkspaceError('invalid_agent_color', 400);
  if (!AVATARS.has(avatar)) throw new WorkspaceError('invalid_agent_avatar', 400);
  if (!APPROVAL_PATHS.has(approvalPath)) throw new WorkspaceError('invalid_approval_path', 400);

  const orderCap = Number(input.orderCap);
  const dailyCap = Number(input.dailyCap);
  if (!Number.isSafeInteger(orderCap) || orderCap < 20 || orderCap > 500) {
    throw new WorkspaceError('invalid_order_cap', 400);
  }
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 100 || dailyCap > 2000 || dailyCap % 25 !== 0) {
    throw new WorkspaceError('invalid_daily_spend_cap', 400);
  }

  return {
    name,
    role,
    color,
    avatar,
    approvalPath,
    orderCap,
    dailyCap,
    apps: boundedStringArray(input.apps, 'apps', { maxItems: 20, maxLength: 64 }),
    memoryPills: boundedStringArray(input.memoryPills, 'memory_pills', { maxItems: 20, maxLength: 80 }),
  };
}

async function workspaceBootstrapInTransaction(tx, { userId, now, competition }) {
  const { user, workspace } = await ensureDefaultWorkspaceInTransaction(tx, {
    userId,
    displayName: '',
    now,
    competition,
  });
  const result = await tx.execute({
    sql: `SELECT w.id AS workspace_id, w.name AS workspace_name, w.status AS workspace_status,
                 m.role AS member_role,
                 o.status AS onboarding_status, o.profile_json, o.completed_at,
                 a.id AS agent_id, a.name AS agent_name, a.role AS agent_role,
                 a.avatar AS agent_avatar, a.status AS agent_status, a.settings_json AS agent_settings_json
          FROM user_default_workspaces d
          JOIN workspaces w ON w.id = d.workspace_id
          JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = d.user_id
          LEFT JOIN workspace_onboarding o ON o.workspace_id = w.id
          LEFT JOIN agents a ON a.workspace_id = w.id AND a.id = ?
          WHERE d.user_id = ?`,
    args: [onboardingAgentId(workspace.id), user.id],
  });
  const row = result.rows[0];
  if (!row) throw new WorkspaceError('workspace_access_denied', 403);

  const entitlement = await findActiveUsageEntitlement(tx, {
    workspaceId: row.workspace_id,
    now: isoNow(now),
  });
  const onboardingProfile = parseJson(row.profile_json);
  const settings = parseJson(row.agent_settings_json);
  return {
    user: { id: user.id, email: user.email_normalized, displayName: user.display_name },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      status: row.workspace_status,
      role: row.member_role,
    },
    onboarding: {
      status: row.onboarding_status || 'not_started',
      completedAt: row.completed_at || null,
      profile: onboardingProfile,
      agent: row.agent_id ? {
        id: row.agent_id,
        name: row.agent_name,
        role: row.agent_role,
        avatar: row.agent_avatar,
        status: row.agent_status,
        settings,
      } : null,
    },
    usageAccess: usageAccessView(entitlement, { now: isoNow(now), competition }),
  };
}

export function createWorkspaceService({ db, competition = null } = {}) {
  if (!db) throw new TypeError('db_required');

  async function getBootstrap({ userId, now = new Date().toISOString() }) {
    const checkedAt = isoNow(now);
    return withWriteTransaction(db, (tx) => workspaceBootstrapInTransaction(tx, {
      userId,
      now: checkedAt,
      competition,
    }));
  }

  async function completeOnboarding({ userId, input, now = new Date().toISOString() }) {
    const checkedAt = isoNow(now);
    const payload = normalizeOnboardingInput(input);
    const completedAt = checkedAt;
    return withWriteTransaction(db, async (tx) => {
      const { workspace } = await ensureDefaultWorkspaceInTransaction(tx, {
        userId,
        now: checkedAt,
        competition,
      });
      const agentId = onboardingAgentId(workspace.id);
      const profile = {
        version: 1,
        agent: {
          name: payload.name,
          role: payload.role,
          color: payload.color,
          avatar: payload.avatar,
        },
        payment: { choice: 'paypal_sandbox_preview', connected: false },
        approvalPath: payload.approvalPath,
        purchaseLimits: {
          maxPerOrder: { amount: payload.orderCap, currency: 'USD', enforcement: 'preview_only' },
          dailyWorkspace: { amount: payload.dailyCap, currency: 'USD', enforcement: 'preview_only' },
        },
        apps: payload.apps,
        memoryPills: payload.memoryPills,
        completedAt,
      };
      const settings = {
        color: payload.color,
        approvalPath: payload.approvalPath,
        orderCap: payload.orderCap,
        dailyCap: payload.dailyCap,
        currency: 'USD',
        previewOnly: true,
        onboardingVersion: 1,
      };
      await tx.execute({
        sql: `INSERT INTO agents(id, workspace_id, name, role, avatar, status, settings_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                role = excluded.role,
                avatar = excluded.avatar,
                status = 'paused',
                settings_json = excluded.settings_json,
                updated_at = excluded.updated_at
              WHERE agents.workspace_id = excluded.workspace_id`,
        args: [agentId, workspace.id, payload.name, payload.role, payload.avatar, JSON.stringify(settings), checkedAt, checkedAt],
      });
      const agentResult = await tx.execute({
        sql: 'SELECT workspace_id FROM agents WHERE id = ?',
        args: [agentId],
      });
      if (agentResult.rows[0]?.workspace_id !== workspace.id) {
        throw new WorkspaceError('onboarding_agent_provisioning_conflict', 409);
      }
      await tx.execute({
        sql: `INSERT INTO workspace_onboarding
                (workspace_id, status, profile_json, completed_at, created_at, updated_at)
              VALUES (?, 'completed', ?, ?, ?, ?)
              ON CONFLICT(workspace_id) DO UPDATE SET
                status = 'completed',
                profile_json = excluded.profile_json,
                completed_at = excluded.completed_at,
                updated_at = excluded.updated_at`,
        args: [workspace.id, JSON.stringify(profile), completedAt, checkedAt, checkedAt],
      });
      return workspaceBootstrapInTransaction(tx, { userId, now: checkedAt, competition });
    });
  }

  return Object.freeze({ getBootstrap, completeOnboarding });
}
