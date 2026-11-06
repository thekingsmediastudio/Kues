// Conservative source-only checks: no model-authored numbers and no currency conversion.
// A search excerpt is evidence of an advertised price, never proof of stock or delivered cost.
export function isShoppingResearch(query) {
  const q = String(query || '').normalize('NFKC');
  return /\bjiji\.ng\b/i.test(q) || (/\b(?:laptop|laptops|product|products|seller|sellers|buy|shopping|listing|listings)\b/i.test(q) && /(?:₦|\b(?:NGN|naira)\b|\b(?:price|priced|budget|cost|under|below)\b)/i.test(q));
}

// Parse only unambiguous exact upper limits in the current user message; do not
// infer a budget from conversation history, an example, a range or another currency.
export function parseNairaCeiling(query) {
  const q = String(query || '').normalize('NFKC');
  if (/\b(?:between|minimum|min\.?|at least|more than|over|above|not under|not below|not less than|per month|monthly|each month|USD|CAD|EUR|GBP|dollars?|euros?|pounds?)\b|[$€£]/i.test(q)) return null;
  if (/\bnot\s+(?:(?:a|the|my)\s+)?(?:maximum|budget|ceiling|at most|up to|less than)\b/i.test(q)) return null;
  if (/(?:₦|NGN\s*)\s*[\d,.]+\s*(?:million|thousand)?\s*(?:to\b|[-–~])\s*(?:₦|NGN\s*)?\s*\d/i.test(q)) return null;
  const re = /\b(under|below|less than|up to|at most|no more than|at or below|maximum(?:\s+(?:of|price))?|budget\s*(?:maximum|at most|up to|of|is|:)?|ceiling(?:\s+of)?)\s*(?:is\s+|of\s+|:\s*)?(₦|NGN\s*)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*(million|thousand)?\s*(NGN|naira)?\b/gi;
  const hits = [...q.matchAll(re)];
  if (hits.length !== 1) return null;
  const [,op,prefix,raw,scale,suffix] = hits[0];
  if (!prefix && !suffix) return null;
  const amount = Number(raw.replaceAll(',', '')) * (scale?.toLowerCase() === 'million' ? 1_000_000 : scale?.toLowerCase() === 'thousand' ? 1_000 : 1);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 || !Number.isSafeInteger(Math.round(amount * 100))) return null;
  return { kobo: Math.round(amount * 100), inclusive: !/^(under|below|less than)$/i.test(op) };
}

// Only Jiji individual listing URLs with explicit “Price: ₦…” fields in the
// bounded source title/excerpt qualify. Conflicting or qualified prices are unknown.
export function reportedJijiPrice(source) {
  let u; try { u = new URL(source?.url); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'jiji.ng' || !/^\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\.html$/i.test(u.pathname)) return null;
  const text = `${String(source.title || '')}\n${String(source.excerpt || '')}`.normalize('NFKC').slice(0, 5000);
  if (/\bprice\s*:\s*(?:[$€£]|USD\b|EUR\b|GBP\b|CAD\b)/i.test(text)) return null;
  const re = /\bprice\s*:\s*(?:₦|NGN)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?!(?:\d|,\d|\.\d))(?:\s*(million|thousand))?/gi;
  const values = new Set(); let unsafe = false;
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0,m.index-25),m.index);
    const after = text.slice(m.index+m[0].length,m.index+m[0].length+24);
    if (/(?:market|previous|old|was|former|original|estimated)\s*$/i.test(before)) continue;
    if (/(?:range|starting|from)\s*$/i.test(before) || /^\s*(?:[-–~]|to\b|million\b|thousand\b|[kKmM]\b|per\b)/i.test(after)) { unsafe=true; continue; }
    const amount=Number(m[1].replaceAll(',',''))*(m[2]?.toLowerCase()==='million'?1_000_000:m[2]?.toLowerCase()==='thousand'?1_000:1);
    if (!Number.isFinite(amount) || amount<=0 || amount>1_000_000_000) { unsafe=true; continue; }
    values.add(Math.round(amount*100));
  }
  return !unsafe && values.size === 1 ? [...values][0] : null;
}

export function shoppingPriceEvidence(research, query) {
  if (!isShoppingResearch(query)) return '';
  const ceiling=parseNairaCeiling(query);
  const rows=(Array.isArray(research?.sources)?research.sources:[]).map((source,i)=>{
    const price=reportedJijiPrice(source);
    if (price===null) return `- [${i+1}] Price or listing evidence ambiguous — verify on the seller page.`;
    const priceText=(price/100).toLocaleString('en-NG',{minimumFractionDigits:price%100?2:0,maximumFractionDigits:2});
    const fit=ceiling ? ((ceiling.inclusive ? price<=ceiling.kobo : price<ceiling.kobo) ? 'within stated item-price limit' : 'over stated item-price limit') : 'budget limit not unambiguously stated in this request';
    return `- [${i+1}] Reported price ₦${priceText} — ${fit}.`;
  });
  return '\n\n### Price checks (unverified evidence)\n'+(rows.join('\n') || 'No listing evidence was returned.')+'\n\nThese are mechanical comparisons of explicitly labeled prices in bounded source text, not verified offers. Prices may be stale; stock, seller details, delivery and other fees are not verified. A price-only fit does not establish that the total cost fits.';
}
