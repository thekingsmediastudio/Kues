import crypto from "node:crypto";
import { withWriteTransaction } from "../db/transaction.mjs";
const BASE = "https://api-m.sandbox.paypal.com";
const hash = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
export class WalletLinkError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status) => {
  throw new WalletLinkError(code, status);
};
function sandbox(env) {
  if (env.PAYPAL_ENV !== "sandbox") fail("paypal_sandbox_required", 503);
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET)
    fail("paypal_not_configured", 503);
}
export function sandboxApprovalUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("paypal_approval_url_invalid", 502);
  }
  if (
    u.protocol !== "https:" ||
    !["www.sandbox.paypal.com", "sandbox.paypal.com"].includes(u.hostname) ||
    u.port ||
    u.username ||
    u.password
  )
    fail("paypal_approval_url_invalid", 502);
  return u.href;
}
export function createVaultClient({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  async function json(url, options) {
    let res;
    try {
      res = await fetchImpl(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      fail("paypal_unavailable", 502);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      fail("paypal_invalid_response", 502);
    }
    if (!res.ok) fail("paypal_request_failed", 502);
    return data;
  }
  async function api(path, { method = "GET", body, requestId } = {}) {
    sandbox(env);
    const auth = await json(BASE + "/v1/oauth2/token", {
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
    if (!auth.access_token) fail("paypal_auth_failed", 502);
    return json(BASE + path, {
      method,
      headers: {
        Authorization: "Bearer " + auth.access_token,
        "Content-Type": "application/json",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  return {
    setup: ({ returnUrl, cancelUrl, requestId }) =>
      api("/v3/vault/setup-tokens", {
        method: "POST",
        requestId,
        body: {
          payment_source: {
            paypal: {
              description:
                "Keus sandbox wallet. Purchases require separate approval",
              usage_pattern: "IMMEDIATE",
              usage_type: "MERCHANT",
              customer_type: "CONSUMER",
              permit_multiple_payment_tokens: false,
              experience_context: {
                brand_name: "Keus",
                return_url: returnUrl,
                cancel_url: cancelUrl,
                user_action: "CONTINUE",
              },
            },
          },
        },
      }),
    inspect: (id) => api("/v3/vault/setup-tokens/" + encodeURIComponent(id)),
    exchange: (id, requestId) =>
      api("/v3/vault/payment-tokens", {
        method: "POST",
        requestId,
        body: { payment_source: { token: { id, type: "SETUP_TOKEN" } } },
      }),
  };
}
export function createWalletLinkService({
  db,
  env = process.env,
  provider = createVaultClient({ env }),
  now = Date.now,
} = {}) {
  const scopeArgs = (c) => [c.workspaceId, c.userId, hash(c.sessionToken)];
  function scope(c) {
    if (!c.workspaceId || !c.userId || !c.sessionToken)
      fail("authentication_required", 401);
  }
  async function status(c) {
    scope(c);
    const r = await db.execute({
      sql: "SELECT payer_email,vault_token_id,created_at,verified_at FROM workspace_wallets WHERE workspace_id=? AND provider='paypal_sandbox' AND status='active'",
      args: [c.workspaceId],
    });
    const w = r.rows[0];
    return {
      linked: Boolean(w?.verified_at),
      needsRelink: Boolean(w && !w.verified_at),
      wallet: w?.verified_at
        ? {
            payerEmail: w.payer_email,
            maskedVaultId: "****" + String(w.vault_token_id).slice(-4),
            createdAt: w.created_at,
            verifiedAt: w.verified_at,
          }
        : null,
    };
  }
  async function begin(c, origin) {
    scope(c);
    sandbox(env);
    const u = new URL(origin);
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
      key = hash(state),
      time = now();
    await withWriteTransaction(db, async (tx) => {
      await tx.execute({
        sql: "DELETE FROM paypal_wallet_link_attempts WHERE expires_at<?",
        args: [time - 86400000],
      });
      const r = await tx.execute({
        sql: "SELECT status,expires_at FROM paypal_wallet_link_attempts WHERE workspace_id=? AND created_at>?",
        args: [c.workspaceId, time - 900000],
      });
      if (r.rows.length >= 5) fail("wallet_setup_rate_limited", 429);
      if (
        r.rows.some(
          (x) =>
            ["creating", "processing"].includes(x.status) &&
            x.expires_at > time,
        )
      )
        fail("wallet_setup_in_progress", 409);
      await tx.execute({
        sql: "UPDATE paypal_wallet_link_attempts SET status='cancelled' WHERE workspace_id=? AND status='pending'",
        args: [c.workspaceId],
      });
      await tx.execute({
        sql: "INSERT INTO paypal_wallet_link_attempts(state_hash,workspace_id,user_id,session_hash,status,created_at,expires_at) VALUES(?,?,?,?,'creating',?,?)",
        args: [key, ...scopeArgs(c), time, time + 1200000],
      });
    });
    try {
      const base =
        origin +
        "/api/commerce/paypal/wallet/return?state=" +
        encodeURIComponent(state);
      const data = await provider.setup({
        returnUrl: base + "&outcome=approved",
        cancelUrl: base + "&outcome=cancelled",
        requestId: key.slice(0, 32) + "-s",
      });
      if (!data.id || data.status !== "PAYER_ACTION_REQUIRED")
        fail("paypal_setup_not_ready", 502);
      const approveUrl = sandboxApprovalUrl(
        data.links?.find((x) => x.rel === "approve")?.href,
      );
      const r = await db.execute({
        sql: "UPDATE paypal_wallet_link_attempts SET status='pending',setup_token_id=? WHERE state_hash=? AND status='creating' AND expires_at>?",
        args: [data.id, key, now()],
      });
      if (r.rowsAffected !== 1) fail("wallet_setup_expired", 409);
      return { approveUrl };
    } catch (e) {
      await db.execute({
        sql: "UPDATE paypal_wallet_link_attempts SET status='failed' WHERE state_hash=? AND status='creating'",
        args: [key],
      });
      throw e;
    }
  }
  async function complete(c, state) {
    scope(c);
    sandbox(env);
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state))
      fail("wallet_setup_invalid", 400);
    const key = hash(state);
    let attempt;
    await withWriteTransaction(db, async (tx) => {
      const r = await tx.execute({
        sql: "SELECT * FROM paypal_wallet_link_attempts WHERE state_hash=? AND workspace_id=? AND user_id=? AND session_hash=?",
        args: [key, ...scopeArgs(c)],
      });
      attempt = r.rows[0];
      if (
        !attempt ||
        attempt.status !== "pending" ||
        attempt.expires_at <= now()
      )
        fail("wallet_setup_invalid_or_expired", 409);
      await tx.execute({
        sql: "UPDATE paypal_wallet_link_attempts SET status='processing' WHERE state_hash=?",
        args: [key],
      });
    });
    try {
      const setup = await provider.inspect(attempt.setup_token_id);
      if (setup.id !== attempt.setup_token_id || setup.status !== "APPROVED")
        fail("paypal_approval_not_confirmed", 409);
      const token = await provider.exchange(
        attempt.setup_token_id,
        key.slice(0, 32) + "-p",
      );
      if (
        typeof token.id !== "string" ||
        !token.id ||
        !token.payment_source?.paypal ||
        /^VAULT-SANDBOX-/.test(token.id)
      )
        fail("paypal_wallet_not_verified", 502);
      const payer = token.payment_source.paypal;
      const time = now(),
        date = new Date(time).toISOString();
      await withWriteTransaction(db, async (tx) => {
        const claim = await tx.execute({
          sql: "UPDATE paypal_wallet_link_attempts SET status='completed' WHERE state_hash=? AND status='processing' AND expires_at>?",
          args: [key, time],
        });
        if (claim.rowsAffected !== 1)
          fail("wallet_setup_invalid_or_expired", 409);
        await tx.execute({
          sql: "INSERT INTO workspace_wallets(id,workspace_id,user_id,provider,vault_token_id,payer_email,payer_id,status,created_at,updated_at,verified_at) VALUES(?,?,?,'paypal_sandbox',?,?,?,'active',?,?,?) ON CONFLICT(workspace_id,provider) DO UPDATE SET user_id=excluded.user_id,vault_token_id=excluded.vault_token_id,payer_email=excluded.payer_email,payer_id=excluded.payer_id,status='active',updated_at=excluded.updated_at,verified_at=excluded.verified_at",
          args: [
            "wlt_" + crypto.randomUUID(),
            c.workspaceId,
            c.userId,
            token.id,
            payer.email_address || null,
            payer.account_id || payer.payer_id || null,
            date,
            date,
            date,
          ],
        });
      });
      return status(c);
    } catch (e) {
      await db.execute({
        sql: "UPDATE paypal_wallet_link_attempts SET status='failed' WHERE state_hash=? AND status='processing'",
        args: [key],
      });
      throw e;
    }
  }
  async function cancel(c, state) {
    scope(c);
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state))
      fail("wallet_setup_invalid", 400);
    await db.execute({
      sql: "UPDATE paypal_wallet_link_attempts SET status='cancelled' WHERE state_hash=? AND workspace_id=? AND user_id=? AND session_hash=? AND status IN ('creating','pending')",
      args: [hash(state), ...scopeArgs(c)],
    });
    return { cancelled: true };
  }
  async function unlink(c) {
    scope(c);
    await withWriteTransaction(db, async (tx) => {
      await tx.execute({
        sql: "UPDATE paypal_wallet_link_attempts SET status='cancelled' WHERE workspace_id=? AND status IN ('creating','pending','processing')",
        args: [c.workspaceId],
      });
      await tx.execute({
        sql: "UPDATE workspace_wallets SET status='revoked',verified_at=NULL,updated_at=? WHERE workspace_id=? AND provider='paypal_sandbox'",
        args: [new Date(now()).toISOString(), c.workspaceId],
      });
    });
    return { unlinked: true };
  }
  return { begin, complete, cancel, status, unlink };
}
export const WALLET_RETURN_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayPal sandbox wallet: Keus</title><style>body{background:#111113;color:#f3f3f5;font:16px/1.6 system-ui;margin:0;padding:40px}main{max-width:540px;margin:10vh auto;padding:28px;border:1px solid #444;border-radius:18px}a{color:#ebc875}</style></head><body><main><h1>PayPal sandbox wallet</h1><p id="status" role="status">Checking PayPal approval…</p><p>You can close this tab and return to Keus after this check.</p><a href="/workspace">Return to Keus</a></main><script>(async()=>{const q=new URLSearchParams(location.search),state=q.get('state'),cancel=q.get('outcome')==='cancelled';history.replaceState(null,'',location.pathname);try{const r=await fetch('/api/commerce/paypal/wallet/'+(cancel?'cancel':'complete'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})});const d=await r.json();if(!r.ok)throw Error();document.getElementById('status').textContent=cancel?'Linking cancelled. No new wallet was linked.':d.linked?'Your PayPal sandbox wallet is linked. No purchase or payment was authorized.':'Linking was not confirmed. Return to Keus and try again.'}catch{document.getElementById('status').textContent='Unable to confirm linking. Sign in to the same Keus account and start again from PayPal wallet settings.'}})();</script></body></html>`;
