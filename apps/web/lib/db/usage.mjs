import crypto from 'node:crypto';
import { withWriteTransaction } from './transaction.mjs';
import { ensureUsagePeriodInTransaction, findActiveUsageEntitlement } from './entitlements.mjs';

export class UsageLimitError extends Error {
  constructor({ limit, consumed, reserved, requested }) {
    super('token_usage_limit_exceeded');
    this.name = 'UsageLimitError';
    this.limit = Number(limit);
    this.consumed = Number(consumed);
    this.reserved = Number(reserved);
    this.requested = Number(requested);
  }
}

export class UsageReservationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'UsageReservationError';
    this.code = code;
  }
}

function requiredText(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${field}_required`);
  return normalized;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field}_must_be_non_negative_integer`);
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field}_must_be_positive_integer`);
  return value;
}

function rowToReservation(row, extra = {}) {
  return {
    reservationId: row.id,
    workspaceId: row.workspace_id,
    usagePeriodId: row.usage_period_id,
    userId: row.user_id,
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    reservedTokens: Number(row.reserved_tokens),
    actualTokens: row.actual_tokens == null ? null : Number(row.actual_tokens),
    status: row.status,
    expiresAt: row.expires_at,
    ...extra,
  };
}

/**
 * Reserve quota before a metered model call. The write transaction and conditional update
 * make competing requests contend on the same quota row instead of overspending it.
 */
export async function reserveTokens(db, {
  workspaceId,
  userId,
  runId = null,
  idempotencyKey,
  estimatedTokens,
  now = new Date().toISOString(),
  ttlSeconds = 300,
}) {
  workspaceId = requiredText(workspaceId, 'workspace_id');
  userId = requiredText(userId, 'user_id');
  idempotencyKey = requiredText(idempotencyKey, 'idempotency_key');
  if (runId != null) runId = requiredText(runId, 'run_id');
  estimatedTokens = positiveInteger(estimatedTokens, 'estimated_tokens');
  ttlSeconds = positiveInteger(ttlSeconds, 'ttl_seconds');

  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now_must_be_iso_datetime');
  const checkedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();

  return withWriteTransaction(db, async (tx) => {
    const membership = await tx.execute({
      sql: `SELECT m.role FROM workspace_members m
            JOIN workspaces w ON w.id = m.workspace_id
            JOIN users u ON u.id = m.user_id
            WHERE m.workspace_id = ? AND m.user_id = ?
              AND w.status = 'active' AND u.status = 'active'`,
      args: [workspaceId, userId],
    });
    if (!membership.rows.length) throw new UsageReservationError('workspace_access_denied');

    if (runId) {
      const run = await tx.execute({
        sql: `SELECT id FROM runs WHERE id = ? AND workspace_id = ? AND user_id = ?`,
        args: [runId, workspaceId, userId],
      });
      if (!run.rows.length) throw new UsageReservationError('run_access_denied');
    }

    const duplicate = await tx.execute({
      sql: 'SELECT * FROM usage_reservations WHERE workspace_id = ? AND idempotency_key = ?',
      args: [workspaceId, idempotencyKey],
    });
    if (duplicate.rows.length) {
      const row = duplicate.rows[0];
      if (row.user_id !== userId || row.run_id !== runId || Number(row.reserved_tokens) !== estimatedTokens) {
        throw new UsageReservationError('idempotency_key_reused_with_different_request');
      }
      return rowToReservation(row, { duplicate: true });
    }

    const entitlement = await findActiveUsageEntitlement(tx, { workspaceId, now: checkedAt });
    if (!entitlement) throw new UsageReservationError('active_entitlement_required');
    let period;
    try {
      period = await ensureUsagePeriodInTransaction(tx, {
        workspaceId,
        entitlement,
        now: checkedAt,
      });
    } catch (error) {
      if (error?.message === 'invalid_subscription_usage_window'
          || error?.message === 'invalid_competition_usage_window') {
        throw new UsageReservationError('active_entitlement_required');
      }
      throw error;
    }

    // Expired open reservations stop consuming quota; a late completion can still be settled
    // and recorded truthfully, after which future requests observe the actual overage.
    const stale = await tx.execute({
      sql: `SELECT COALESCE(SUM(reserved_tokens), 0) AS stale_tokens
            FROM usage_reservations
            WHERE usage_period_id = ? AND status = 'reserved' AND expires_at <= ?`,
      args: [period.id, checkedAt],
    });
    const staleTokens = Number(stale.rows[0]?.stale_tokens || 0);
    if (staleTokens > 0) {
      await tx.execute({
        sql: 'UPDATE usage_periods SET reserved_tokens = MAX(0, reserved_tokens - ?) WHERE id = ?',
        args: [staleTokens, period.id],
      });
      await tx.execute({
        sql: `UPDATE usage_reservations SET status = 'expired'
              WHERE usage_period_id = ? AND status = 'reserved' AND expires_at <= ?`,
        args: [period.id, checkedAt],
      });
      period.reserved_tokens = Math.max(0, Number(period.reserved_tokens) - staleTokens);
    }

    const consumed = Number(period.consumed_tokens);
    const reserved = Number(period.reserved_tokens);
    const limit = Number(period.token_limit);
    const update = await tx.execute({
      sql: `UPDATE usage_periods
            SET reserved_tokens = reserved_tokens + ?
            WHERE id = ? AND consumed_tokens + reserved_tokens + ? <= token_limit`,
      args: [estimatedTokens, period.id, estimatedTokens],
    });
    if (Number(update.rowsAffected) !== 1) {
      throw new UsageLimitError({ limit, consumed, reserved, requested: estimatedTokens });
    }

    const id = crypto.randomUUID();
    await tx.execute({
      sql: `INSERT INTO usage_reservations
              (id, usage_period_id, workspace_id, user_id, run_id, idempotency_key,
               reserved_tokens, status, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
      args: [id, period.id, workspaceId, userId, runId, idempotencyKey, estimatedTokens, expiresAt],
    });
    return {
      reservationId: id,
      usagePeriodId: period.id,
      workspaceId,
      userId,
      runId,
      idempotencyKey,
      reservedTokens: estimatedTokens,
      actualTokens: null,
      status: 'reserved',
      expiresAt,
      duplicate: false,
    };
  });
}

