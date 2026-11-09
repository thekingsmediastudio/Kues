import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNamedSingleReview,isNamedSingleReviewRequest} from '../../apps/web/lib/ai-agent/named-bundle-review.mjs';
const a='off_'+'a'.repeat(32),b='off_'+'b'.repeat(32),grid=(...ids)=>({role:'assistant',content:':::products-grid\n'+ids.map(id=>'**Offer ID:** `'+id+'`').join('\n')+'\n:::'});
const message='Prepare a purchase review for 3 Spiral Bound Notebooks from Dollartree.';
function dbFor(rows){return{execute:async q=>({rows:rows.filter(r=>r.id===q.args[0]&&q.args.slice(1).join('/')==='w/u/a')})}}
const row=(id,title='Spiral Bound Notebooks',seller='Dollartree')=>({id,title,merchant_name:seller,merchant_domain:'dollartree.com'});
const resolve=(messages,rows,msg=message,scope={workspaceId:'w',userId:'u',agentId:'a'})=>resolveNamedSingleReview({message:msg,storedMessages:messages,db:dbFor(rows),...scope});
test('named single uses unique latest scoped offer, preserving quantity and never authorizing',async()=>{
 assert(isNamedSingleReviewRequest(message));assert.deepEqual(await resolve([grid(a),grid(b)],[row(a),row(b)]),{kind:'tool',name:'purchase_product',arguments:{items:[{offerId:b,quantity:3}]}});
 assert.deepEqual(await resolve([grid(a)],[row(a)],'Prepare a purchase review for 3 Spiral Bound Notebooks from dollartree.com.'),{kind:'tool',name:'purchase_product',arguments:{items:[{offerId:a,quantity:3}]}});
});
test('named single refuses ambiguity, unknown/foreign entries, no latest products and invalid quantities',async()=>{
 for(const [messages,rows,msg,scope] of [[ [grid(a,b)],[row(a),row(b)],message ],[[grid(a)],[row(a)],'Prepare a purchase review for 21 Spiral Bound Notebooks from Dollartree.'],[[grid(a)],[row(a)],'Prepare a purchase review for 0 Spiral Bound Notebooks from Dollartree.'],[[grid(a)],[],message],[[grid(a)],[row(a)],message,{workspaceId:'foreign',userId:'u',agentId:'a'}],[[grid(a),{role:'assistant',content:'No verified products for exact identifier ABC'}],[row(a)],message],[[grid(a),{role:'assistant',content:'No verified products were found in the returned live search results.'}],[row(a)],message],[[grid(a),{role:'assistant',content:'Product discovery is unavailable right now. No sample products were substituted.'}],[row(a)],message],[[grid(a)],[row(a)],'Prepare a purchase review for 3 Spiral Bound Notebooks from Wrong Seller.']]) assert.equal((await resolve(messages,rows,msg,scope)).kind,'clarify_named_single');
 assert.equal(isNamedSingleReviewRequest(message+' Then approve and pay.'),false);
 assert.equal(isNamedSingleReviewRequest('Prepare a purchase review for 3 notebooks; then approve from Dollartree.'),false);
});
