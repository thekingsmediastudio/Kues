// Resolve only a tightly scoped review request against offers displayed in this
// agent's recent shopping results. The mandate service still rechecks ownership,
// verified currency, limits and approval; this function never starts checkout.
const clarify = { kind: 'clarify_named_bundle' };
const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
function parseNamedBundleRequest(message) {
  const text = String(message || '').normalize('NFKC').trim();
  return /^(?:please\s+)?(?:buy|purchase)\s+(\d{1,2})\s+of\s+the\s+([^.!?;\n]{1,160}?)\s+and\s+(\d{1,2})\s+of\s+the\s+([^.!?;\n]{1,160}?)(?:\s+from\s+the\s+(?:search\s+)?results)?[.!?]?(?:\s+prepare\s+a\s+purchase\s+review\s+only;\s*do\s+not\s+approve,\s*open\s+paypal,\s*authorize,\s*capture\s+or\s+pay\.)?$/i.exec(text);
}
export function isNamedBundleReviewRequest(message) { return Boolean(parseNamedBundleRequest(message)); }

export async function resolveNamedBundleReview({message, storedMessages, db, workspaceId, userId, agentId}) {
  const m = parseNamedBundleRequest(message);
  if (!m) return null;
  const quantities = [Number(m[1]), Number(m[3])];
  if (quantities.some(n => n < 1 || n > 20)) return clarify;
  const ids = new Set();
  for (const entry of storedMessages || []) {
    if (entry.role !== 'assistant' || !String(entry.content || '').includes(':::products-grid')) continue;
    for (const found of String(entry.content).matchAll(/(?:\*\*)?Offer ID:(?:\*\*)?\s*`(off_[a-f0-9]{32})`/gi)) ids.add(found[1].toLowerCase());
  }
  if (!ids.size || ids.size > 100) return clarify;
  const offers = [];
  for (const id of ids) {
    const result = await db.execute({sql: `SELECT p.id, p.title, p.merchant_name, p.merchant_domain FROM product_offers p JOIN runs r ON r.id=p.run_id AND r.workspace_id=p.workspace_id WHERE p.id=? AND p.workspace_id=? AND r.user_id=? AND r.agent_id=?`, args: [id, workspaceId, userId, agentId]});
    if (result.rows[0]) offers.push(result.rows[0]);
  }
  const refs = [norm(m[2]),norm(m[4])];
  const selected = refs.map(ref => offers.filter(o => ref === norm(o.title) || ref === `${norm(o.title)} at ${norm(o.merchant_name)}` || ref === `${norm(o.title)} at ${norm(o.merchant_domain)}`));
  if (selected.some(group => group.length !== 1) || selected[0][0].id === selected[1][0].id) return clarify;
  return {kind:'tool',name:'purchase_product',arguments:{items:selected.map((group,i)=>({offerId:group[0].id,quantity:quantities[i]}))}};
}
export const NAMED_BUNDLE_CLARIFICATION = 'Please specify the exact product names and sellers from your recent search results. I could not uniquely identify both items, so no review or payment was created.';

// A single exact title + seller request is bound to the latest displayed
// shopping result set, not to a guess or to an older matching listing. This
// prepares a review only; the normal mandate and approval gates still apply.
function parseNamedSingleReview(message) {
  const text=String(message||'').normalize('NFKC').trim();
  return /^(?:please\s+)?prepare\s+a\s+purchase\s+review\s+for\s+(\d{1,2})\s+([^\n;!?]{1,160}?)\s+from\s+([\p{L}\p{N}][\p{L}\p{N} &'’\-]{0,99}(?:\.[\p{L}\p{N}-]+)*)[.!?]?$/iu.exec(text);
}
export function isNamedSingleReviewRequest(message) { return Boolean(parseNamedSingleReview(message)); }
export const NAMED_SINGLE_CLARIFICATION='Please specify the exact product and seller from the latest search results. I could not identify one unique current saved offer, so no review or payment was created.';
export async function resolveNamedSingleReview({message,storedMessages,db,workspaceId,userId,agentId}) {
  const m=parseNamedSingleReview(message);if(!m)return null;
  const clarify={kind:'clarify_named_single'},quantity=Number(m[1]);
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>20||!db)return clarify;
  const latest=[...(storedMessages||[])].reverse().find(e=>e.role==='assistant'&&(/:::products-grid/.test(String(e.content||''))||/No verified products(?:\s|$)|Product discovery is unavailable right now/i.test(String(e.content||''))));
  if(!latest||!String(latest.content||'').includes(':::products-grid'))return clarify;
  const ids=[...new Set([...String(latest.content).matchAll(/(?:\*\*)?Offer ID:(?:\*\*)?\s*`(off_[a-f0-9]{32})`/gi)].map(x=>x[1].toLowerCase()))];
  if(!ids.length||ids.length>50)return clarify;
  const title=norm(m[2]),seller=norm(m[3]);const matches=[];
  for(const id of ids){const r=await db.execute({sql:'SELECT p.id,p.title,p.merchant_name,p.merchant_domain FROM product_offers p JOIN runs r ON r.id=p.run_id AND r.workspace_id=p.workspace_id WHERE p.id=? AND p.workspace_id=? AND r.user_id=? AND r.agent_id=?',args:[id,workspaceId,userId,agentId]});const row=r.rows[0];if(row&&norm(row.title)===title&&(norm(row.merchant_name)===seller||norm(row.merchant_domain)===seller))matches.push(row)}
  if(matches.length!==1)return clarify;
  return {kind:'tool',name:'purchase_product',arguments:{items:[{offerId:matches[0].id,quantity}]}};
}
