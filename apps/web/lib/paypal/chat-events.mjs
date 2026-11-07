// Payment facts are projected from the durable server-written audit log, never
// from callback URL parameters or client claims. No extra model call is needed.
export async function readCheckoutChatEvents({
  db,
  workspaceId,
  userId,
  agentId,
  limit = 100,
}) {
  const rows = await db.execute({
    sql: `SELECT e.id,e.event_type,e.created_at,e.details_json,c.amount_minor,c.currency,c.mandate_id
 FROM paypal_standard_checkout_events e
 JOIN paypal_standard_checkouts c ON c.id=e.checkout_id
 JOIN mandates m ON m.id=c.mandate_id AND m.workspace_id=c.workspace_id
 JOIN runs r ON r.id=m.run_id AND r.workspace_id=m.workspace_id
 WHERE c.workspace_id=? AND c.user_id=? AND r.user_id=? AND r.agent_id=?
 AND e.event_type IN ('sandbox_authorized','sandbox_voided','buyer_cancelled')
 ORDER BY e.created_at DESC,e.rowid DESC LIMIT ?`,
    args: [
      workspaceId,
      userId,
      userId,
      agentId,
      Math.min(Math.max(Number(limit) || 100, 1), 100),
    ],
  });
  return rows.rows.reverse().map((r) => {
    const amount = `${(Number(r.amount_minor) / 100).toFixed(2)} ${r.currency}`;
    const text =
      r.event_type === "sandbox_authorized"
        ? `Sandbox authorization successful for ${amount}. PayPal confirmed the authorization hold; funds were not captured.`
        : r.event_type === "sandbox_voided"
          ? `Sandbox authorization voided for ${amount}. PayPal confirmed the hold was voided; funds were not captured.`
          : `PayPal checkout cancelled for ${amount}. Keus did not request an authorization for this checkout.`;
    let quantityText='';
    try{const q=JSON.parse(r.details_json).quantities;if(Array.isArray(q)&&q.length)quantityText='\nQuantities: '+q.map((i,n)=>`item ${n+1}: ${i.quantity} × ${(i.unitAmountMinor/100).toFixed(2)} ${r.currency} = ${(i.lineTotalMinor/100).toFixed(2)} ${r.currency}`).join('; ')+'.';}catch{}
    return {
      role: "assistant",
      content: `Verified checkout update: ${text}${quantityText}\nNo seller order or shipment was placed.\nCheckout reference: ${r.mandate_id}`,
      createdAt: r.created_at,
    };
  });
}
export function mergeCheckoutHistory(messages, events, limit) {
  const ordered = [...messages, ...events].sort((a, b) =>
    String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
  );
  // Keep the latest verified checkout facts visible even when later chat turns
  // fill the history window. The total window stays bounded and chronological.
  const pinned = new Set(events.slice(-Math.min(10, limit)));
  const chosen = new Set([...ordered.slice(-limit), ...pinned]);
  const result = ordered.filter((item) => chosen.has(item));
  for (let i = 0; result.length > limit && i < result.length;) {
    if (pinned.has(result[i])) i += 1;
    else result.splice(i, 1);
  }
  return result;
}
