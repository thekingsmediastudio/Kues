import { hasExplicitCurrency } from "../channel3/currency-evidence.mjs";
import { escapeMarkdown } from "./workspace-tools.mjs";
import { withReadTransaction } from "../db/transaction.mjs";
export async function reviewShoppingBasket({
  db,
  workspaceId,
  userId,
  agentId,
  items,
  budgetMinor,
  now = Date.now(),
}) {
  if (!db)
    return "Basket review needs saved catalog offers. Search for products first; nothing has been purchased.";
  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > 8 ||
    new Set(items.map((i) => i.offerId)).size !== items.length ||
    items.some(
      (i) =>
        typeof i.offerId !== "string" ||
        !i.offerId ||
        i.offerId.length > 128 ||
        !Number.isSafeInteger(i.quantity) ||
        i.quantity < 1 ||
        i.quantity > 20,
    ) ||
    (budgetMinor !== undefined &&
      (!Number.isSafeInteger(budgetMinor) ||
        budgetMinor <= 0 ||
        budgetMinor > 100000000))
  )
    return "The basket selection is invalid. Choose up to eight distinct saved offers with quantities from 1 to 20.";
  const rows = await withReadTransaction(db, async (tx) => {
    const found = [];
    for (const item of items) {
      const r = await tx.execute({
        sql: `SELECT o.*, r.mode FROM product_offers o JOIN runs r ON r.id=o.run_id AND r.workspace_id=o.workspace_id WHERE o.id=? AND o.workspace_id=? AND r.user_id=? AND r.agent_id=?`,
        args: [item.offerId, workspaceId, userId, agentId],
      });
      if (!r.rows[0]) return null;
      found.push({ ...r.rows[0], quantity: item.quantity });
    }
    return found;
  });
  if (!rows)
    return "One or more offers are unavailable in this agent’s saved search results. Search again before reviewing the basket. Nothing was purchased.";
  if (
    rows.some(
      (r) =>
        !hasExplicitCurrency(r.evidence_ref, r.currency) ||
        r.currency !== "USD" ||
        !Number.isSafeInteger(Number(r.amount_minor)) ||
        Number(r.amount_minor) <= 0,
    )
  )
    return "These offers cannot be totalled safely in USD. Mixed currencies are not converted automatically. Nothing was purchased.";
  let total = 0;
  const warnings = [];
  const lines = [
    "## Basket review, not an order",
    "",
    "| Item | Qty | Unit price | Subtotal |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const r of rows) {
    const amount = Number(r.amount_minor),
      subtotal = amount * r.quantity;
    total += subtotal;
    if (!Number.isSafeInteger(total))
      return "The basket amount exceeds safe calculation limits. Nothing was purchased.";
    lines.push(
      `| ${escapeMarkdown(String(r.title).replace(/[\r\n]/g, " "))} | ${r.quantity} | $${(amount / 100).toFixed(2)} | $${(subtotal / 100).toFixed(2)} |`,
    );
    if (r.availability !== "in_stock")
      warnings.push(
        `${r.title}: availability is ${r.availability || "unknown"}; confirm stock.`,
      );
    const age = now - Date.parse(r.observed_at);
    if (!Number.isFinite(age) || age > 24 * 60 * 60 * 1000 || age < 0)
      warnings.push(
        `${r.title}: price evidence is stale or unverified; search again.`,
      );
  }
  lines.push(
    "",
    `**Item subtotal: $${(total / 100).toFixed(2)} USD.** Shipping, tax, import duties and delivery dates are not included or verified.`,
  );
  if (budgetMinor !== undefined)
    lines.push(
      total > budgetMinor
        ? `**Over the stated budget by $${((total - budgetMinor) / 100).toFixed(2)} USD**, before shipping and tax.`
        : `$${((budgetMinor - total) / 100).toFixed(2)} USD remains against the stated budget before shipping and tax. This is not confirmation that the delivered basket fits your budget.`,
    );
  if (rows.some((r) => r.mode !== "live_search"))
    lines.push(
      "**Sample/preview offers are included. This is not a verified live basket.**",
    );
  if (warnings.length)
    lines.push("", ...warnings.map((x) => "- " + escapeMarkdown(x)));
  lines.push(
    "",
    "Evidence: " +
      rows
        .map((r) => "`" + String(r.id).replace(/[^a-zA-Z0-9_-]/g, "") + "`")
        .join(", "),
    "No order, mandate, reservation or payment hold was created. Buying requires a separate explicit request and the existing approval checks.",
  );
  return lines.join("\n");
}
