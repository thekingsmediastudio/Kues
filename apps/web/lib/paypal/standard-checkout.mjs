import {hasUnverifiedBlockedConditions} from '../channel3/blocked-conditions.mjs';
import {hasExplicitCurrency} from '../channel3/currency-evidence.mjs';
import {readPurchaseItems,validatePurchaseItemRows,paypalLineItems} from '../commerce/purchase-items.mjs';
import crypto from "node:crypto";
import { withWriteTransaction } from "../db/transaction.mjs";
const BASE = "https://api-m.sandbox.paypal.com";
const hash = (x) => crypto.createHash("sha256").update(String(x)).digest("hex");
const iso = (t) => new Date(t).toISOString();
export class CheckoutError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const fail = (c, s) => {
  throw new CheckoutError(c, s);
};
function configured(env) {
  if (env.PAYPAL_ENV !== "sandbox") fail("paypal_sandbox_required", 503);
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET)
    fail("paypal_not_configured", 503);
}
function approvalUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("paypal_invalid_approval_url", 502);
  }
  if (
    u.protocol !== "https:" ||
    !["sandbox.paypal.com", "www.sandbox.paypal.com"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  )
    fail("paypal_invalid_approval_url", 502);
  return u.href;
}
export function createCheckoutClient({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  async function request(path, options) {
    let r;
    try {
      r = await fetchImpl(BASE + path, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      fail("paypal_unavailable", 502);
    }
    if (!r.ok)
      fail(
        r.status === 404 && options.method === "GET" && /^\/v2\/checkout\/orders\/[^/]+$/.test(path)
          ? "paypal_order_unavailable"
          : r.status === 401
          ? "paypal_credentials_rejected"
          : r.status === 403
            ? "paypal_permission_denied"
            : "paypal_request_failed",
        502,
      );
    if (r.status === 204) return {};
    try {
      return await r.json();
    } catch {
      fail("paypal_invalid_response", 502);
    }
  }
  async function api(path, { method = "GET", body, key } = {}) {
    configured(env);
    const auth = await request("/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET,
          ).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!auth.access_token) fail("paypal_credentials_rejected", 502);
    return request(path, {
      method,
      headers: {
        Authorization: "Bearer " + auth.access_token,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(key ? { "PayPal-Request-Id": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  return {
    create: ({ id, amountMinor, returnUrl, cancelUrl, items=[] }) =>
      api("/v2/checkout/orders", {
        method: "POST",
        key: id + "-create",
        body: {
          intent: "AUTHORIZE",
          purchase_units: [
            {
              reference_id: id,
              custom_id: id,
              description:
                "Keus sandbox authorization demo — no seller order or shipment",
              ...(items.length?{items:paypalLineItems(items)}:{}),
              amount: {
                currency_code: "USD",
                value: (amountMinor / 100).toFixed(2),
                ...(items.length?{breakdown:{item_total:{currency_code:"USD",value:(amountMinor/100).toFixed(2)}}}:{}),
              },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: "Keus sandbox checkout",
                shipping_preference: "NO_SHIPPING",
                return_url: returnUrl,
                cancel_url: cancelUrl,
                user_action: "CONTINUE",
              },
            },
          },
        },
      }),
    getOrder: (id) => api("/v2/checkout/orders/" + encodeURIComponent(id)),
    authorize: (id, key) =>
      api("/v2/checkout/orders/" + encodeURIComponent(id) + "/authorize", {
        method: "POST",
        body: {},
        key,
      }),
    getAuthorization: (id) =>
      api("/v2/payments/authorizations/" + encodeURIComponent(id)),
    void: (id, key) =>
      api("/v2/payments/authorizations/" + encodeURIComponent(id) + "/void", {
        method: "POST",
        body: {},
        key,
      }),
  };
}
function snapshot(m) {
  return hash(
    JSON.stringify([
      m.id,
      m.run_id,
      m.amount_minor,
      m.currency,
      m.merchant_domain,
      m.payee,
      m.evidence_hash,
      ...(m.purchase_items_hash?[m.purchase_items_hash]:[]),
    ]),
  );
}
function amountMatches(amount, row) {
  return (
    amount?.currency_code === row.currency &&
    amount?.value === (row.amount_minor / 100).toFixed(2)
  );
}
function verifiedOrder(order, row) {
  if (
    order?.id !== row.order_id ||
    order.intent !== "AUTHORIZE" ||
    order.purchase_units?.length !== 1
  )
    fail("paypal_order_mismatch", 409);
  const unit = order.purchase_units[0];
  if (
    unit.reference_id !== row.id ||
    unit.custom_id !== row.id ||
    !amountMatches(unit.amount, row) ||
    unit.payments?.captures?.length
  )
    fail("paypal_order_mismatch", 409);
  if(row.purchaseItems?.length){
    // Providers may omit a response breakdown, but if they supply one it must
    // agree with the itemized, reviewed amount and currency before authorization.
    if (Object.prototype.hasOwnProperty.call(unit.amount, 'breakdown') &&
        !amountMatches(unit.amount.breakdown?.item_total, row)) fail('paypal_item_total_mismatch',409);
    const expected=paypalLineItems(row.purchaseItems);
    if(!Array.isArray(unit.items)||unit.items.length!==expected.length||expected.some((item,i)=>String(unit.items[i].quantity)!==item.quantity||unit.items[i].unit_amount?.currency_code!==item.unit_amount.currency_code||unit.items[i].unit_amount?.value!==item.unit_amount.value||unit.items[i].name!==item.name))fail('paypal_quantity_mismatch',409);
  }
  if (row.merchant_id && unit.payee?.merchant_id !== row.merchant_id)
    fail("paypal_merchant_mismatch", 409);
  return unit;
}
function verifiedAuthorization(order, row) {
  const unit = verifiedOrder(order, row);
  const list = unit.payments?.authorizations;
  if (!Array.isArray(list) || list.length !== 1)
    fail("paypal_authorization_unconfirmed", 409);
  const a = list[0];
  if (!a.id || a.status !== "CREATED" || !amountMatches(a.amount, row))
    fail("paypal_authorization_unconfirmed", 409);
  return a;
}
export function createStandardCheckoutService({
  db,
  env = process.env,
  provider = createCheckoutClient({ env }),
  now = Date.now,
} = {}) {
  const execute = (query) =>
    withWriteTransaction(db, (tx) => tx.execute(query));
  function context(c) {
    if (!c.workspaceId || !c.userId || !c.sessionToken)
      fail("authentication_required", 401);
  }
  async function mandate(tx, c, id) {
    const r = await tx.execute({
      sql: `SELECT m.*,r.agent_id,a.settings_json,a.status AS agent_status,ma.status AS approval_status,pd.allowed AS policy_allowed
 FROM mandates m JOIN runs r ON r.id=m.run_id AND r.workspace_id=m.workspace_id JOIN agents a ON a.id=r.agent_id AND a.workspace_id=m.workspace_id
 JOIN mandate_approvals ma ON ma.mandate_id=m.id JOIN policy_decisions pd ON pd.id=m.policy_decision_id
 WHERE m.id=? AND m.workspace_id=? AND r.user_id=? AND ma.user_id=?`,
      args: [id, c.workspaceId, c.userId, c.userId],
    });
    if (!r.rows[0]) fail("checkout_not_found", 404);
    const m=r.rows[0];
    try{m.purchaseItems=await readPurchaseItems(tx,c.workspaceId,m);}catch{fail('purchase_items_changed',409)}
    return m;
  }
  async function safety(tx, c, m, { fresh = true } = {}) {
    // Consent and freshness are checked first so an amount-only review from
    // before itemized reviews reports its real state (expired/unapproved)
    // instead of a currency error it could never satisfy. Nothing below is
    // weakened: an unexpired review still needs the server-written currency
    // marker. Read/void/reconcile paths do not call safety.
    if (
      m.status !== "authorized" ||
      m.approval_status !== "verified" ||
      m.policy_allowed !== 1 ||
      m.agent_status === "archived"
    )
      fail("purchase_approval_required", 409);
    if (fresh && Date.parse(m.expires_at) <= now())
      fail("purchase_approval_expired", 410);
    // Only reviews created after explicit-currency validation carry this marker.
    const proofs = await tx.execute({sql:"SELECT details_json FROM run_events WHERE workspace_id=? AND run_id=? AND event_type='purchase_currency_checked_v1'",args:[c.workspaceId,m.run_id]});
    const verified = proofs.rows.some(row => { try { const proof=JSON.parse(row.details_json); return proof.mandateId===m.id && proof.currency===m.currency && proof.itemsHash===m.purchase_items_hash && Boolean(m.purchase_items_hash); } catch { return false; } });
    if (!verified || !m.purchaseItems.length) fail('purchase_currency_unverified', 409);
    for (const item of m.purchaseItems) {
      if (!item.offerId) continue; // Manual currency was explicit in the fresh review.
      const found = await tx.execute({sql:'SELECT currency,evidence_ref FROM product_offers WHERE workspace_id=? AND id=?',args:[c.workspaceId,item.offerId]});
      if (!found.rows[0] || found.rows[0].currency !== item.currency || !hasExplicitCurrency(found.rows[0].evidence_ref, item.currency)) fail('purchase_currency_unverified', 409);
    }
    if (
      m.currency !== "USD" ||
      !Number.isSafeInteger(m.amount_minor) ||
      m.amount_minor <= 0
    )
      fail("invalid_purchase_amount", 400);
    let settings = {};
    try {
      settings = JSON.parse(m.settings_json);
    } catch {
      fail("agent_limits_invalid", 409);
    }
    const order = Number(settings.orderCap ?? 20) * 100,
      daily = Number(settings.dailyCap ?? 100) * 100;
    if (
      !Number.isSafeInteger(order) ||
      !Number.isSafeInteger(daily) ||
      order <= 0 ||
      daily <= 0
    )
      fail("agent_limits_invalid", 409);
    const p = await tx.execute({
      sql: "SELECT * FROM spend_policies WHERE workspace_id=? AND active=1 AND (agent_id=? OR agent_id IS NULL)",
      args: [c.workspaceId, m.agent_id],
    });
    let max = order,
      budget = daily;
    if (await hasUnverifiedBlockedConditions(tx, c.workspaceId, m.agent_id)) fail("blocked_conditions_unverified", 409);
    for (const policy of p.rows) {
      max = Math.min(
        max,
        Number(policy.max_per_order_minor),
        Number(policy.max_per_run_minor),
      );
      budget = Math.min(budget, Number(policy.daily_budget_minor));
      if (policy.currency !== m.currency) fail("policy_currency_changed", 409);
      let allow, blocked;
      try {
        allow = JSON.parse(policy.allowed_domains_json);
        blocked = JSON.parse(policy.blocked_payees_json);
      } catch {
        fail("policy_invalid", 409);
      }
      const domains=m.purchaseItems.length?m.purchaseItems.map(i=>i.merchantDomain):[m.merchant_domain];
      for(const rawDomain of domains){const domain=String(rawDomain).toLowerCase();const matches=x=>domain===String(x).toLowerCase()||domain.endsWith('.'+String(x).toLowerCase());
        if((allow.length&&!allow.some(matches))||blocked.some(x=>matches(x)||String(m.payee).toLowerCase()===String(x).toLowerCase()))fail('merchant_policy_changed',409);
      }
    }
    const current = iso(now());
    const day = current.slice(0, 10) + "T00:00:00.000Z";
    const sum = await tx.execute({
      sql: `SELECT COALESCE(SUM(m.amount_minor),0) AS total FROM mandates m WHERE m.workspace_id=? AND m.currency='USD' AND m.status IN ('authorized','approved','awaiting_approval','captured') AND (m.created_at>=? OR (m.expires_at>? AND m.status IN ('authorized','approved','awaiting_approval')) OR EXISTS(SELECT 1 FROM paypal_standard_checkouts c WHERE c.workspace_id=m.workspace_id AND c.mandate_id=m.id AND c.status IN ('authorizing','authorized','voiding','uncertain','void_uncertain')))`,
      args: [c.workspaceId, day, current],
    });
    if (m.amount_minor > max || Number(sum.rows[0].total) > budget)
      fail("spend_limit_exceeded", 409);
  }
  async function rowFor(c, id) {
    context(c);
    const r = await execute({
      sql: "SELECT * FROM paypal_standard_checkouts WHERE mandate_id=? AND workspace_id=? AND user_id=?",
      args: [id, c.workspaceId, c.userId],
    });
    if (!r.rows[0]) fail("checkout_not_found", 404);
    const m=await withWriteTransaction(db,tx=>mandate(tx,c,id));
    return {...r.rows[0],purchaseItems:m.purchaseItems};
  }
  async function event(tx, row, type, extra = {}) {
    const date = iso(now());
    const itemRows=await tx.execute({sql:'SELECT quantity,unit_amount_minor,line_total_minor FROM mandate_purchase_items WHERE mandate_id=? ORDER BY line_number',args:[row.mandate_id]});
    const details = JSON.stringify({
      quantities:itemRows.rows.map(i=>({quantity:i.quantity,unitAmountMinor:i.unit_amount_minor,lineTotalMinor:i.line_total_minor})),
      checkoutId: row.id,
      mandateId: row.mandate_id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      type,
      ...extra,
      at: date,
    });
    await tx.execute({
      sql: "INSERT INTO paypal_standard_checkout_events(id,checkout_id,event_type,details_json,receipt_hash,created_at) VALUES(?,?,?,?,?,?)",
      args: [
        crypto.randomUUID(),
        row.id,
        type,
        details,
        "sha256:" + hash(details),
        date,
      ],
    });
  }
  const publicRow = (r) => ({
    mandateId: r.mandate_id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    status: r.status,
    orderId: r.order_id || null,
    authorizationId: r.authorization_id || null,
    authorizedAt: r.authorized_at || null,
    items:r.purchaseItems||[],
  });
  async function list(c) {
    context(c);
    // One consistent, scoped snapshot; batching avoids a remote transaction per card.
    return withWriteTransaction(db, async tx => {
      const rows = await tx.execute({
        sql: `SELECT m.id AS mandate_id,m.amount_minor,m.currency,m.merchant_domain,m.expires_at,m.purchase_items_hash,m.run_id,c.status,c.order_id,c.authorization_id,c.authorized_at,c.expires_at AS checkout_expires_at FROM mandates m JOIN runs r ON r.id=m.run_id AND r.workspace_id=m.workspace_id JOIN mandate_approvals ma ON ma.mandate_id=m.id LEFT JOIN paypal_standard_checkouts c ON c.mandate_id=m.id WHERE m.workspace_id=? AND r.user_id=? AND ma.user_id=? AND ma.status='verified' AND m.status IN ('authorized','voided','rejected') ORDER BY m.created_at DESC LIMIT 20`,
        args: [c.workspaceId, c.userId, c.userId],
      });
      if (!rows.rows.length) return [];
      const ids=rows.rows.map(r=>r.mandate_id);
      const lines=await tx.execute({sql:`SELECT * FROM mandate_purchase_items WHERE workspace_id=? AND mandate_id IN (${ids.map(()=>'?').join(',')}) ORDER BY mandate_id,line_number`,args:[c.workspaceId,...ids]});
      const byId=new Map(ids.map(id=>[id,[]]));
      for(const line of lines.rows) byId.get(line.mandate_id)?.push(line);
      return rows.rows.map(r=>{
        let purchaseItems;try{purchaseItems=validatePurchaseItemRows(byId.get(r.mandate_id)||[],r);}catch{fail('purchase_items_changed',409)}
        const expiredPending = r.status === 'pending' && (
          (r.checkout_expires_at != null && Number(r.checkout_expires_at) <= now()) ||
          Date.parse(r.expires_at) <= now()
        );
        return {...publicRow({...r,purchaseItems}),merchantDomain:r.merchant_domain,status:expiredPending?'expired':r.status||(Date.parse(r.expires_at)>now()?'ready':'expired')};
      });
    });
  }

  async function begin(c, mandateId, origin) {
    context(c);
    configured(env);
    let u;
    try {
      u = new URL(origin);
    } catch {
      fail("secure_origin_required", 400);
    }
    if (
      u.origin !== origin ||
      !(
        u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(u.hostname))
      )
    )
      fail("secure_origin_required", 400);
    const state = crypto.randomBytes(32).toString("base64url"),
      id = "chk_" + crypto.randomBytes(12).toString("hex");
    let row;
    await withWriteTransaction(db, async (tx) => {
      const m = await mandate(tx, c, mandateId);
      await safety(tx, c, m);
      const old = await tx.execute({
        sql: "SELECT * FROM paypal_standard_checkouts WHERE mandate_id=?",
        args: [mandateId],
      });
      if (old.rows[0]) {
        row = {...old.rows[0],purchaseItems:m.purchaseItems};
        if (
          row.status === "pending" &&
          row.session_hash === hash(c.sessionToken) &&
          row.expires_at > now()
        )
          return;
        fail("checkout_already_started", 409);
      }
      const date = iso(now());
      row = {
        id,
        mandate_id: mandateId,
        amount_minor: m.amount_minor,
        currency: m.currency,
        status: "creating",
        snapshot_hash: snapshot(m),
        purchaseItems:m.purchaseItems,
        expires_at: Math.min(Date.parse(m.expires_at), now() + 1200000),
      };
      await tx.execute({
        sql: "INSERT INTO paypal_standard_checkouts(id,workspace_id,user_id,mandate_id,session_hash,state_hash,snapshot_hash,amount_minor,currency,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'creating',?,?,?)",
        args: [
          id,
          c.workspaceId,
          c.userId,
          mandateId,
          hash(c.sessionToken),
          hash(state),
          row.snapshot_hash,
          m.amount_minor,
          m.currency,
          row.expires_at,
          date,
          date,
        ],
      });
      await event(tx, row, "checkout_started");
    });
    if (row.status === "pending")
      return { ...publicRow(row), approveUrl: row.approval_url };
    try {
      const base =
        origin + "/api/commerce/paypal/checkout/return?state=" + state;
      const order = await provider.create({
        id,
        amountMinor: row.amount_minor,
        items:row.purchaseItems,
        returnUrl: base + "&outcome=approved",
        cancelUrl: base + "&outcome=cancelled",
      });
      if (
        !order.id ||
        !["CREATED", "PAYER_ACTION_REQUIRED"].includes(order.status) ||
        order.intent !== "AUTHORIZE"
      )
        fail("paypal_order_not_ready", 502);
      row.order_id = order.id;
      const unit = verifiedOrder(order, row);
      const approve = approvalUrl(
        order.links?.find((l) => ["approve", "payer-action"].includes(l.rel))
          ?.href,
      );
      const saved = await execute({
        sql: "UPDATE paypal_standard_checkouts SET status='pending',order_id=?,approval_url=?,merchant_id=?,updated_at=? WHERE id=? AND status='creating' AND expires_at>?",
        args: [
          order.id,
          approve,
          unit.payee?.merchant_id || null,
          iso(now()),
          id,
          now(),
        ],
      });
      if (saved.rowsAffected !== 1) fail("purchase_approval_expired", 410);
      return {
        ...publicRow({ ...row, status: "pending" }),
        approveUrl: approve,
      };
    } catch (e) {
      await execute({
        sql: "UPDATE paypal_standard_checkouts SET status='failed',updated_at=? WHERE id=? AND status='creating'",
        args: [iso(now()), id],
      });
      throw e;
    }
  }
  async function persistAuthorized(c, row, order) {
    const auth = verifiedAuthorization(order, row);
    await withWriteTransaction(db, async (tx) => {
      const m = await mandate(tx, c, row.mandate_id);
      if (snapshot(m) !== row.snapshot_hash) fail("purchase_changed", 409);
      const saved = await tx.execute({
        sql: "UPDATE paypal_standard_checkouts SET status='authorized',authorization_id=?,authorized_at=?,updated_at=? WHERE id=? AND status IN ('authorizing','uncertain')",
        args: [auth.id, iso(now()), iso(now()), row.id],
      });
      if (saved.rowsAffected === 1)
        await event(tx, row, "sandbox_authorized", {
          orderId: row.order_id,
          authorizationId: auth.id,
        });
    });
    return publicRow(await rowFor(c, row.mandate_id));
  }
  async function stateRow(c, state) {
    context(c);
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state))
      fail("checkout_state_invalid", 400);
    const r = await execute({
      sql: "SELECT * FROM paypal_standard_checkouts WHERE state_hash=? AND workspace_id=? AND user_id=? AND session_hash=?",
      args: [hash(state), c.workspaceId, c.userId, hash(c.sessionToken)],
    });
    if (!r.rows[0]) fail("checkout_state_invalid", 403);
    return r.rows[0];
  }
  async function result(c,mandateId) {
    const row=await rowFor(c,mandateId);
    const m=await withWriteTransaction(db,tx=>mandate(tx,c,mandateId));
    return {...publicRow(row),agentId:m.agent_id,workspaceId:c.workspaceId,
      status:row.status==='pending'&&row.expires_at<=now()?'expired':row.status,
      returnUrl:'/desktop-preview?checkout='+encodeURIComponent(row.mandate_id)};
  }
  async function returnContext(c,state) {const row=await stateRow(c,state);return result(c,row.mandate_id);}
  async function complete(c, state) {
    configured(env);
    const row = await stateRow(c, state);
    row.purchaseItems=(await rowFor(c,row.mandate_id)).purchaseItems;
    await withWriteTransaction(db, async (tx) => {
      const m = await mandate(tx, c, row.mandate_id);
      await safety(tx, c, m);
      if (snapshot(m) !== row.snapshot_hash) fail("purchase_changed", 409);
      const claim = await tx.execute({
        sql: "UPDATE paypal_standard_checkouts SET status='authorizing',updated_at=? WHERE id=? AND status='pending' AND expires_at>?",
        args: [iso(now()), row.id, now()],
      });
      if (claim.rowsAffected !== 1)
        fail("checkout_already_processed_or_expired", 409);
    });
    let requested = false;
    try {
      const order = await provider.getOrder(row.order_id);
      verifiedOrder(order, row);
      if (order.status !== "APPROVED")
        fail("paypal_buyer_approval_required", 409);
      if (row.expires_at <= now()) fail("purchase_approval_expired", 410);
      // Recheck current consent, snapshot and limits after the provider lookup.
      await withWriteTransaction(db, async (tx) => {
        const current = await mandate(tx, c, row.mandate_id);
        await safety(tx, c, current);
        if (snapshot(current) !== row.snapshot_hash)
          fail("purchase_changed", 409);
      });
      requested = true;
      const authorized = await provider.authorize(
        row.order_id,
        row.id + "-authorize",
      );
      return await persistAuthorized(c, row, authorized);
    } catch (e) {
      await execute({
        sql: "UPDATE paypal_standard_checkouts SET status=?,updated_at=? WHERE id=? AND status='authorizing'",
        args: [requested ? "uncertain" : "pending", iso(now()), row.id],
      });
      throw e;
    }
  }
  async function cancel(c, state) {
    const row = await stateRow(c, state);
    await withWriteTransaction(db, async (tx) => {
      const changed = await tx.execute({
        sql: "UPDATE paypal_standard_checkouts SET status='cancelled',updated_at=? WHERE id=? AND status='pending'",
        args: [iso(now()), row.id],
      });
      if (changed.rowsAffected !== 1) fail("checkout_already_processed", 409);
      await tx.execute({
        sql: "UPDATE mandates SET status='rejected',updated_at=? WHERE id=? AND workspace_id=? AND status='authorized'",
        args: [iso(now()), row.mandate_id, c.workspaceId],
      });
      await event(tx, row, "buyer_cancelled");
    });
    return { cancelled: true };
  }
  async function finishVoid(c, row) {
    await withWriteTransaction(db, async (tx) => {
      const changed = await tx.execute({
        sql: "UPDATE paypal_standard_checkouts SET status='voided',updated_at=? WHERE id=? AND status IN ('voiding','void_uncertain','authorized')",
        args: [iso(now()), row.id],
      });
      if (changed.rowsAffected === 1) {
        await tx.execute({
          sql: "UPDATE mandates SET status='voided',updated_at=? WHERE id=? AND workspace_id=? AND status='authorized'",
          args: [iso(now()), row.mandate_id, c.workspaceId],
        });
        await event(tx, row, "sandbox_voided", {
          authorizationId: row.authorization_id,
        });
      }
    });
    return publicRow(await rowFor(c, row.mandate_id));
  }
  async function reconcile(c, mandateId) {
    configured(env);
    const row = await rowFor(c, mandateId);
    // An interrupted return may leave a provider-approved order pending in Keus.
    // This branch only observes the existing order; it never creates or authorizes.
    if (row.status === "pending" && row.order_id) {
      const order = await provider.getOrder(row.order_id);
      const unit = verifiedOrder(order, row);
      const authorizations = unit.payments?.authorizations;
      const noAuthorization = !authorizations || (Array.isArray(authorizations) && authorizations.length === 0);
      const providerObservation = noAuthorization && order.status === "APPROVED" ? "approved_no_authorization"
        : noAuthorization && ["CREATED", "PAYER_ACTION_REQUIRED"].includes(order.status) ? "approval_not_completed"
        : "unconfirmed";
      return { ...publicRow(row), providerObservation };
    }
    if (
      ["authorizing", "voiding"].includes(row.status) &&
      now() - Date.parse(row.updated_at) < 120000
    )
      fail("checkout_processing", 409);
    if (["uncertain", "authorizing"].includes(row.status)) {
      const order = await provider.getOrder(row.order_id);
      return persistAuthorized(c, row, order);
    }
    if (["void_uncertain", "voiding", "authorized"].includes(row.status)) {
      const a = await provider.getAuthorization(row.authorization_id);
      if (a.id !== row.authorization_id || !amountMatches(a.amount, row))
        fail("paypal_authorization_mismatch", 409);
      if (a.status === "VOIDED") return finishVoid(c, row);
      if (a.status !== "CREATED") fail("paypal_authorization_unconfirmed", 409);
      if (["void_uncertain", "voiding"].includes(row.status)) {
        await execute({
          sql: "UPDATE paypal_standard_checkouts SET status='authorized',updated_at=? WHERE id=? AND status IN ('void_uncertain','voiding')",
          args: [iso(now()), row.id],
        });
        return publicRow(await rowFor(c, row.mandate_id));
      }
    }
    return publicRow(row);
  }
  async function voidHold(c, mandateId) {
    configured(env);
    const row = await rowFor(c, mandateId);
    if (row.status === "voided") return publicRow(row);
    const claim = await execute({
      sql: "UPDATE paypal_standard_checkouts SET status='voiding',updated_at=? WHERE id=? AND status='authorized'",
      args: [iso(now()), row.id],
    });
    if (claim.rowsAffected !== 1) fail("authorization_not_ready_for_void", 409);
    try {
      await provider.void(row.authorization_id, row.id + "-void");
      return await finishVoid(c, row);
    } catch (e) {
      await execute({
        sql: "UPDATE paypal_standard_checkouts SET status='void_uncertain',updated_at=? WHERE id=? AND status='voiding'",
        args: [iso(now()), row.id],
      });
      throw e;
    }
  }
  return { begin, complete, cancel, list, reconcile, voidHold, result, returnContext };
}
export const CHECKOUT_RETURN_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Returning to your Keus agent</title><style>body{background:#111113;color:#eee;font:16px/1.6 system-ui;padding:30px}main{max-width:550px;margin:10vh auto;border:1px solid #444;padding:25px;border-radius:18px}a{color:#efcd88}</style></head><body><main><h1>Returning to your agent</h1><p id="status" role="status">Checking the PayPal result securely…</p><p>Sandbox only. Capture is disabled. No seller order or shipment.</p><a id="return" href="/desktop-preview">Return to Keus</a></main><script>(async()=>{
const q=new URLSearchParams(location.search),state=q.get('state'),cancel=q.get('outcome')==='cancelled';history.replaceState(null,'',location.pathname);
async function call(action){const r=await fetch('/api/commerce/paypal/checkout/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})});const d=await r.json();if(!r.ok)throw Error('unconfirmed');return d.checkout;}
let target;
try{target=await call('return-context');if(!target?.mandateId||target.returnUrl!=='/desktop-preview?checkout='+encodeURIComponent(target.mandateId))throw Error('invalid_return');document.getElementById('return').href=target.returnUrl;}
catch{document.getElementById('status').textContent='Your signed-in checkout session could not be verified. No success is being claimed. Return to Keus and sign in to check the purchase.';return;}
try{await call(cancel?'cancel':'complete');}catch{/* Always read the actual durable status back in the agent. No success query flags. */}
try{const channel=new BroadcastChannel('keus-checkout-return');channel.postMessage({mandateId:target.mandateId});channel.close();}catch{}
location.replace(target.returnUrl);
})();</script></body></html>`;
