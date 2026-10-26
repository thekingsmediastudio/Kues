import crypto from 'node:crypto';

function parseTime(value, field) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${field}_must_be_iso_datetime`);
  return milliseconds;
}

function later(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function earlier(left, right) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

/**
 * Provision the shared competition plan and a time-bounded workspace entitlement.
 * The plan's included_tokens value is the competition's per-UTC-day AI-token cap.
 */
export async function ensureCompetitionEntitlementInTransaction(tx, {
  workspaceId,
  competition,
  now,
}) {
  if (!competition) return false;
  const nowMs = parseTime(now, 'now');
  const startsAt = new Date(parseTime(competition.startAt, 'competition_start_at')).toISOString();
  const endsAt = new Date(parseTime(competition.endAt, 'competition_end_at')).toISOString();
  const dailyTokenLimit = Number(competition.dailyTokenLimit);
  if (endsAt <= startsAt) throw new TypeError('competition_end_must_follow_start');
  if (!Number.isSafeInteger(dailyTokenLimit) || dailyTokenLimit <= 0) {
    throw new TypeError('competition_daily_token_limit_must_be_positive_integer');
  }
  await tx.execute({
    sql: `UPDATE entitlements SET status = 'revoked'
          WHERE workspace_id = ? AND source = 'competition' AND status = 'active'
            AND (starts_at <> ? OR ends_at <> ?)`,
    args: [workspaceId, startsAt, endsAt],
  });
  if (nowMs >= Date.parse(endsAt)) return false;

  const code = 'keus_competition_daily';
  const planId = 'plan_keus_competition_daily';
  const metadata = JSON.stringify({
    quotaUnit: 'tokens_per_utc_day',
    competitionStartAt: startsAt,
    competitionEndAt: endsAt,
  });
  await tx.execute({
    sql: `INSERT INTO plans
            (id, code, display_name, billing_interval, included_tokens, price_minor, currency, active, metadata_json)
          VALUES (?, ?, 'Competition free · daily AI tokens', 'competition', ?, 0, 'USD', 1, ?)
          ON CONFLICT(code) DO UPDATE SET
            included_tokens = excluded.included_tokens,
            active = 1,
            metadata_json = excluded.metadata_json`,
    args: [planId, code, dailyTokenLimit, metadata],
  });
  const plan = await tx.execute({ sql: 'SELECT id FROM plans WHERE code = ?', args: [code] });
  if (!plan.rows.length) throw new Error('competition_plan_unavailable');

  const entitlementId = `competition_${crypto.createHash('sha256')
    .update(`${workspaceId}:${startsAt}:${endsAt}`).digest('hex').slice(0, 32)}`;
  await tx.execute({
    sql: `INSERT INTO entitlements
            (id, workspace_id, plan_id, source, status, starts_at, ends_at)
          VALUES (?, ?, ?, 'competition', 'active', ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [entitlementId, workspaceId, plan.rows[0].id, startsAt, endsAt],
  });
  return true;
}

/** Select one currently valid metered entitlement; paid subscriptions take priority. */
export async function findActiveUsageEntitlement(tx, { workspaceId, now }) {
  const result = await tx.execute({
    sql: `SELECT e.id AS entitlement_id, e.workspace_id, e.plan_id, e.source,
                 e.starts_at AS entitlement_starts_at, e.ends_at AS entitlement_ends_at,
                 p.code AS plan_code, p.billing_interval, p.included_tokens, p.active AS plan_active,
                 s.id AS subscription_id, s.status AS subscription_status,
                 s.current_period_start, s.current_period_end
          FROM entitlements e
          JOIN plans p ON p.id = e.plan_id
          LEFT JOIN subscriptions s ON s.id = e.subscription_id
          WHERE e.workspace_id = ? AND e.status = 'active' AND p.active = 1
            AND e.starts_at <= ? AND e.ends_at > ?
            AND (
              (e.source = 'competition' AND p.billing_interval = 'competition')
              OR (
                e.source = 'subscription' AND p.billing_interval IN ('month', 'year')
                AND s.status = 'active'
                AND s.workspace_id = e.workspace_id AND s.plan_id = e.plan_id
                AND s.current_period_start IS NOT NULL AND s.current_period_end IS NOT NULL
                AND s.current_period_start <= ? AND s.current_period_end > ?
              )
            )
          ORDER BY CASE e.source WHEN 'subscription' THEN 0 ELSE 1 END,
                   e.starts_at DESC, e.created_at DESC
          LIMIT 1`,
    args: [workspaceId, now, now, now, now],
  });
  return result.rows[0] || null;
}

