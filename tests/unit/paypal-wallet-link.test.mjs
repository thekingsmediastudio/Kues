import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { applyMigrations } from "../../apps/web/lib/db/migrate.mjs";
import { createAuthService } from "../../apps/web/lib/auth/service.mjs";
import { createWorkspaceService } from "../../apps/web/lib/workspaces/service.mjs";
import {
  createWalletLinkService,
  createVaultClient,
  sandboxApprovalUrl,
} from "../../apps/web/lib/paypal/wallet-link.mjs";
const env = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "test-client",
  PAYPAL_CLIENT_SECRET: "test-secret",
};
async function fixture(t) {
  const db = createClient({ url: ":memory:" });
  t.after(() => db.close());
  await applyMigrations(db);
  const auth = createAuthService({ db }),
    ws = createWorkspaceService({ db });
  const session = await auth.createWorkOSSession({
    providerSubject: "wallet-user",
    email: "wallet@example.test",
    emailVerified: true,
    displayName: "Wallet test",
  });
  const boot = await ws.getBootstrap({ userId: session.user.id });
  const c = {
    workspaceId: boot.workspace.id,
    userId: session.user.id,
    sessionToken: session.sessionToken,
  };
  let options,
    clock = Date.now();
  const calls = [];
  const provider = {
    setup: async (x) => {
      options = x;
      calls.push("setup");
      return {
        id: "SETUP-REAL-FIXTURE",
        status: "PAYER_ACTION_REQUIRED",
        links: [
          {
            rel: "approve",
            href: "https://www.sandbox.paypal.com/agreements/approve?test=1",
          },
        ],
      };
    },
    inspect: async (id) => {
      calls.push("inspect");
      return { id, status: "APPROVED" };
    },
    exchange: async () => {
      calls.push("exchange");
      return {
        id: "PAYPAL-VAULT-FIXTURE",
        payment_source: {
          paypal: {
            email_address: "buyer@example.test",
            account_id: "PAYER-FIXTURE",
          },
        },
      };
    },
  };
  const service = () =>
    createWalletLinkService({ db, env, provider, now: () => clock });
  const begin = async () => {
    await service().begin(c, "https://keus.example");
    return new URL(options.returnUrl).searchParams.get("state");
  };
  return {
    db,
    c,
    provider,
    calls,
    service,
    begin,
    advance: (n) => {
      clock += n;
    },
  };
}
test("real-link flow persists only provider-confirmed data, masks token, survives service recreation and rejects replay", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  assert.equal((await f.service().status(f.c)).linked, false);
  const result = await f.service().complete(f.c, state);
  assert.equal(result.linked, true);
  assert.equal(result.wallet.payerEmail, "buyer@example.test");
  assert(!JSON.stringify(result).includes("PAYPAL-VAULT-FIXTURE"));
  assert.deepEqual(f.calls, ["setup", "inspect", "exchange"]);
  await assert.rejects(f.service().complete(f.c, state), /invalid_or_expired/);
});
test("wallet callbacks bind user, workspace, session and state", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  for (const c of [
    { ...f.c, userId: "other" },
    { ...f.c, workspaceId: "other" },
    { ...f.c, sessionToken: "other" },
  ])
    await assert.rejects(f.service().complete(c, state), /invalid_or_expired/);
  await assert.rejects(
    f.service().complete(f.c, "x".repeat(43)),
    /invalid_or_expired/,
  );
  assert.deepEqual(f.calls, ["setup"]);
});
test("expiry and cancellation cannot create a wallet", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  await f.service().cancel(f.c, state);
  await assert.rejects(f.service().complete(f.c, state), /invalid_or_expired/);
  const next = await f.begin();
  f.advance(1200001);
  await assert.rejects(f.service().complete(f.c, next), /invalid_or_expired/);
  assert.equal((await f.service().status(f.c)).linked, false);
});
test("unapproved provider status and failures never silently simulate", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  f.provider.inspect = async (id) => ({ id, status: "PAYER_ACTION_REQUIRED" });
  await assert.rejects(
    f.service().complete(f.c, state),
    /approval_not_confirmed/,
  );
  assert(!f.calls.includes("exchange"));
  assert.equal((await f.service().status(f.c)).linked, false);
  const next = await f.begin();
  f.provider.inspect = async () => {
    throw Error("provider unavailable");
  };
  await assert.rejects(f.service().complete(f.c, next), /provider unavailable/);
  assert.equal((await f.service().status(f.c)).linked, false);
});
test("only one concurrent completion claims a setup and unlink cancels an in-flight save", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  let release, started;
  const ready = new Promise((r) => (started = r));
  f.provider.inspect = async (id) => {
    started();
    await new Promise((r) => (release = r));
    return { id, status: "APPROVED" };
  };
  const first = f.service().complete(f.c, state);
  await ready;
  await assert.rejects(f.service().complete(f.c, state), /invalid_or_expired/);
  await f.service().unlink(f.c);
  release();
  await assert.rejects(first, /invalid_or_expired/);
  assert.equal((await f.service().status(f.c)).linked, false);
});
test("sandbox config, callback origins, rate caps and provider redirect allowlist fail closed", async (t) => {
  const f = await fixture(t);
  for (const bad of [
    { ...env, PAYPAL_ENV: "live" },
    { ...env, PAYPAL_ENV: "" },
    { PAYPAL_ENV: "sandbox" },
  ])
    await assert.rejects(
      createWalletLinkService({
        db: f.db,
        env: bad,
        provider: f.provider,
      }).begin(f.c, "https://keus.example"),
      /sandbox_required|not_configured/,
    );
  await assert.rejects(
    f.service().begin(f.c, "http://public.example"),
    /secure_origin/,
  );
  for (const url of [
    "https://www.paypal.com/approve",
    "https://sandbox.paypal.com.evil.test/a",
    "javascript:alert(1)",
    "https://u:p@sandbox.paypal.com/a",
  ])
    assert.throws(() => sandboxApprovalUrl(url), /approval_url_invalid/);
  for (let i = 0; i < 5; i++) await f.begin();
  await assert.rejects(f.begin(), /rate_limited/);
});
test("malformed provider tokens cannot be persisted", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  f.provider.exchange = async () => ({
    id: "VAULT-SANDBOX-fake",
    payment_source: { paypal: {} },
  });
  await assert.rejects(f.service().complete(f.c, state), /not_verified/);
  assert.equal((await f.service().status(f.c)).linked, false);
});
test("vault client uses sandbox only, approved-token inspection and stable exchange idempotency keys", async () => {
  const seen = [];
  const client = createVaultClient({
    env,
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return {
        ok: true,
        json: async () =>
          url.endsWith("/token")
            ? { access_token: "secret-access" }
            : { id: "x" },
      };
    },
  });
  await client.inspect("SETUP/x");
  await client.exchange("SETUP/x", "fixed-exchange-id");
  assert(
    seen.every((x) => x.url.startsWith("https://api-m.sandbox.paypal.com/")),
  );
  assert(seen[1].url.endsWith("SETUP%2Fx"));
  assert.equal(
    seen[3].options.headers["PayPal-Request-Id"],
    "fixed-exchange-id",
  );
  assert.equal(
    JSON.parse(seen[3].options.body).payment_source.token.type,
    "SETUP_TOKEN",
  );
  assert(seen.every((x) => x.options.redirect === "error" && x.options.signal));
});
