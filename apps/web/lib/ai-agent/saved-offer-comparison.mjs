import { hasExplicitCurrency } from '../channel3/currency-evidence.mjs';
import { withReadTransaction } from '../db/transaction.mjs';
import { escapeMarkdown } from './workspace-tools.mjs';

// Stored source URLs are untrusted: only present absolute HTTPS links without
// credentials, control characters or markdown delimiter injection.
function safeSourceLink(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try { const u = new URL(value); if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null; return u.href.replace(/\(/g, '%28').replace(/\)/g, '%29'); }
  catch { return null; }
}

// This route only handles a compare request that explicitly identifies saved offers.
export function explicitOfferComparison(message) {
  const text = String(message || '');
  if (!/\bcompar(?:e|ison|ing)\b/i.test(text)) return null;
  const ids = [...text.matchAll(/\boff_[a-zA-Z0-9_-]+\b/g)].map(m => m[0]);
  if (!ids.length) return null;
  // Do not substitute a read-only comparison for an affirmative purchase request.
  const stripped = text.replace(/\b(?:do not|don't|never)\s+[^.!?]*/gi, '');
  if (/\b(?:buy|purchase|checkout|authorize|pay|order)\b/i.test(stripped)) return null;
  return ids;
}

export async function compareSavedOffers({ db, workspaceId, userId, agentId, ids }) {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 8 || new Set(ids).size !== ids.length || ids.some(id=>!/^off_[a-f0-9]{32}$/.test(id)))
    return 'Please specify two to eight distinct valid saved offer IDs for a comparison. No purchase or payment action was taken.';
  if (!db) return 'Saved offer records are unavailable, so I cannot verify this comparison. No purchase or payment action was taken.';
  const rows = await withReadTransaction(db, async tx => {
    const values = [];
    for (const id of ids) {
      const result = await tx.execute({sql:'SELECT o.*, r.mode FROM product_offers o JOIN runs r ON r.id=o.run_id AND r.workspace_id=o.workspace_id WHERE o.id=? AND o.workspace_id=? AND r.user_id=? AND r.agent_id=?',args:[id,workspaceId,userId,agentId]});
      if (!result.rows[0]) return null;
      values.push(result.rows[0]);
    }
    return values;
  });
  if (!rows) return 'One or more saved offers could not be verified for this agent. Search again or check the offer IDs. No purchase or payment action was taken.';
  const lines = ['## Saved-offer comparison', '', 'These are server-read saved records, not a fresh seller price or stock check.', ''];
  for (const row of rows) {
    const amount = Number(row.amount_minor);
    const validPrice = hasExplicitCurrency(row.evidence_ref, row.currency) && row.currency === 'USD' && Number.isSafeInteger(amount) && amount > 0;
    const source = safeSourceLink(row.source_url);
    lines.push(`- **${escapeMarkdown(row.title || 'Untitled')}** — ${validPrice ? `$${(amount / 100).toFixed(2)} USD` : 'Price unavailable or unverified'}; merchant: ${escapeMarkdown(row.merchant_name || 'unknown')} (${escapeMarkdown(row.merchant_domain || 'unknown')}); recorded: ${escapeMarkdown(row.observed_at || 'unknown')}; availability: ${escapeMarkdown(row.availability || 'unknown')}; source: ${row.mode === 'live_search' ? 'saved live-search result' : 'sample or preview'}; offer: \`${row.id}\`; ${source ? `[View source](${source})` : 'source link unavailable'}.`);
  }
  lines.push('', 'Prices and availability may have changed; verify with the seller before a decision. Shipping and taxes are not verified.', 'No purchase, order, mandate, or payment hold was created.');
  return lines.join('\n');
}
