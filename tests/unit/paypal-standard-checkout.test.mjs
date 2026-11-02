import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { applyMigrations } from "../../apps/web/lib/db/migrate.mjs";
import { createAuthService } from "../../apps/web/lib/auth/service.mjs";
import { createWorkspaceService } from "../../apps/web/lib/workspaces/service.mjs";
import {
  createPurchaseMandate,
  authorizePurchaseMandate,
} from "../../apps/web/lib/channel3/mandate-service.mjs";
import {
  createCheckoutClient,
  createStandardCheckoutService,
} from "../../apps/web/lib/paypal/standard-checkout.mjs";
import { createServer } from "../../apps/web/server.mjs";
import { loadServerConfig } from "../../apps/web/lib/config.mjs";
const env = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "mock-client",
  PAYPAL_CLIENT_SECRET: "mock-secret",
};
async function fixture(t) {
  const db = createClient({ url: ":memory:" });
  t.after(() => db.close());
  await applyMigrations(db);
  const authService = createAuthService({ db }),
    workspaceService = createWorkspaceService({ db });
  const session = await authService.createWorkOSSession({
    providerSubject: "checkout-test",
    email: "buyer@example.test",
    emailVerified: true,
    displayName: "Checkout test",
  });
  await workspaceService.createAgent({
    userId: session.user.id,
    input: {
      name: "Shopping",
      role: "Review shopping",
      avatar: "cart",
      approvalPath: "desktop",
      color: "#32d583",
      orderCap: 100,
      dailyCap: 200,
      apps: [],
      memoryPills: [],
    },
  });
  const boot = await workspaceService.getBootstrap({ userId: session.user.id });
  const c = {
    userId: session.user.id,
    workspaceId: boot.workspace.id,
    sessionToken: session.sessionToken,
  };
  let clock = Date.now(),
    options,
    order,
    voided = false;
  const calls = [];
  const m = await createPurchaseMandate({
    db,
    ...c,
    agentId: boot.agents[0].id,
    product: {
      title: "Test product",
      merchantDomain: "shop.example",
      amountMinor: 1000,
      currency: "USD",
      evidenceHash: "sha256:" + "a".repeat(64),
    },
  });
  await authorizePurchaseMandate({
    db,
    ...c,
    mandateId: m.mandateId,
    decision: "approve",
  });
  const provider = {
    create: async (x) => {
      calls.push("create");
      options = x;
      order = {
        id: "MOCK-ORDER",
        status: "PAYER_ACTION_REQUIRED",
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: x.id,
            custom_id: x.id,
            amount: { currency_code: "USD", value: "10.00" },
            payee: { merchant_id: "MOCK-MERCHANT" },
          },
        ],
        links: [
          {
            rel: "payer-action",
            href: "https://www.sandbox.paypal.com/checkoutnow?token=MOCK-ORDER",
          },
        ],
      };
      return structuredClone(order);
    },
    getOrder: async () => {
      calls.push("getOrder");
      return structuredClone(order);
    },
    authorize: async () => {
      calls.push("authorize");
      order.status = "COMPLETED";
      order.purchase_units[0].payments = {
        authorizations: [
          {
            id: "MOCK-AUTH",
            status: "CREATED",
            amount: { currency_code: "USD", value: "10.00" },
          },
        ],
      };
      return structuredClone(order);
    },
    getAuthorization: async () => {
      calls.push("getAuthorization");
      return {
        id: "MOCK-AUTH",
        status: voided ? "VOIDED" : "CREATED",
        amount: { currency_code: "USD", value: "10.00" },
      };
    },
    void: async () => {
      calls.push("void");
      voided = true;
      return {};
    },
  };
  const service = () =>
    createStandardCheckoutService({ db, provider, env, now: () => clock });
  const begin = async () => {
    await service().begin(c, m.mandateId, "https://keus.example");
    return new URL(options.returnUrl).searchParams.get("state");
  };
  return {
    db,
    c,
    m,
    provider,
    calls,
    service,
    begin,
    approve: () => (order.status = "APPROVED"),
    order: () => order,
    advance: (n) => (clock += n),
    authService,
    workspaceService,
    session,
  };
}
test("checkout is durable, requires verified buyer approval, creates no capture, and can void", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  assert.deepEqual(f.calls, ["create"]);
  assert.equal((await f.service().list(f.c))[0].status, "pending");
  await assert.rejects(
    f.service().complete(f.c, state),
    /buyer_approval_required/,
  );
  assert(!f.calls.includes("authorize"));
  f.approve();
  const result = await f.service().complete(f.c, state);
  assert.equal(result.status, "authorized");
  assert.equal(result.authorizationId, "MOCK-AUTH");
  await assert.rejects(f.service().complete(f.c, state), /already_processed/);
  assert.equal(f.calls.filter((x) => x === "authorize").length, 1);
  assert.equal(
    (await f.service().voidHold(f.c, f.m.mandateId)).status,
    "voided",
  );
  assert.equal(
    (await f.service().voidHold(f.c, f.m.mandateId)).status,
    "voided",
  );
  assert.equal(f.calls.filter((x) => x === "void").length, 1);
  assert.equal(
    (
      await f.db.execute(
        "SELECT count(*) AS n FROM paypal_standard_checkout_events",
      )
    ).rows[0].n,
    3,
  );
  assert(!f.calls.includes("capture"));
});
test("checkout callbacks bind user, workspace, session and random state", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  f.approve();
  for (const c of [
    { ...f.c, userId: "other" },
    { ...f.c, workspaceId: "other" },
    { ...f.c, sessionToken: "other" },
  ])
    await assert.rejects(f.service().complete(c, state), /state_invalid/);
  await assert.rejects(
    f.service().complete(f.c, "x".repeat(43)),
    /state_invalid/,
  );
  await assert.rejects(
    f
      .service()
      .begin(
        { ...f.c, userId: "other" },
        f.m.mandateId,
        "https://keus.example",
      ),
    /not_found/,
  );
  await assert.rejects(
    authorizePurchaseMandate({
      db: f.db,
      ...f.c,
      userId: "other",
      mandateId: f.m.mandateId,
    }),
    /not found/,
  );
  assert.deepEqual(f.calls, ["create"]);
});
test("cancel prevents authorization and does not release an existing authorization", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  await f.service().cancel(f.c, state);
  await assert.rejects(f.service().complete(f.c, state), /approval_required/);
  assert.equal((await f.service().list(f.c))[0].status, "cancelled");
  assert.deepEqual(f.calls, ["create"]);
});
test("expired purchase cannot authorize", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  f.approve();
  f.advance(86400000);
  await assert.rejects(f.service().complete(f.c, state), /expired/);
  assert.deepEqual(f.calls, ["create"]);
});
test("order amount, intent, merchant, and reference mismatches fail closed", async (t) => {
  for (const change of [
    (o) => (o.intent = "CAPTURE"),
    (o) => (o.purchase_units[0].amount.value = "99.00"),
    (o) => (o.purchase_units[0].payee.merchant_id = "OTHER"),
    (o) => (o.purchase_units[0].reference_id = "OTHER"),
  ]) {
    const f = await fixture(t),
      state = await f.begin();
    f.approve();
    change(f.order());
    await assert.rejects(f.service().complete(f.c, state), /mismatch/);
    assert(!f.calls.includes("authorize"));
  }
});
test("changed mandate and lower agent budget prevent provider authorization", async (t) => {
  for (const kind of ["mandate", "budget"]) {
    const f = await fixture(t),
      state = await f.begin();
    f.approve();
    await f.db.execute(
      kind === "mandate"
        ? {
            sql: "UPDATE mandates SET amount_minor=1100 WHERE id=?",
            args: [f.m.mandateId],
          }
        : {
            sql: "UPDATE agents SET settings_json=json_set(settings_json,'$.orderCap',1) WHERE workspace_id=?",
            args: [f.c.workspaceId],
          },
    );
    await assert.rejects(
      f.service().complete(f.c, state),
      /purchase_changed|spend_limit_exceeded/,
    );
    assert.deepEqual(f.calls, ["create"]);
  }
});
test("uncertain authorization recovers with read-only provider lookup, never another authorization", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  f.approve();
  const actual = f.provider.authorize;
  f.provider.authorize = async () => {
    await actual();
    throw Error("network timeout");
  };
  await assert.rejects(f.service().complete(f.c, state), /timeout/);
  assert.equal((await f.service().list(f.c))[0].status, "uncertain");
  assert.equal(
    (await f.service().reconcile(f.c, f.m.mandateId)).status,
    "authorized",
  );
  assert.equal(f.calls.filter((x) => x === "authorize").length, 1);
});
test("uncertain void recovers with read-only provider lookup", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  f.approve();
  await f.service().complete(f.c, state);
  const actual = f.provider.void;
  f.provider.void = async () => {
    await actual();
    throw Error("timeout");
  };
  await assert.rejects(f.service().voidHold(f.c, f.m.mandateId), /timeout/);
  assert.equal((await f.service().list(f.c))[0].status, "void_uncertain");
  assert.equal(
    (await f.service().reconcile(f.c, f.m.mandateId)).status,
    "voided",
  );
  assert.equal(f.calls.filter((x) => x === "void").length, 1);
});
test("duplicate callbacks claim one authorization and concurrent starts create one order", async (t) => {
  const f = await fixture(t);
  const starts = await Promise.allSettled([f.begin(), f.begin()]);
  assert.equal(f.calls.filter((x) => x === "create").length, 1);
  const state = starts.find((x) => x.status === "fulfilled").value;
  f.approve();
  await Promise.allSettled([
    f.service().complete(f.c, state),
    f.service().complete(f.c, state),
  ]);
  assert.equal(f.calls.filter((x) => x === "authorize").length, 1);
});
test("live mode, missing keys and malicious approval URLs never silently simulate", async (t) => {
  const f = await fixture(t);
  for (const bad of [{ ...env, PAYPAL_ENV: "live" }, { PAYPAL_ENV: "sandbox" }])
    await assert.rejects(
      createStandardCheckoutService({
        db: f.db,
        provider: f.provider,
        env: bad,
      }).begin(f.c, f.m.mandateId, "https://keus.example"),
      /sandbox_required|not_configured/,
    );
  const orig = f.provider.create;
  f.provider.create = async (x) => {
    const o = await orig(x);
    o.links[0].href = "https://paypal.com.evil.example/";
    return o;
  };
  await assert.rejects(f.begin(), /invalid_approval_url/);
  assert(!f.calls.includes("authorize"));
});
test("HTTP checkout authentication, CSRF, argument allowlist, and callback security headers", async (t) => {
  const f = await fixture(t);
  const server = createServer({
    db: f.db,
    authService: f.authService,
    workspaceService: f.workspaceService,
    config: loadServerConfig({ TURSO_DATABASE_URL: "file:./local.db" }),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = {
    Cookie: "kues_session=" + f.c.sessionToken,
    "Content-Type": "application/json",
  };
  assert.equal(
    (await fetch(base + "/api/commerce/paypal/checkout")).status,
    401,
  );
  const list = await fetch(base + "/api/commerce/paypal/checkout", { headers });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).checkouts[0].status, "ready");
  for (const origin of [undefined, "https://evil.example"]) {
    const r = await fetch(base + "/api/commerce/paypal/checkout/begin", {
      method: "POST",
      headers: { ...headers, ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ mandateId: f.m.mandateId }),
    });
    assert.equal(r.status, 403);
  }
  const extra = await fetch(base + "/api/commerce/paypal/checkout/begin", {
    method: "POST",
    headers: { ...headers, Origin: base },
    body: JSON.stringify({ mandateId: f.m.mandateId, amountMinor: 1 }),
  });
  assert.equal(extra.status, 400);
  const callback = await fetch(
    base + "/api/commerce/paypal/checkout/return?state=bad",
  );
  assert.equal(callback.status, 200);
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  assert.equal(callback.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(base + "/standard-checkout-ui.mjs")).status, 200);
});
test("provider client uses sandbox-only Orders AUTHORIZE and stable idempotency keys", async () => {
  const calls = [];
  const client = createCheckoutClient({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify(
          url.endsWith("/token") ? { access_token: "mock" } : { id: "MOCK" },
        ),
        { status: 200 },
      );
    },
  });
  await client.create({
    id: "checkout-1",
    amountMinor: 1025,
    returnUrl: "https://keus.example/return",
    cancelUrl: "https://keus.example/cancel",
  });
  await client.authorize("MOCK", "checkout-1-authorize");
  assert.equal(JSON.parse(calls[1].options.body).intent, "AUTHORIZE");
  assert.equal(
    JSON.parse(calls[1].options.body).purchase_units[0].amount.value,
    "10.25",
  );
  assert.equal(
    calls[3].options.headers["PayPal-Request-Id"],
    "checkout-1-authorize",
  );
  assert(
    calls.every(
      (x) =>
        x.url.startsWith("https://api-m.sandbox.paypal.com/") &&
        x.options.redirect === "error",
    ),
  );
  assert.equal(client.capture, undefined);
});
test("provider lookup cannot race a spending limit reduction", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  f.approve();
  const original = f.provider.getOrder;
  f.provider.getOrder = async () => {
    await f.db.execute({
      sql: "UPDATE agents SET settings_json=json_set(settings_json,'$.dailyCap',1) WHERE workspace_id=?",
      args: [f.c.workspaceId],
    });
    return original();
  };
  await assert.rejects(
    f.service().complete(f.c, state),
    /spend_limit_exceeded/,
  );
  assert(!f.calls.includes("authorize"));
});
test("uncertain void that never reached PayPal can be retried after verification", async (t) => {
  const f = await fixture(t),
    state = await f.begin();
  f.approve();
  await f.service().complete(f.c, state);
  const original = f.provider.void;
  f.provider.void = async () => {
    throw Error("timeout before request");
  };
  await assert.rejects(f.service().voidHold(f.c, f.m.mandateId), /timeout/);
  assert.equal(
    (await f.service().reconcile(f.c, f.m.mandateId)).status,
    "authorized",
  );
  f.provider.void = original;
  assert.equal(
    (await f.service().voidHold(f.c, f.m.mandateId)).status,
    "voided",
  );
});
