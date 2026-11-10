// Resolve narrowly scoped follow-ups into the existing review-only policy pipeline.
export const CONTEXTUAL_REVIEW_CLARIFICATION = 'Find the item in your latest search results, click Buy on its card, and enter the quantity. If you cannot find it, search again or tell me its exact name and seller. This prepares a review only; it does not place an order or take payment.';
export function parseContextualReview(message) {
  const text=String(message||'').normalize('NFKC').trim();
  const m=/^(?:please\s+)?(?:can|could|may)\s+we\s+(?:buy|purchase)\s+(\d{1,2})\s+(?:of|fo)\s+(?:that|this)\s+(?:product|item)[?.!]?$/iu.exec(text);
  return m ? Number(m[1]) : null;
}
export async function resolveContextualReview({message,storedMessages,db,workspaceId,userId,agentId}) {
  const quantity=parseContextualReview(message);if(quantity===null)return null;
  const clarify={kind:'clarify_contextual_review'};
  if(quantity<1||quantity>20||!db)return clarify;
  const latest=[...(storedMessages||[])].reverse().find(e=>e.role==='assistant'&&(/:::products-grid/.test(String(e.content||''))||/No verified products(?:\s|$)|Product discovery is unavailable right now/i.test(String(e.content||''))));
  if(!latest||!String(latest.content||'').includes(':::products-grid'))return clarify;
  const ids=[...new Set([...String(latest.content).matchAll(/(?:\*\*)?Offer ID:(?:\*\*)?\s*`(off_[a-f0-9]{32})`/gi)].map(x=>x[1].toLowerCase()))];
  if(ids.length!==1)return clarify;
  const r=await db.execute({sql:'SELECT p.id FROM product_offers p JOIN runs r ON r.id=p.run_id AND r.workspace_id=p.workspace_id WHERE p.id=? AND p.workspace_id=? AND r.user_id=? AND r.agent_id=?',args:[ids[0],workspaceId,userId,agentId]});
  if(r.rows.length!==1)return clarify;
  return {kind:'tool',name:'purchase_product',arguments:{items:[{offerId:ids[0],quantity}]}};
}
