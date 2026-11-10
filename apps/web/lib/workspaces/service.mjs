import { normalizeAgentExtensions, defaultAgentExtensions } from '../ai-agent/agent-settings.mjs';
import crypto from 'node:crypto';
import { withReadTransaction, withWriteTransaction } from '../db/transaction.mjs';
import {
  activeUsageEntitlementStatement,
  ensureCompetitionEntitlementInTransaction,
  findActiveUsageEntitlement,
  usageAccessView,
} from '../db/entitlements.mjs';

const AVATARS = new Set(['bulb', 'laptop', 'shield', 'cart', 'car', 'parcel', 'magnifier', 'tag', 'wallet', 'van']);
const COLORS = new Set(['#32d583', '#f5b942', '#4c8dff', '#b57cff', '#ff7777']);
const APPROVAL_PATHS = new Set(['desktop', 'keyfob']);
const APP_LABELS = new Set(['paypal', 'channel3', 'kernel', 'whatsapp', 'gmail', 'instagram']);
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
  let extensions;
  try { extensions = normalizeAgentExtensions(input); } catch (error) { throw new WorkspaceError(error.message, 400); }
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
    ...extensions,
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

function mapWorkspaceBootstrapAgents(rows) {
  return rows.map((agentRow) => ({
    id: agentRow.id,
    name: agentRow.name,
    role: agentRow.role,
    avatar: agentRow.avatar,
    status: agentRow.status,
    settings: parseJson(agentRow.settings_json),
    createdAt: agentRow.created_at,
    updatedAt: agentRow.updated_at,
  }));
}

function workspaceBootstrapView({ user, row, agentRows, entitlement, now, competition, theme }) {
  const agents = mapWorkspaceBootstrapAgents(agentRows);
  const onboardingAgent = agents.find((agent) => agent.id === onboardingAgentId(row.workspace_id)) || null;
  return {
    user: {
      id: user.id,
      email: user.email_normalized,
      displayName: user.display_name,
      theme: theme === 'light' ? 'light' : 'dark',
    },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      status: row.workspace_status,
      role: row.member_role,
    },
    onboarding: {
      status: row.onboarding_status || 'not_started',
      completedAt: row.completed_at || null,
      profile: parseJson(row.profile_json),
      agent: onboardingAgent ? {
        id: onboardingAgent.id,
        name: onboardingAgent.name,
        role: onboardingAgent.role,
        avatar: onboardingAgent.avatar,
        status: onboardingAgent.status,
        settings: onboardingAgent.settings,
      } : null,
    },
    usageAccess: usageAccessView(entitlement, { now, competition }),
    agents,
  };
}

/**
 * Most authenticated page loads are reads of an already-provisioned workspace.
 * Keep those loads out of the serialized write queue; return null when the legacy
 * provisioning path needs to repair or create any required rows.
 */
async function workspaceBootstrapFromExistingInTransaction(tx, { userId, now, competition }) {
  const result = await tx.execute({
    sql: `SELECT u.id AS user_id, u.email_normalized AS user_email_normalized,
                 u.display_name AS user_display_name, u.status AS user_status,
                 w.id AS workspace_id, w.owner_user_id, w.name AS workspace_name,
                 w.status AS workspace_status, m.role AS member_role,
                 o.status AS onboarding_status, o.profile_json, o.completed_at,
                 p.theme AS user_theme
          FROM users u
          LEFT JOIN user_default_workspaces d ON d.user_id = u.id
          LEFT JOIN workspaces w ON w.id = d.workspace_id
          LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = u.id
          LEFT JOIN workspace_onboarding o ON o.workspace_id = w.id
          LEFT JOIN user_preferences p ON p.user_id = u.id
          WHERE u.id = ?`,
    args: [String(userId || '').trim()],
  });
  const row = result.rows[0];
  if (!row || row.user_status !== 'active') throw new WorkspaceError('account_unavailable', 403);

  // Any missing or inconsistent provisioning state gets the existing repair path.
  if (!row.workspace_id || row.owner_user_id !== row.user_id || row.member_role !== 'owner' || !row.onboarding_status) {
    return null;
  }
  if (row.workspace_status !== 'active') throw new WorkspaceError('workspace_unavailable', 403);
  const statements = [
    {
      sql: `SELECT id, name, role, avatar, status, settings_json, created_at, updated_at
            FROM agents WHERE workspace_id = ?
            ORDER BY created_at ASC, id ASC`,
      args: [row.workspace_id],
    },
    activeUsageEntitlementStatement({ workspaceId: row.workspace_id, now }),
  ];
  if (competition) statements.push(competitionEntitlementStatement(row.workspace_id));
  const results = await tx.batch(statements);
  const agentsResult = results[0];
  const entitlement = results[1].rows[0] || null;
  if (competition && competitionEntitlementNeedsRepair(results[2].rows, { competition, now })) return null;
  return workspaceBootstrapView({
    user: {
      id: row.user_id,
      email_normalized: row.user_email_normalized,
      display_name: row.user_display_name,
    },
    row,
    agentRows: agentsResult.rows,
    entitlement,
    now,
    competition,
    theme: row.user_theme,
  });
}

