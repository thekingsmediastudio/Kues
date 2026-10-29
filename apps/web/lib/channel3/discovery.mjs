import crypto from 'node:crypto';
import { withReadTransaction, withWriteTransaction } from '../db/transaction.mjs';
import { Channel3Error } from './client.mjs';

function isoNow(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid_timestamp');
  return date.toISOString();
}

export async function createAgentRun({
  db,
  workspaceId,
  userId,
  agentId,
  goal,
  mode = 'live_search',
  now = Date.now(),
}) {
  if (!db) throw new Error('database_required');
  if (!workspaceId) throw new Error('workspace_id_required');
  if (!userId) throw new Error('user_id_required');
  if (!goal) throw new Error('goal_required');

  const runId = `run_${crypto.randomUUID().replaceAll('-', '')}`;
  const timestamp = isoNow(now);

  return withWriteTransaction(db, async (tx) => {
    let effectiveAgentId = agentId;
    if (!effectiveAgentId) {
      const defaultAgentResult = await tx.execute({
        sql: 'SELECT id FROM agents WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1',
        args: [workspaceId],
      });
      const defaultAgent = defaultAgentResult.rows[0];
      if (defaultAgent?.id) {
        effectiveAgentId = defaultAgent.id;
      } else {
        effectiveAgentId = `ag_${crypto.randomUUID().replaceAll('-', '')}`;
        await tx.execute({
          sql: `INSERT INTO agents (workspace_id, id, name, role, avatar, status, settings_json, created_at, updated_at)
                VALUES (?, ?, 'Path Finder', 'Web & commerce scout', 'magnifier', 'active', '{}', ?, ?)`,
          args: [workspaceId, effectiveAgentId, timestamp, timestamp],
        });
      }
    }

    await tx.execute({
      sql: `INSERT INTO runs (id, workspace_id, user_id, agent_id, goal, status, mode, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      args: [runId, workspaceId, userId, effectiveAgentId, String(goal).slice(0, 500), mode, timestamp, timestamp],
    });

    await tx.execute({
      sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
            VALUES (?, ?, ?, 'run_started', ?, ?)`,
      args: [`evt_${crypto.randomUUID().replaceAll('-', '')}`, workspaceId, runId, JSON.stringify({ mode, goal }), timestamp],
    });

    return {
      runId,
      workspaceId,
      userId,
      agentId: effectiveAgentId,
      goal,
      status: 'running',
      mode,
      createdAt: timestamp,
    };
  });
}

