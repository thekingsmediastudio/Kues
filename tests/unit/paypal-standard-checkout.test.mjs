import {paypalLineItems} from '../../apps/web/lib/commerce/purchase-items.mjs';
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
async function fixture(t, {quantity=1}={}) {
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
      quantity,
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
            items:paypalLineItems(x.items||[]),
            reference_id: x.id,
            custom_id: x.id,
            amount: { currency_code: "USD", value: (x.amountMinor/100).toFixed(2) },
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
            amount: order.purchase_units[0].amount,
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
        amount: order.purchase_units[0].amount,
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
      /purchase_changed|purchase_items_changed|spend_limit_exceeded/,
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

// Agent handoff and model-context tests use the real durable payment ledger.
import {createAiChatHistoryService} from '../../apps/web/lib/ai-providers/history.mjs';
import {checkoutNotice} from '../../apps/web/public/checkout-return-ui.mjs';
const historyFor=f=>createAiChatHistoryService({db:f.db,encryptionKey:Buffer.alloc(32,77).toString('base64')});
test('return destination comes from the owned checkout and is session-bound',async t=>{const f=await fixture(t),state=await f.begin();const r=await f.service().returnContext(f.c,state);assert.equal(r.returnUrl,'/desktop-preview?checkout='+encodeURIComponent(f.m.mandateId));assert.equal(r.workspaceId,f.c.workspaceId);assert.ok(r.agentId);assert.equal(r.status,'pending');for(const c of [{...f.c,userId:'other'},{...f.c,workspaceId:'other'},{...f.c,sessionToken:'other'}])await assert.rejects(f.service().returnContext(c,state),/state_invalid/);await assert.rejects(f.service().result({...f.c,userId:'other'},f.m.mandateId),/not_found/);assert.deepEqual(f.calls,['create']);});
test('verified authorization appears once in both agent history and next-turn model context',async t=>{const f=await fixture(t),state=await f.begin(),r=await f.service().returnContext(f.c,state),scope={...f.c,agentId:r.agentId},history=historyFor(f);assert.equal((await history.getHistory(scope)).messages.length,0);await assert.rejects(f.service().complete(f.c,state),/buyer_approval_required/);assert.equal((await history.getCheckoutContext(scope)).length,0);f.approve();await f.service().complete(f.c,state);for(let i=0;i<2;i++){const h=await history.getHistory(scope);assert.equal(h.messages.length,1);assert.match(h.messages[0].content,/Sandbox authorization successful/);assert.match(h.messages[0].content,/funds were not captured/);}assert.match((await history.getCheckoutContext(scope))[0].content,/Verified checkout update/);await assert.rejects(f.service().complete(f.c,state),/already_processed/);assert.equal((await history.getHistory(scope)).messages.length,1);for(const other of [{...scope,userId:'other'},{...scope,workspaceId:'other'},{...scope,agentId:'other'}])assert.equal((await history.getHistory(other)).messages.length,0);});
test('void facts follow authorization even at identical timestamps, and survive service recreation',async t=>{const f=await fixture(t),state=await f.begin(),r=await f.service().returnContext(f.c,state);f.approve();await f.service().complete(f.c,state);await f.service().voidHold(f.c,f.m.mandateId);const messages=(await historyFor(f).getHistory({...f.c,agentId:r.agentId})).messages;assert.equal(messages.length,2);assert.match(messages[0].content,/authorization successful/);assert.match(messages[1].content,/authorization voided/);const recent=await historyFor(f).getCheckoutContext({...f.c,agentId:r.agentId,limit:1});assert.match(recent[0].content,/authorization voided/);});
test('cancel returns to the owning agent without any success fact',async t=>{const f=await fixture(t),state=await f.begin(),r=await f.service().returnContext(f.c,state);await f.service().cancel(f.c,state);const h=await historyFor(f).getHistory({...f.c,agentId:r.agentId});assert.equal(h.messages.length,1);assert.match(h.messages[0].content,/checkout cancelled/);assert.doesNotMatch(h.messages[0].content,/authorization successful/);assert.equal((await f.service().returnContext(f.c,state)).status,'cancelled');});
test('unconfirmed and uncertain returns cannot generate success notices or history',async t=>{const f=await fixture(t),state=await f.begin(),r=await f.service().returnContext(f.c,state);f.approve();f.provider.authorize=async()=>{throw Error('timeout')};await assert.rejects(f.service().complete(f.c,state));assert.equal((await historyFor(f).getHistory({...f.c,agentId:r.agentId})).messages.length,0);for(const status of ['pending','uncertain','failed','expired'])assert.doesNotMatch(checkoutNotice(status),/authorization successful/i);});
test('return context HTTP requires same-origin authenticated ownership and excludes client redirect URLs',async t=>{const f=await fixture(t),state=await f.begin();const server=createServer({db:f.db,authService:f.authService,workspaceService:f.workspaceService,config:loadServerConfig({TURSO_DATABASE_URL:'file:./local.db'})});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port,headers={Cookie:'kues_session='+f.c.sessionToken,'Content-Type':'application/json',Origin:base};const call=body=>fetch(base+'/api/commerce/paypal/checkout/return-context',{method:'POST',headers,body:JSON.stringify(body)});const r=await call({state});assert.equal(r.status,200);assert.ok((await r.json()).checkout.agentId);assert.equal((await call({state,returnUrl:'https://evil.example'})).status,400);assert.equal((await call({state:'x'.repeat(43)})).status,403);});

test('quantity three uses a 3000-cent mandate, itemized PayPal order, and durable agent facts',async t=>{const f=await fixture(t,{quantity:3});assert.equal(f.m.product.amountMinor,3000);assert.equal(f.m.items[0].unitAmountMinor,1000);assert.equal(f.m.items[0].lineTotalMinor,3000);const state=await f.begin();assert.equal(f.order().purchase_units[0].items[0].quantity,'3');assert.equal(f.order().purchase_units[0].amount.value,'30.00');assert.equal((await f.service().list(f.c))[0].items[0].quantity,3);f.approve();const result=await f.service().complete(f.c,state);assert.equal(result.amountMinor,3000);const context=await f.service().returnContext(f.c,state);const facts=await historyFor(f).getCheckoutContext({...f.c,agentId:context.agentId});assert.match(facts[0].content,/3 × 10.00 USD = 30.00 USD/);});
test('changing quantities or unit prices after review fails closed even if the total is unchanged',async t=>{const f=await fixture(t),state=await f.begin();f.approve();await f.db.execute({sql:'UPDATE mandate_purchase_items SET quantity=2,unit_amount_minor=500 WHERE mandate_id=?',args:[f.m.mandateId]});await assert.rejects(f.service().complete(f.c,state),/purchase_items_changed/);assert.equal(f.calls.includes('authorize'),false);});
test('mismatched PayPal line quantities cannot be authorized',async t=>{const f=await fixture(t,{quantity:3}),state=await f.begin();f.approve();f.order().purchase_units[0].items[0].quantity='1';await assert.rejects(f.service().complete(f.c,state),/quantity_mismatch/);assert.equal(f.calls.includes('authorize'),false);});
test('old mandates without quantity metadata continue through the legacy amount verification',async t=>{const f=await fixture(t);await f.db.execute({sql:'DELETE FROM mandate_purchase_items WHERE mandate_id=?',args:[f.m.mandateId]});await f.db.execute({sql:'UPDATE mandates SET purchase_items_hash=NULL WHERE id=?',args:[f.m.mandateId]});const state=await f.begin();f.approve();assert.equal((await f.service().complete(f.c,state)).status,'authorized');assert.deepEqual((await f.service().list(f.c))[0].items,[]);});
test('quantity-aware client sends exact unit prices, quantities and item_total breakdown',async()=>{let payload;const client=createCheckoutClient({env,fetchImpl:async(url,opts)=>{if(url.endsWith('/token'))return new Response(JSON.stringify({access_token:'MOCK'}));payload=JSON.parse(opts.body);return new Response(JSON.stringify({id:'MOCK'}))}});await client.create({id:'test',amountMinor:999,returnUrl:'https://keus.example/return',cancelUrl:'https://keus.example/cancel',items:[{title:'Notebook',quantity:3,unitAmountMinor:333,lineTotalMinor:999,currency:'USD'}]});const unit=payload.purchase_units[0];assert.equal(unit.amount.value,'9.99');assert.equal(unit.amount.breakdown.item_total.value,'9.99');assert.equal(unit.items[0].quantity,'3');assert.equal(unit.items[0].unit_amount.value,'3.33');assert.equal(payload.intent,'AUTHORIZE');});

test('settings saves synchronize caps and a reduction blocks an already-reviewed quantity before provider creation',async t=>{
  const f=await fixture(t,{quantity:3});
  const boot=await f.workspaceService.getBootstrap({userId:f.c.userId});
  const a=boot.agents[0];
  await f.workspaceService.updateAgent({userId:f.c.userId,agentId:a.id,input:{...a.settings,name:a.name,role:a.role,avatar:a.avatar,orderCap:20,dailyCap:100}});
  const p=(await f.db.execute({sql:'SELECT max_per_order_minor,daily_budget_minor FROM spend_policies WHERE agent_id=?',args:[a.id]})).rows[0];
  assert.equal(p.max_per_order_minor,2000);assert.equal(p.daily_budget_minor,10000);
  await assert.rejects(f.begin(),/spend_limit_exceeded/);assert.deepEqual(f.calls,[]);
});

test('settings cap reduction after PayPal order creation prevents authorization',async t=>{
  const f=await fixture(t,{quantity:3});const state=await f.begin();
  const boot=await f.workspaceService.getBootstrap({userId:f.c.userId});const a=boot.agents[0];
  await f.workspaceService.updateAgent({userId:f.c.userId,agentId:a.id,input:{...a.settings,name:a.name,role:a.role,avatar:a.avatar,orderCap:20,dailyCap:100}});
  f.approve();await assert.rejects(f.service().complete(f.c,state),/spend_limit_exceeded/);assert(!f.calls.includes('authorize'));
});


test('provider item total and item unit amounts fail closed when inconsistent',async t=>{
 for(const mutate of [o=>{o.purchase_units[0].amount.breakdown={item_total:{currency_code:'USD',value:'99.00'}}},o=>{o.purchase_units[0].amount.breakdown={item_total:{currency_code:'EUR',value:'30.00'}}},o=>{o.purchase_units[0].amount.breakdown={}},o=>{o.purchase_units[0].items[0].unit_amount.value='9.00'},o=>{o.purchase_units[0].items[0].unit_amount.currency_code='EUR'},o=>{o.purchase_units[0].amount.currency_code='EUR'}]){const f=await fixture(t,{quantity:3}),state=await f.begin();f.approve();mutate(f.order());await assert.rejects(f.service().complete(f.c,state),/mismatch/);assert.equal(f.calls.includes('authorize'),false)}
});
test('provider matching item total or omitted breakdown remains supported',async t=>{for(const withBreakdown of [false,true]){const f=await fixture(t,{quantity:3}),state=await f.begin();f.approve();if(withBreakdown)f.order().purchase_units[0].amount.breakdown={item_total:{currency_code:'USD',value:'30.00'}};assert.equal((await f.service().complete(f.c,state)).status,'authorized');assert.equal(f.calls.filter(x=>x==='authorize').length,1)}});
