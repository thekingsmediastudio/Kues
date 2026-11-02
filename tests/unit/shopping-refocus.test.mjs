import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { reviewShoppingBasket } from "../../apps/web/lib/ai-agent/shopping-basket.mjs";
import { prepareWorkspaceToolCall } from "../../apps/web/lib/ai-agent/workspace-tools.mjs";
import { buildShoppingRequest } from "../../apps/web/public/shopping-brief-ui.mjs";
const bootstrap = {
  workspace: { id: "w", status: "active", role: "owner" },
  agents: [],
};
const prep = (args) =>
  prepareWorkspaceToolCall(
    { name: "review_basket", arguments: args },
    bootstrap,
  );
test("shopping briefs preserve user currency and require explicit shopping action", () => {
  const text = buildShoppingRequest({
    items: "2 headphones\n1 keyboard",
    budget: "250000",
    currency: "ngn",
    destination: "Lagos, Nigeria",
  });
  assert.match(text, /250000 NGN/);
  assert.match(text, /not permission to buy/);
  assert.match(text, /Do not create a mandate/);
  assert.doesNotMatch(text, /USD/);
  assert.throws(() => buildShoppingRequest({ items: "" }));
  assert.throws(() => buildShoppingRequest({ items: "chair", budget: "100" }));
  assert.throws(() =>
    buildShoppingRequest({ items: "chair", budget: "1,000", currency: "USD" }),
  );
  assert.throws(() =>
    buildShoppingRequest({ items: Array(9).fill("chair").join("\n") }),
  );
});
test("basket tool validates quantities and duplicates; catalog does not reinterpret NGN as USD", () => {
  assert.equal(
    prep({ items: [{ offerId: "offer-a" }], budgetMinor: 10000 }).kind,
    "review_basket",
  );
  for (const items of [
    [{ offerId: "a", quantity: 0 }],
    [{ offerId: "a", quantity: 21 }],
    [{ offerId: "a" }, { offerId: "a" }],
    [{ offerId: "a", amountMinor: 1 }],
  ])
    assert.throws(() => prep({ items }));
  assert.throws(() =>
    prepareWorkspaceToolCall(
      {
        name: "search_products",
        arguments: { query: "chair", currency: "NGN" },
      },
      bootstrap,
    ),
  );
});
async function setup(t) {
  const db = createClient({ url: "file::memory:" });
  t.after(() => db.close());
  await db.executeMultiple(
    "CREATE TABLE runs(id TEXT,workspace_id TEXT,user_id TEXT,agent_id TEXT,mode TEXT);CREATE TABLE product_offers(id TEXT,workspace_id TEXT,run_id TEXT,title TEXT,amount_minor INTEGER,currency TEXT,availability TEXT,observed_at TEXT);",
  );
  await db.execute("INSERT INTO runs VALUES('run','w','u','a','live_search')");
  for (const [id, title, amount] of [
    ["offer-a", "Headphones", 5000],
    ["offer-b", "Keyboard", 3000],
  ])
    await db.execute({
      sql: "INSERT INTO product_offers VALUES(?,?,?,?,?,?,?,?)",
      args: [
        id,
        "w",
        "run",
        title,
        amount,
        "USD",
        "in_stock",
        new Date().toISOString(),
      ],
    });
  return {
    db,
    workspaceId: "w",
    userId: "u",
    agentId: "a",
    items: [
      { offerId: "offer-a", quantity: 2 },
      { offerId: "offer-b", quantity: 1 },
    ],
    budgetMinor: 12000,
  };
}
test("basket subtotal uses stored prices and quantities, not model prices; no write tables needed", async (t) => {
  const options = await setup(t),
    result = await reviewShoppingBasket(options);
  assert.match(result, /130\.00/);
  assert.match(result, /Over the stated budget by \$10\.00/);
  assert.match(result, /Shipping, tax/);
  assert.match(
    result,
    /No order, mandate, reservation or payment hold was created/,
  );
});
test("basket offers are scoped to exact user, workspace and agent", async (t) => {
  const o = await setup(t);
  for (const other of [
    { userId: "other" },
    { workspaceId: "other" },
    { agentId: "other" },
  ]) {
    const result = await reviewShoppingBasket({ ...o, ...other });
    assert.match(result, /unavailable/);
    assert.doesNotMatch(result, /Headphones/);
  }
});
test("mixed currencies fail closed and stale/sample offers are not presented as live", async (t) => {
  const o = await setup(t);
  await o.db.execute(
    "UPDATE product_offers SET currency='NGN' WHERE id='offer-a'",
  );
  assert.match(await reviewShoppingBasket(o), /cannot be totalled/);
  await o.db.execute(
    "UPDATE product_offers SET currency='USD',availability='out_of_stock',observed_at='2000-01-01T00:00:00Z'",
  );
  await o.db.execute("UPDATE runs SET mode='demo'");
  const result = await reviewShoppingBasket(o);
  assert.match(result, /stale or unverified/);
  assert.match(result, /Sample\/preview/);
  assert.match(result, /confirm stock/);
});