export async function recordDiscoveredOffers({
  db,
  workspaceId,
  runId,
  products = [],
  now = Date.now(),
}) {
  if (!db) throw new Error('database_required');
  if (!workspaceId) throw new Error('workspace_id_required');
  if (!runId) throw new Error('run_id_required');
  if (!Array.isArray(products)) throw new Error('products_must_be_array');

  const timestamp = isoNow(now);

  return withWriteTransaction(db, async (tx) => {
    const runResult = await tx.execute({
      sql: 'SELECT id, status FROM runs WHERE workspace_id = ? AND id = ?',
      args: [workspaceId, runId],
    });
    const run = runResult.rows[0];
    if (!run) throw new Error('run_not_found');

    const inserted = [];
    for (const p of products) {
      const offerId = `off_${crypto.randomUUID().replaceAll('-', '')}`;
      await tx.execute({
        sql: `INSERT INTO product_offers (
               id, workspace_id, run_id, source, source_listing_id, source_url,
               merchant_name, merchant_domain, title, amount_minor, currency,
               availability, evidence_hash, evidence_ref, observed_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          offerId,
          workspaceId,
          runId,
          p.source || 'channel3',
          p.id || null,
          p.url || '',
          p.merchantName || 'Unknown seller',
          p.merchantDomain || 'unknown.example',
          p.title || 'Untitled',
          p.amountMinor || 0,
          p.currency || 'USD',
          p.availability || 'unknown',
          p.evidenceHash,
          p.evidenceRef || null,
          p.observedAt || timestamp,
          timestamp,
        ],
      });
      inserted.push({ ...p, offerId });
    }

    await tx.execute({
      sql: `INSERT INTO run_events (id, workspace_id, run_id, event_type, details_json, created_at)
            VALUES (?, ?, ?, 'products_discovered', ?, ?)`,
      args: [
        `evt_${crypto.randomUUID().replaceAll('-', '')}`,
        workspaceId,
        runId,
        JSON.stringify({ count: products.length, sample: products[0]?.title || null }),
        timestamp,
      ],
    });

    await tx.execute({
      sql: `UPDATE runs SET status = 'completed', updated_at = ?, completed_at = ? WHERE workspace_id = ? AND id = ?`,
      args: [timestamp, timestamp, workspaceId, runId],
    });

    return inserted;
  });
}

export async function getProductOffersForRun({ db, workspaceId, runId }) {
  if (!db) throw new Error('database_required');
  return withReadTransaction(db, async (tx) => {
    const result = await tx.execute({
      sql: `SELECT id, source, source_listing_id, source_url, merchant_name, merchant_domain,
                   title, amount_minor, currency, availability, evidence_hash, evidence_ref,
                   observed_at, created_at
            FROM product_offers
            WHERE workspace_id = ? AND run_id = ?
            ORDER BY observed_at DESC, created_at DESC`,
      args: [workspaceId, runId],
    });

    return result.rows.map((r) => ({
      id: r.id,
      sourceListingId: r.source_listing_id,
      source: r.source,
      url: r.source_url,
      merchantName: r.merchant_name,
      merchantDomain: r.merchant_domain,
      title: r.title,
      amountMinor: r.amount_minor,
      priceFormatted: `$${(r.amount_minor / 100).toFixed(2)} ${r.currency}`,
      currency: r.currency,
      availability: r.availability,
      evidenceHash: r.evidence_hash,
      evidenceRef: r.evidence_ref,
      observedAt: r.observed_at,
      createdAt: r.created_at,
    }));
  });
}

/**
 * High-level product discovery orchestrator.
 * Searches via Channel3 client (or sample fixtures if explicitly fallback-allowed/demo mode),
 * normalizes evidence, ties evidence to a new run if DB is present, and preserves source attribution.
 */
export async function discoverProducts({
  channel3Client,
  query,
  limit = 10,
  filters = {},
  db = null,
  workspaceId = null,
  userId = null,
  agentId = null,
  runId = null,
  mode = 'live_search',
  allowFixtureFallback = false,
  now = Date.now(),
}) {
  if (!channel3Client) throw new Error('channel3_client_required');
  if (!query || !String(query).trim()) throw new Channel3Error('query_required', 400);

  let searchResult;
  if (channel3Client.isConfigured()) {
    searchResult = await channel3Client.searchProducts({ query, limit, filters });
  } else if (allowFixtureFallback || mode === 'demo') {
    searchResult = channel3Client.searchSampleProducts({ query, limit, filters });
  } else {
    throw new Channel3Error('channel3_not_configured', 503, 'Channel3 API key is not configured');
  }

  let effectiveRunId = runId;
  let offersPersisted = false;

  if (db && workspaceId && userId) {
    if (!effectiveRunId) {
      const run = await createAgentRun({
        db,
        workspaceId,
        userId,
        agentId,
        goal: `Discover products matching "${String(query).trim()}"`,
        mode: searchResult.isLive ? 'live_search' : 'demo',
        now,
      });
      effectiveRunId = run.runId;
    }

    if (effectiveRunId && searchResult.products.length > 0) {
      const recorded = await recordDiscoveredOffers({
        db,
        workspaceId,
        runId: effectiveRunId,
        products: searchResult.products,
        now,
      });
      searchResult.products = recorded;
      offersPersisted = true;
    }
  }

  return {
    query: searchResult.query,
    count: searchResult.count,
    products: searchResult.products,
    isLive: searchResult.isLive,
    source: searchResult.source,
    notice: searchResult.notice || null,
    runId: effectiveRunId || null,
    offersPersisted,
  };
}
