import test from 'node:test';
import assert from 'node:assert/strict';
import {applyExplicitProductIdentifier} from '../../apps/web/lib/ai-agent/workspace-tools.mjs';
import {discoverProducts} from '../../apps/web/lib/channel3/discovery.mjs';
import {normalizeProduct} from '../../apps/web/lib/channel3/client.mjs';

test('exact identifier is derived from user intent, not model output; ambiguous input fails closed',()=>{
 const prepared={kind:'search_products',query:'coded product',filters:{max_price:5}};
 assert.deepEqual(applyExplicitProductIdentifier(prepared,'Find qzxv7m2k9p4b63z91q. This is an exact product name.').filters,{max_price:5,exact_identifier:'QZXV7M2K9P4B63Z91Q'});
 assert.equal(applyExplicitProductIdentifier(prepared,'Find qzxv7m2k9p4b63z91q products.'),prepared);
 assert.equal(applyExplicitProductIdentifier(prepared,'Find qzxv7m2k9p4b63z91q, not exact matching.'),prepared);
 assert.throws(()=>applyExplicitProductIdentifier(prepared,'Find the exact product codes ABC123 and XYZ789.'),e=>e.code==='workspace_tool_exact_identifier_ambiguous');
});

test('exact code is checked against title token or full SKU, never a partial token or description alone',async()=>{
 const products=[{id:'1',title:'Headphones XYZ123',sku:'',description:''},{id:'2',title:'Keyboard',sku:'xyz123'},{id:'3',title:'Larger XYZ1234',sku:''},{id:'4',title:'Compatible XYZ123-V2',sku:''},{id:'5',title:'Compatible headphones',description:'fits XYZ123'}];
 const client={isConfigured:()=>true,searchProducts:async()=>({query:'XYZ123',count:products.length,products,isLive:true,source:'channel3'})};
 const result=await discoverProducts({channel3Client:client,query:'XYZ123',filters:{exact_identifier:'XYZ123'}});
 assert.deepEqual(result.products.map(p=>p.id),['1','2']);assert.equal(result.count,2);
 const broad=await discoverProducts({channel3Client:client,query:'XYZ123'});assert.equal(broad.products.length,5);
});

test('normalization preserves a product SKU for bounded exact-code checks',()=>{
 const p=normalizeProduct({id:'live-id',title:'Keyboard',sku:'XYZ-123',price:4,currency:'USD'},{source:'channel3',isLive:true});assert.equal(p.sku,'XYZ-123');
});
