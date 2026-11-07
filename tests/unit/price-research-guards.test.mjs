import test from 'node:test';
import assert from 'node:assert/strict';
import { applyExplicitUsdItemCeiling } from '../../apps/web/lib/ai-agent/workspace-tools.mjs';
import { researchAnswerForDisplay } from '../../apps/web/lib/ai-agent/web-research.mjs';
import { discoverProducts } from '../../apps/web/lib/channel3/discovery.mjs';
import { createChannel3Client } from '../../apps/web/lib/channel3/client.mjs';

test('explicit item ceilings honor strict versus inclusive prices, reject ambiguity, and preserve unrelated requests',()=>{
 const prepared={kind:'search_products',filters:{max_price:500}};
 assert.deepEqual(applyExplicitUsdItemCeiling(prepared,'Find notebooks under $5 USD each').filters,{max_price:5,price_max_exclusive:true,enforce_usd_price:true});
 assert.deepEqual(applyExplicitUsdItemCeiling(prepared,'Find notebooks at most 5.00 USD each').filters,{max_price:5,price_max_exclusive:false,enforce_usd_price:true});
 assert.throws(()=>applyExplicitUsdItemCeiling(prepared,'notebooks under $5 CAD'),e=>e.code==='workspace_tool_price_conflict');
 assert.throws(()=>applyExplicitUsdItemCeiling(prepared,'notebooks under 5 USD total'),e=>e.code==='workspace_tool_price_conflict');
 assert.throws(()=>applyExplicitUsdItemCeiling(prepared,'notebooks under 5 USD or under 8 USD'),e=>e.code==='workspace_tool_price_conflict');
 assert.throws(()=>applyExplicitUsdItemCeiling({filters:{min_price:6}},'notebooks under 5 USD'),e=>e.code==='workspace_tool_price_conflict');
 assert.equal(applyExplicitUsdItemCeiling(prepared,'Find blue notebooks'),prepared);
});

test('real client normalization plus discovery excludes unknown currencies, unknown prices and over-limit offers before persistence',async()=>{
 const raw=[{id:'ok',title:'Correct',price:4.99,currency:'USD'},{id:'equal',title:'Equal',price:5,currency:'USD'},{id:'unknown-currency',title:'Currency unknown',price:2},{id:'unknown-price',title:'Price unknown',currency:'USD'},{id:'eur',title:'Euro',price:2,currency:'EUR'},{id:'big',title:'Too much',price:25,currency:'USD'}];
 const client=createChannel3Client({apiKey:'test',baseUrl:'https://api.trychannel3.com',resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async()=>({ok:true,json:async()=>({products:raw})})});
 const result=await discoverProducts({channel3Client:client,query:'notebook',limit:10,filters:{max_price:5,price_max_exclusive:true,enforce_usd_price:true}});
 assert.equal(result.count,1);assert.deepEqual(result.products.map(p=>p.id),['ok']);
});

test('research guard preserves complete answers and exposes incomplete ones without inventing facts',()=>{
 const q='/research According to RFC 2606 list the four reserved TLDs';
 const complete='RFC 2606 reserves .test, .example, .invalid, and .localhost [1].';
 assert.equal(researchAnswerForDisplay(complete,q),complete);
 assert.match(researchAnswerForDisplay('The names are **[.test',q),/appears incomplete/);
 assert.match(researchAnswerForDisplay('RFC 2606 mentions .test and .example.',q),/appears incomplete/);
 assert.equal(researchAnswerForDisplay('HTTP 404 does not imply permanence [1].','/research RFC 9110 404'),'HTTP 404 does not imply permanence [1].');
});

test('deterministic product fallback only handles narrow per-item USD search grammar', async()=>{
 const {explicitUsdProductSearch}=await import('../../apps/web/lib/ai-agent/workspace-tools.mjs');
 assert.deepEqual(explicitUsdProductSearch('Find up to 3 real ruled notebooks priced under 5 USD each. Show prices.'),{kind:'search_products',query:'ruled notebooks',limit:3,filters:{max_price:5,price_max_exclusive:true,enforce_usd_price:true}});
 assert.equal(explicitUsdProductSearch('Find up to 3 notebooks priced under 5 CAD each.'),null);
 assert.equal(explicitUsdProductSearch('Find up to 3 notebooks priced under 5 USD each and buy them.'),null);
 assert.equal(explicitUsdProductSearch('Find up to 0 notebooks priced under 5 USD each.'),null);
});

test('saved-offer comparison fails closed for missing, cross-agent, and unknown-price records',async()=>{
 const {explicitOfferComparison,compareSavedOffers}=await import('../../apps/web/lib/ai-agent/saved-offer-comparison.mjs');
 const ids=['off_'+'a'.repeat(32),'off_'+'b'.repeat(32)];
 assert.deepEqual(explicitOfferComparison(`Compare ${ids.join(' and ')}. Do not buy or prepare a purchase.`),ids);
 assert.equal(explicitOfferComparison(`Compare ${ids.join(' and ')} and buy one.`),null);
 const db={transaction:async()=>({execute:async q=>({rows:q.args[0]===ids[0]?[{id:ids[0],title:'A',merchant_name:'Seller',merchant_domain:'seller.example',amount_minor:0,currency:'USD',mode:'live_search'}]:[]}),commit:async()=>{},rollback:async()=>{}})};
 assert.match(await compareSavedOffers({db,workspaceId:'w',userId:'u',agentId:'a',ids}),/could not be verified/);
 assert.match(await compareSavedOffers({db,workspaceId:'w',userId:'u',agentId:'a',ids:[ids[0],ids[0]]}),/distinct valid/);
});


test('shopping research never shows model-computed budget or invented listing claims',()=>{
 const misleading='₦1,100,000 is inside the ₦1,000,000 budget. Seller: made up.';
 for(const q of ['/research site:jiji.ng/ikeja HP Omen RTX 2070','/research Find laptops in Lagos under 1,000,000 NGN']){
   const answer=researchAnswerForDisplay(misleading,q);
   assert.match(answer,/sources only/);assert.doesNotMatch(answer,/1,100,000|made up/);
 }
 assert.equal(researchAnswerForDisplay('One million naira.','/research What is NGN?'),'One million naira.');
});

test('legacy saved comparisons do not present guessed currency as verified USD',async()=>{
 const {compareSavedOffers}=await import('../../apps/web/lib/ai-agent/saved-offer-comparison.mjs');
 const ids=['off_'+'a'.repeat(32),'off_'+'b'.repeat(32)];
 const db={transaction:async()=>({execute:async q=>({rows:[{id:q.args[0],title:'Fixture',merchant_name:'Shop',merchant_domain:'shop.example',amount_minor:200,currency:'USD',evidence_ref:null,mode:'live_search'}]}),commit:async()=>{},rollback:async()=>{}})};
 const text=await compareSavedOffers({db,workspaceId:'w',userId:'u',agentId:'a',ids});
 assert.equal((text.match(/Price unavailable or unverified/g)||[]).length,2);assert.doesNotMatch(text,/\$2\.00/);
});