function competitionEntitlementStatement(workspaceId) {
  return {
    sql: `SELECT e.status, e.starts_at, e.ends_at,
                 p.code AS plan_code, p.billing_interval, p.included_tokens,
                 p.active AS plan_active, p.metadata_json
          FROM entitlements e
          LEFT JOIN plans p ON p.id = e.plan_id
          WHERE e.workspace_id = ? AND e.source = 'competition'`,
    args: [workspaceId],
  };
}

function competitionEntitlementNeedsRepair(rows, { competition, now }) {
  if (!competition) return false;
  const startMs = Date.parse(competition.startAt);
  const endMs = Date.parse(competition.endAt);
  const dailyTokenLimit = Number(competition.dailyTokenLimit);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
    || !Number.isSafeInteger(dailyTokenLimit) || dailyTokenLimit <= 0) return true;

  const startsAt = new Date(startMs).toISOString();
  const endsAt = new Date(endMs).toISOString();
  const metadata = JSON.stringify({
    quotaUnit: 'tokens_per_utc_day',
    competitionStartAt: startsAt,
    competitionEndAt: endsAt,
  });
  const staleActiveGrant = rows.some((row) => row.status === 'active'
    && (row.starts_at !== startsAt || row.ends_at !== endsAt));
  if (staleActiveGrant) return true;

  if (Date.parse(now) >= endMs) return false;
  const readyGrantExists = rows.some((row) => row.status === 'active'
    && row.starts_at === startsAt
    && row.ends_at === endsAt
    && row.plan_code === 'keus_competition_daily'
    && row.billing_interval === 'competition'
    && Number(row.included_tokens) === dailyTokenLimit
    && Number(row.plan_active) === 1
    && row.metadata_json === metadata);
  return !readyGrantExists;
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
                 o.status AS onboarding_status, o.profile_json, o.completed_at
          FROM user_default_workspaces d
          JOIN workspaces w ON w.id = d.workspace_id
          JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = d.user_id
          LEFT JOIN workspace_onboarding o ON o.workspace_id = w.id
          WHERE d.user_id = ?`,
    args: [user.id],
  });
  const row = result.rows[0];
  if (!row) throw new WorkspaceError('workspace_access_denied', 403);

  const agentsResult = await tx.execute({
    sql: `SELECT id, name, role, avatar, status, settings_json, created_at, updated_at
          FROM agents WHERE workspace_id = ?
          ORDER BY created_at ASC, id ASC`,
    args: [row.workspace_id],
  });
  const entitlement = await findActiveUsageEntitlement(tx, {
    workspaceId: row.workspace_id,
    now,
  });
  const preferenceResult = await tx.execute({
    sql: 'SELECT theme FROM user_preferences WHERE user_id = ?',
    args: [user.id],
  });
  return workspaceBootstrapView({
    user,
    row,
    agentRows: agentsResult.rows,
    entitlement,
    now,
    competition,
    theme: preferenceResult.rows[0]?.theme,
  });
}

// Keep UI-controlled caps and an existing agent policy in one transaction.
// Workspace defaults, inactive policies, merchant restrictions and per-run limits
// are independent safeguards and must not be rewritten by an agent settings save.
async function syncAgentPolicyCaps(tx, { workspaceId, agentId, payload, now }) {
  const policies = await tx.execute({
    sql: 'SELECT currency FROM spend_policies WHERE workspace_id = ? AND agent_id = ? AND active = 1',
    args: [workspaceId, agentId],
  });
  if (policies.rows.some((policy) => policy.currency !== 'USD')) {
    throw new WorkspaceError('spend_policy_currency_mismatch', 409);
  }
  await tx.execute({
    sql: `UPDATE spend_policies
          SET max_per_order_minor = ?, daily_budget_minor = ?, updated_at = ?
          WHERE workspace_id = ? AND agent_id = ? AND active = 1`,
    args: [payload.orderCap * 100, payload.dailyCap * 100, now, workspaceId, agentId],
  });
}

/** Starter agent for accounts that sign in without finishing onboarding. Same shape and id as the
 * onboarding agent, so completing onboarding later customizes it in place instead of adding a second one. */
export const DEFAULT_AGENT_INPUT = Object.freeze({
  name: 'Scout',
  role: 'Web & commerce scout',
  color: '#32d583',
  avatar: 'bulb',
  approvalPath: 'desktop',
  orderCap: 85,
  dailyCap: 250,
  apps: [],
  memoryPills: [],
});

export async function ensureDefaultAgentInTransaction(tx, { workspaceId, now = new Date().toISOString() }) {
  const existing = await tx.execute({
    sql: 'SELECT id FROM agents WHERE workspace_id = ? LIMIT 1',
    args: [workspaceId],
  });
  if (existing.rows.length) return { created: false, agentId: null };
  const checkedAt = isoNow(now);
  const payload = normalizeOnboardingInput(DEFAULT_AGENT_INPUT);
  const agentId = onboardingAgentId(workspaceId);
  const settings = {
    ...defaultAgentExtensions(),
    ...normalizeAgentExtensions(payload),
    color: payload.color,
    approvalPath: payload.approvalPath,
    orderCap: payload.orderCap,
    dailyCap: payload.dailyCap,
    currency: 'USD',
    apps: payload.apps,
    memoryPills: payload.memoryPills,
    previewOnly: true,
    onboardingVersion: 1,
  };
  const inserted = await tx.execute({
    sql: `INSERT INTO agents(id, workspace_id, name, role, avatar, status, settings_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [agentId, workspaceId, payload.name, payload.role, payload.avatar, JSON.stringify(settings), checkedAt, checkedAt],
  });
  return { created: inserted.rowsAffected === 1, agentId: inserted.rowsAffected === 1 ? agentId : null };
}

