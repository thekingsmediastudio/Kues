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
        r.status === 401
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
    create: ({ id, amountMinor, returnUrl, cancelUrl }) =>
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
              amount: {
                currency_code: "USD",
                value: (amountMinor / 100).toFixed(2),
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
    return r.rows[0];
  }
  async function safety(tx, c, m, { fresh = true } = {}) {
    if (
      m.status !== "authorized" ||
      m.approval_status !== "verified" ||
      m.policy_allowed !== 1 ||
      m.agent_status === "archived"
    )
      fail("purchase_approval_required", 409);
    if (fresh && Date.parse(m.expires_at) <= now())
      fail("purchase_approval_expired", 410);
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
      const domain = String(m.merchant_domain).toLowerCase();
      const matches = (x) =>
        domain === String(x).toLowerCase() ||
        domain.endsWith("." + String(x).toLowerCase());
      if (
        (allow.length && !allow.some(matches)) ||
        blocked.some(
          (x) =>
            matches(x) ||
            String(m.payee).toLowerCase() === String(x).toLowerCase(),
        )
      )
        fail("merchant_policy_changed", 409);
    }
    const day = iso(now()).slice(0, 10) + "T00:00:00.000Z";
    const sum = await tx.execute({
      sql: `SELECT COALESCE(SUM(m.amount_minor),0) AS total FROM mandates m WHERE m.workspace_id=? AND m.currency='USD' AND m.status IN ('authorized','approved','awaiting_approval','captured') AND (m.created_at>=? OR EXISTS(SELECT 1 FROM paypal_standard_checkouts c WHERE c.mandate_id=m.id AND c.status IN ('authorizing','authorized','voiding','uncertain','void_uncertain')))`,
      args: [c.workspaceId, day],
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
    return r.rows[0];
  }
  async function event(tx, row, type, extra = {}) {
    const date = iso(now());
    const details = JSON.stringify({
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
  });
  async function list(c) {
    context(c);
    const rows = await execute({
      sql: `SELECT m.id AS mandate_id,m.amount_minor,m.currency,m.merchant_domain,m.expires_at,c.status,c.order_id,c.authorization_id,c.authorized_at FROM mandates m JOIN runs r ON r.id=m.run_id AND r.workspace_id=m.workspace_id JOIN mandate_approvals ma ON ma.mandate_id=m.id LEFT JOIN paypal_standard_checkouts c ON c.mandate_id=m.id WHERE m.workspace_id=? AND r.user_id=? AND ma.user_id=? AND ma.status='verified' AND m.status IN ('authorized','voided','rejected') ORDER BY m.created_at DESC LIMIT 20`,
      args: [c.workspaceId, c.userId, c.userId],
    });
    return rows.rows.map((r) => ({
      ...publicRow(r),
      merchantDomain: r.merchant_domain,
      status:
        r.status || (Date.parse(r.expires_at) > now() ? "ready" : "expired"),
    }));
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
        row = old.rows[0];
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
  async function complete(c, state) {
    configured(env);
    const row = await stateRow(c, state);
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
  return { begin, complete, cancel, list, reconcile, voidHold };
}
export const CHECKOUT_RETURN_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keus sandbox checkout</title><style>body{background:#111113;color:#eee;font:16px/1.6 system-ui;padding:30px}main{max-width:550px;margin:10vh auto;border:1px solid #444;padding:25px;border-radius:18px}a{color:#efcd88}</style></head><body><main><h1>PayPal sandbox checkout</h1><p id="status" role="status">Verifying your checkout…</p><p>No real seller order or shipment. Capture is disabled.</p><a href="/desktop-preview">Return to Keus</a></main><script>(async()=>{const q=new URLSearchParams(location.search),state=q.get('state'),cancel=q.get('outcome')==='cancelled';history.replaceState(null,'',location.pathname);try{const r=await fetch('/api/commerce/paypal/checkout/'+(cancel?'cancel':'complete'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})});const d=await r.json();if(!r.ok)throw Error();document.getElementById('status').textContent=cancel?'Checkout cancelled. No sandbox authorization was requested.':d.checkout?.status==='authorized'?'Sandbox authorization confirmed. Funds were not captured. Return to Keus to view or void the hold.':'Checkout was not confirmed. Refresh its status in Keus.'}catch{document.getElementById('status').textContent='Checkout could not be confirmed. Return to Keus and check its status before trying again. An uncertain authorization must not be treated as a failure.'}})();</script></body></html>`;