/** Settle a reservation with provider-reported token counts and an idempotent usage event. */
export async function settleTokenReservation(db, {
  workspaceId,
  idempotencyKey,
  provider,
  model,
  inputTokens,
  outputTokens,
  occurredAt = new Date().toISOString(),
}) {
  workspaceId = requiredText(workspaceId, 'workspace_id');
  idempotencyKey = requiredText(idempotencyKey, 'idempotency_key');
  provider = requiredText(provider, 'provider');
  model = requiredText(model, 'model');
  inputTokens = nonNegativeInteger(inputTokens, 'input_tokens');
  outputTokens = nonNegativeInteger(outputTokens, 'output_tokens');
  if (!Number.isFinite(Date.parse(occurredAt))) throw new TypeError('occurred_at_must_be_iso_datetime');
  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) throw new TypeError('total_tokens_out_of_range');

  return withWriteTransaction(db, async (tx) => {
    const found = await tx.execute({
      sql: 'SELECT * FROM usage_reservations WHERE workspace_id = ? AND idempotency_key = ?',
      args: [workspaceId, idempotencyKey],
    });
    if (!found.rows.length) throw new UsageReservationError('reservation_not_found');
    const reservation = found.rows[0];

    if (reservation.status === 'settled') {
      const existing = await tx.execute({
        sql: 'SELECT * FROM usage_events WHERE reservation_id = ?',
        args: [reservation.id],
      });
      const event = existing.rows[0];
      if (!event || Number(event.input_tokens) !== inputTokens || Number(event.output_tokens) !== outputTokens
          || event.provider !== provider || event.model !== model) {
        throw new UsageReservationError('settled_reservation_payload_mismatch');
      }
      return {
        reservationId: reservation.id,
        usageEventId: event.id,
        totalTokens,
        status: 'settled',
        duplicate: true,
      };
    }
    if (!['reserved', 'expired'].includes(reservation.status)) {
      throw new UsageReservationError(`reservation_${reservation.status}`);
    }

    const wasReserved = reservation.status === 'reserved';
    const eventId = crypto.randomUUID();
    await tx.execute({
      sql: `INSERT INTO usage_events
              (id, workspace_id, usage_period_id, reservation_id, user_id, run_id, event_key,
               provider, model, input_tokens, output_tokens, total_tokens, occurred_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        eventId, workspaceId, reservation.usage_period_id, reservation.id,
        reservation.user_id, reservation.run_id, `usage:${idempotencyKey}`,
        provider, model, inputTokens, outputTokens, totalTokens, occurredAt,
      ],
    });

    await tx.execute({
      sql: `UPDATE usage_periods
            SET consumed_tokens = consumed_tokens + ?,
                reserved_tokens = CASE WHEN ? = 1 THEN MAX(0, reserved_tokens - ?) ELSE reserved_tokens END
            WHERE id = ?`,
      args: [totalTokens, wasReserved ? 1 : 0, Number(reservation.reserved_tokens), reservation.usage_period_id],
    });
    await tx.execute({
      sql: `UPDATE usage_reservations
            SET status = 'settled', actual_tokens = ?, settled_at = ?
            WHERE id = ?`,
      args: [totalTokens, occurredAt, reservation.id],
    });

    return {
      reservationId: reservation.id,
      usageEventId: eventId,
      totalTokens,
      status: 'settled',
      duplicate: false,
    };
  });
}

/** Release reserved quota after a provider call fails before it consumes tokens. */
export async function releaseTokenReservation(db, { workspaceId, idempotencyKey }) {
  workspaceId = requiredText(workspaceId, 'workspace_id');
  idempotencyKey = requiredText(idempotencyKey, 'idempotency_key');

  return withWriteTransaction(db, async (tx) => {
    const result = await tx.execute({
      sql: 'SELECT * FROM usage_reservations WHERE workspace_id = ? AND idempotency_key = ?',
      args: [workspaceId, idempotencyKey],
    });
    if (!result.rows.length) throw new UsageReservationError('reservation_not_found');
    const row = result.rows[0];
    if (row.status === 'released' || row.status === 'expired') {
      return rowToReservation(row, { duplicate: true });
    }
    if (row.status !== 'reserved') throw new UsageReservationError(`reservation_${row.status}`);

    await tx.execute({
      sql: 'UPDATE usage_periods SET reserved_tokens = MAX(0, reserved_tokens - ?) WHERE id = ?',
      args: [Number(row.reserved_tokens), row.usage_period_id],
    });
    await tx.execute({
      sql: "UPDATE usage_reservations SET status = 'released' WHERE id = ? AND status = 'reserved'",
      args: [row.id],
    });
    return rowToReservation({ ...row, status: 'released' }, { duplicate: false });
  });
}