export function usageWindowForEntitlement(entitlement, now) {
  const nowMs = parseTime(now, 'now');
  if (entitlement.source === 'competition') {
    const todayStartMs = Date.UTC(
      new Date(nowMs).getUTCFullYear(),
      new Date(nowMs).getUTCMonth(),
      new Date(nowMs).getUTCDate(),
    );
    const tomorrowStartMs = todayStartMs + 24 * 60 * 60 * 1000;
    const startsAt = later(new Date(todayStartMs).toISOString(), entitlement.entitlement_starts_at);
    const endsAt = earlier(new Date(tomorrowStartMs).toISOString(), entitlement.entitlement_ends_at);
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error('invalid_competition_usage_window');
    return { startsAt, endsAt, tokenLimit: Number(entitlement.included_tokens), periodUnit: 'day' };
  }

  if (entitlement.source === 'subscription') {
    const startsAt = later(entitlement.current_period_start, entitlement.entitlement_starts_at);
    const endsAt = earlier(entitlement.current_period_end, entitlement.entitlement_ends_at);
    if (Date.parse(startsAt) > nowMs || Date.parse(endsAt) <= nowMs || Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new Error('invalid_subscription_usage_window');
    }
    return { startsAt, endsAt, tokenLimit: Number(entitlement.included_tokens), periodUnit: entitlement.billing_interval };
  }

  throw new Error('unsupported_usage_entitlement');
}

/** Create the quota window lazily and preserve counters if an entitlement changes at the same boundary. */
export async function ensureUsagePeriodInTransaction(tx, {
  workspaceId,
  entitlement,
  now,
}) {
  const window = usageWindowForEntitlement(entitlement, now);
  if (!Number.isSafeInteger(window.tokenLimit) || window.tokenLimit < 0) {
    throw new Error('invalid_entitlement_token_limit');
  }
  await tx.execute({
    sql: `INSERT INTO usage_periods
            (id, workspace_id, entitlement_id, plan_id, starts_at, ends_at, token_limit)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, starts_at) DO UPDATE SET
            entitlement_id = excluded.entitlement_id,
            plan_id = excluded.plan_id,
            ends_at = excluded.ends_at,
            token_limit = excluded.token_limit`,
    args: [
      crypto.randomUUID(), workspaceId, entitlement.entitlement_id, entitlement.plan_id,
      window.startsAt, window.endsAt, window.tokenLimit,
    ],
  });
  const result = await tx.execute({
    sql: `SELECT * FROM usage_periods
          WHERE workspace_id = ? AND starts_at = ? AND entitlement_id = ? AND plan_id = ?`,
    args: [workspaceId, window.startsAt, entitlement.entitlement_id, entitlement.plan_id],
  });
  if (!result.rows.length) throw new Error('usage_period_provisioning_failed');
  return result.rows[0];
}

export function usageAccessView(entitlement, { now, competition }) {
  if (entitlement) {
    return {
      allowed: true,
      state: entitlement.source === 'competition' ? 'competition_free' : 'subscription_active',
      planCode: entitlement.plan_code,
      tokenLimit: Number(entitlement.included_tokens),
      periodUnit: entitlement.source === 'competition' ? 'day' : entitlement.billing_interval,
      endsAt: entitlement.source === 'competition'
        ? entitlement.entitlement_ends_at
        : entitlement.current_period_end,
    };
  }

  if (!competition) return { allowed: false, state: 'usage_not_configured' };
  const nowMs = parseTime(now, 'now');
  if (nowMs < Date.parse(competition.startAt)) return { allowed: false, state: 'competition_not_started' };
  if (nowMs >= Date.parse(competition.endAt)) return { allowed: false, state: 'subscription_required' };
  return { allowed: false, state: 'competition_entitlement_unavailable' };
}
