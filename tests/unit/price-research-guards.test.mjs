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