export function createWorkspaceService({ db, competition = null } = {}) {
  if (!db) throw new TypeError('db_required');

  async function getBootstrap({ userId, now = new Date().toISOString() }) {
    const checkedAt = isoNow(now);
    const existing = await withReadTransaction(db, (tx) => workspaceBootstrapFromExistingInTransaction(tx, {
      userId,
      now: checkedAt,
      competition,
    }));
    if (existing) return existing;
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
        ...defaultAgentExtensions(),
        ...normalizeAgentExtensions(payload),
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
              VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                role = excluded.role,
                avatar = excluded.avatar,
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
      await syncAgentPolicyCaps(tx, { workspaceId: workspace.id, agentId, payload, now: checkedAt });
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

  /** Give a signed-in account a starter agent when its workspace has none (sign-up without onboarding). */
  async function ensureDefaultAgent({ userId, now = new Date().toISOString() }) {
    const checkedAt = isoNow(now);
    return withWriteTransaction(db, async (tx) => {
      const { workspace } = await ensureDefaultWorkspaceInTransaction(tx, { userId, now: checkedAt, competition });
      return ensureDefaultAgentInTransaction(tx, { workspaceId: workspace.id, now: checkedAt });
    });
  }

  async function createAgent({ userId, input, now = new Date().toISOString() }) {
    const checkedAt = isoNow(now);
    const payload = normalizeOnboardingInput(input);
    return withWriteTransaction(db, async (tx) => {
      const { workspace } = await ensureDefaultWorkspaceInTransaction(tx, {
        userId,
        now: checkedAt,
        competition,
      });
      const duplicate = await tx.execute({
        sql: 'SELECT id FROM agents WHERE workspace_id = ? AND lower(name) = lower(?) LIMIT 1',
        args: [workspace.id, payload.name],
      });
      if (duplicate.rows.length) throw new WorkspaceError('agent_name_conflict', 409);

      const agentId = `agt_${crypto.randomUUID().replaceAll('-', '')}`;
      const settings = {
        ...defaultAgentExtensions(),
        ...normalizeAgentExtensions(payload),
        color: payload.color,
        approvalPath: payload.approvalPath,
        orderCap: payload.orderCap,
        dailyCap: payload.dailyCap,
        currency: 'USD',
        apps: payload.apps,
        memoryPills: payload.memoryPills,
        previewOnly: true,
        onboardingVersion: 1,
      };
      await tx.execute({
        sql: `INSERT INTO agents(id, workspace_id, name, role, avatar, status, settings_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        args: [agentId, workspace.id, payload.name, payload.role, payload.avatar, JSON.stringify(settings), checkedAt, checkedAt],
      });
      const bootstrap = await workspaceBootstrapInTransaction(tx, { userId, now: checkedAt, competition });
      return { ...bootstrap, createdAgentId: agentId };
    });
  }

  async function updateWorkspaceName({ userId, name: rawName, now = new Date().toISOString() }) {
    const checkedAt = isoNow(now);
    const name = requiredText(rawName, 'workspace_name', 80);
    return withWriteTransaction(db, async (tx) => {
      const { user, workspace } = await ensureDefaultWorkspaceInTransaction(tx, {
        userId,
        now: checkedAt,
        competition,
      });
      if (workspace.owner_user_id !== user.id) throw new WorkspaceError('workspace_owner_required', 403);
      await tx.execute({
        sql: `UPDATE workspaces SET name = ?, updated_at = ?
              WHERE id = ? AND owner_user_id = ? AND status = 'active'`,
        args: [name, checkedAt, workspace.id, user.id],
      });
      return workspaceBootstrapInTransaction(tx, { userId, now: checkedAt, competition });
    });
  }

  async function updateAgent({ userId, agentId: rawAgentId, input, now = new Date().toISOString() }) {
    const checkedAt = isoNow(now);
    const agentId = requiredText(rawAgentId, 'agent_id', 255);
    const payload = normalizeOnboardingInput(input);
    payload.apps = payload.apps.map((app) => app.toLowerCase());
    if (payload.apps.some((app) => !APP_LABELS.has(app))) {
      throw new WorkspaceError('invalid_apps', 400);
    }

    return withWriteTransaction(db, async (tx) => {
      const { user, workspace } = await ensureDefaultWorkspaceInTransaction(tx, {
        userId,
        now: checkedAt,
        competition,
      });
      const existing = await tx.execute({
        sql: `SELECT id, name, role, avatar, status, settings_json
              FROM agents WHERE id = ? AND workspace_id = ? LIMIT 1`,
        args: [agentId, workspace.id],
      });
      const agent = existing.rows[0];
      if (!agent) throw new WorkspaceError('agent_not_found', 404);
      const duplicate = await tx.execute({
        sql: `SELECT id FROM agents
              WHERE workspace_id = ? AND lower(name) = lower(?) AND id <> ? LIMIT 1`,
        args: [workspace.id, payload.name, agentId],
      });
      if (duplicate.rows.length) throw new WorkspaceError('agent_name_conflict', 409);

      const currentSettings = parseJson(agent.settings_json);
      const settings = {
        ...currentSettings,
        ...normalizeAgentExtensions(payload),
        color: payload.color,
        approvalPath: payload.approvalPath,
        orderCap: payload.orderCap,
        dailyCap: payload.dailyCap,
        currency: String(currentSettings.currency || 'USD').toUpperCase(),
        apps: payload.apps,
        memoryPills: payload.memoryPills,
        previewOnly: true,
        onboardingVersion: Number(currentSettings.onboardingVersion) || 1,
      };
      await tx.execute({
        sql: `UPDATE agents
              SET name = ?, role = ?, avatar = ?, settings_json = ?, updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
        args: [payload.name, payload.role, payload.avatar, JSON.stringify(settings), checkedAt, agentId, workspace.id],
      });

      await syncAgentPolicyCaps(tx, { workspaceId: workspace.id, agentId, payload, now: checkedAt });

      if (agentId === onboardingAgentId(workspace.id)) {
        const onboardingResult = await tx.execute({
          sql: 'SELECT profile_json FROM workspace_onboarding WHERE workspace_id = ?',
          args: [workspace.id],
        });
        const profile = parseJson(onboardingResult.rows[0]?.profile_json);
        const previousLimits = profile.purchaseLimits && typeof profile.purchaseLimits === 'object'
          ? profile.purchaseLimits
          : {};
        const previousOrder = previousLimits.maxPerOrder && typeof previousLimits.maxPerOrder === 'object'
          ? previousLimits.maxPerOrder
          : {};
        const previousDaily = previousLimits.dailyWorkspace && typeof previousLimits.dailyWorkspace === 'object'
          ? previousLimits.dailyWorkspace
          : {};
        const updatedProfile = {
          ...profile,
          agent: { ...(profile.agent || {}), name: payload.name, role: payload.role, avatar: payload.avatar, color: payload.color },
          approvalPath: payload.approvalPath,
          purchaseLimits: {
            ...previousLimits,
            maxPerOrder: { ...previousOrder, amount: payload.orderCap, currency: 'USD', enforcement: 'preview_only' },
            dailyWorkspace: { ...previousDaily, amount: payload.dailyCap, currency: 'USD', enforcement: 'preview_only' },
          },
          apps: payload.apps,
          memoryPills: payload.memoryPills,
        };
        await tx.execute({
          sql: `UPDATE workspace_onboarding SET profile_json = ?, updated_at = ? WHERE workspace_id = ?`,
          args: [JSON.stringify(updatedProfile), checkedAt, workspace.id],
        });
      }

      return workspaceBootstrapInTransaction(tx, { userId: user.id, now: checkedAt, competition });
    });
  }

  return Object.freeze({ getBootstrap, completeOnboarding, createAgent, ensureDefaultAgent, updateWorkspaceName, updateAgent });
}
