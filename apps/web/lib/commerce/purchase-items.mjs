import { createHash } from "node:crypto";
export function purchaseQuantity(value) {
  const q = value === undefined ? 1 : value;
  if (!Number.isSafeInteger(q) || q < 1 || q > 20)
    throw Error("purchase_quantity_invalid");
  return q;
}
export function quantityLine(item) {
  const quantity = purchaseQuantity(item.quantity),
    unitAmountMinor = item.amountMinor;
  if (
    !Number.isSafeInteger(unitAmountMinor) ||
    unitAmountMinor < 1 ||
    unitAmountMinor > 100000000
  )
    throw Error("purchase_unit_price_invalid");
  const lineTotalMinor = unitAmountMinor * quantity;
  if (!Number.isSafeInteger(lineTotalMinor) || lineTotalMinor > 100000000)
    throw Error("purchase_amount_invalid");
  return {
    ...item,
    quantity,
    unitAmountMinor,
    lineTotalMinor,
    amountMinor: lineTotalMinor,
  };
}
const canonical = (items) =>
  items.map((i) => [
    i.offerId || null,
    i.title,
    i.merchantDomain,
    i.currency,
    i.unitAmountMinor,
    i.quantity,
    i.lineTotalMinor,
    i.evidenceHash,
  ]);
export const purchaseItemsHash = (items) =>
  "sha256:" +
  createHash("sha256")
    .update(JSON.stringify(canonical(items)))
    .digest("hex");
export async function readPurchaseItems(tx, workspaceId, mandate) {
  const r = await tx.execute({
    sql: "SELECT * FROM mandate_purchase_items WHERE workspace_id=? AND mandate_id=? ORDER BY line_number",
    args: [workspaceId, mandate.id],
  });
  return validatePurchaseItemRows(r.rows, mandate);
}
// Used by scoped batch readers; exactly the same validation as individual reads.
export function validatePurchaseItemRows(rows, mandate) {
  // Legacy amount-only mandates have neither a hash nor item rows. A missing
  // hash with item rows is corruption, not permission to skip item validation.
  if (!mandate.purchase_items_hash) {
    if (rows.length) throw Error("purchase_items_changed");
    return [];
  }
  const items = rows.map((i) => ({
    offerId: i.offer_id,
    title: i.title,
    merchantDomain: i.merchant_domain,
    currency: i.currency,
    unitAmountMinor: i.unit_amount_minor,
    quantity: i.quantity,
    lineTotalMinor: i.line_total_minor,
    amountMinor: i.line_total_minor,
    evidenceHash: i.evidence_hash,
  }));
  if (
    !items.length ||
    items.length > 10 ||
    purchaseItemsHash(items) !== mandate.purchase_items_hash ||
    items.some(
      (i) =>
        i.currency !== mandate.currency ||
        !Number.isSafeInteger(i.quantity) ||
        i.quantity < 1 ||
        i.quantity > 20 ||
        i.unitAmountMinor * i.quantity !== i.lineTotalMinor,
    ) ||
    items.reduce((a, i) => a + i.lineTotalMinor, 0) !== mandate.amount_minor
  )
    throw Error("purchase_items_changed");
  return items;
}
export const paypalLineItems = (items) =>
  items.map((i) => ({
    name: String(i.title).slice(0, 127),
    quantity: String(i.quantity),
    unit_amount: {
      currency_code: i.currency,
      value: (i.unitAmountMinor / 100).toFixed(2),
    },
  }));
