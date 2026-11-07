import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';
import {applyMigrations} from '../../apps/web/lib/db/migrate.mjs';
import {createPurchaseMandate,evaluateSpendPolicy,authorizePurchaseMandate} from '../../apps/web/lib/channel3/mandate-service.mjs';
import {loadServerConfig} from '../../apps/web/lib/config.mjs';
import {createServer} from '../../apps/web/server.mjs';

async function fixture(t) {
 const db=createClient({url:':memory:'});await applyMigrations(db);
 for(const id of ['owner','foreign','other'])await db.execute({sql:'INSERT INTO users (id,email_normalized,status) VALUES (?,?,?)',args:[id,id+'@example.test','active']});
 await db.execute({sql:"INSERT INTO workspaces (id,owner_user_id,name,status) VALUES ('ws','owner','Fixture','active')"});
 await db.execute({sql:"INSERT INTO workspaces (id,owner_user_id,name,status) VALUES ('otherws','other','Other','active')"});
 await db.execute({sql:"INSERT INTO agents (workspace_id,id,name,role,avatar,status,settings_json) VALUES ('ws','agent','QA','scout','cart','active',?)",args:[JSON.stringify({orderCap:50,dailyCap:100})]});
 const authService={getSession:async({token})=>['owner','foreign','other'].includes(token)?{id:token}:null};
 const workspaceService={getBootstrap:async({userId})=>({workspace:{id:userId==='other'?'otherws':'ws',status:'active'},agents:[]})};
 const server=createServer({config:loadServerConfig({TURSO_DATABASE_URL:'file:./test.db'}),db,authService,workspaceService});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});t.after(async()=>{await new Promise(r=>server.close(r));db.close()});const base='http://127.0.0.1:'+server.address().port;
 const create=async()=>createPurchaseMandate({db,workspaceId:'ws',userId:'owner',agentId:'agent',product:{title:'Fixture',merchantDomain:'shop.example',amountMinor:1000,currency:'USD',evidenceHash:'sha256:'+'a'.repeat(64)}});
 const post=(body,{token='owner',origin=base}={})=>fetch(base+'/api/commerce/mandates/decline',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Cookie:'kues_session='+token}:{}),...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
 return {db,create,post,base};
}

test('decline direct review releases budget, is idempotent, and never creates checkout',async t=>{
 const f=await fixture(t),m=await f.create();assert.equal(m.allowed,true);
 const scope={db:f.db,workspaceId:'ws',agentId:'agent',amountMinor:100,merchantDomain:'shop.example'};assert.equal((await evaluateSpendPolicy(scope)).dailySpentMinor,1000);
 const [a,b]=await Promise.all([f.post({mandateId:m.mandateId}),f.post({mandateId:m.mandateId})]);assert.equal(a.status,200);assert.equal(b.status,200);assert.equal((await a.json()).mandate.status,'rejected');assert.equal((await b.json()).mandate.status,'rejected');
 assert.equal((await evaluateSpendPolicy(scope)).dailySpentMinor,0);const rows=await f.db.execute({sql:'SELECT status FROM mandate_approvals WHERE mandate_id=?',args:[m.mandateId]});assert.equal(rows.rows[0].status,'rejected');assert.equal(Number((await f.db.execute('SELECT COUNT(*) AS n FROM paypal_standard_checkouts')).rows[0].n),0);assert.equal(Number((await f.db.execute({sql:"SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND event_type='mandate_rejected'",args:[m.runId]})).rows[0].n),1);
});

test('decline requires authentication same origin exact args and owner workspace',async t=>{
 const f=await fixture(t),m=await f.create(),body={mandateId:m.mandateId};
 for(const [opts,status] of [[{token:null},401],[{origin:null},403],[{origin:'https://evil.test'},403],[{token:'foreign'},404],[{token:'other'},404]]){const r=await f.post(body,opts);assert.equal(r.status,status,JSON.stringify(opts));}
 assert.equal((await f.post({...body,decision:'approve'})).status,400);assert.equal((await f.post({mandateId:'invalid'})).status,400);const status=await f.db.execute({sql:'SELECT status FROM mandates WHERE id=?',args:[m.mandateId]});assert.equal(status.rows[0].status,'awaiting_approval');
});

test('expired unapproved review can be cleared; approved and checkout-linked reviews cannot',async t=>{
 const f=await fixture(t),expired=await f.create();await f.db.execute({sql:"UPDATE mandates SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",args:[expired.mandateId]});const e=await f.post({mandateId:expired.mandateId});assert.equal(e.status,200);assert.equal((await e.json()).mandate.status,'expired');assert.equal((await f.post({mandateId:expired.mandateId})).status,200);
 const approved=await f.create();await f.db.execute({sql:"UPDATE mandates SET status='authorized' WHERE id=?",args:[approved.mandateId]});await f.db.execute({sql:"UPDATE mandate_approvals SET status='verified' WHERE mandate_id=?",args:[approved.mandateId]});assert.equal((await f.post({mandateId:approved.mandateId})).status,409);
 const linked=await f.create();await f.db.execute({sql:"INSERT INTO paypal_standard_checkouts (id,workspace_id,user_id,mandate_id,session_hash,state_hash,snapshot_hash,amount_minor,currency,status,expires_at,created_at,updated_at) VALUES ('ch','ws','owner',?,'s','state','snap',1000,'USD','pending',1,'2026-01-01','2026-01-01')",args:[linked.mandateId]});assert.equal((await f.post({mandateId:linked.mandateId})).status,409);assert.equal((await f.db.execute({sql:'SELECT status FROM mandates WHERE id=?',args:[linked.mandateId]})).rows[0].status,'awaiting_approval');
});


test('simultaneous decline and approval cannot both change a review',async t=>{
 const f=await fixture(t),m=await f.create();const [decline,approval]=await Promise.allSettled([f.post({mandateId:m.mandateId}),authorizePurchaseMandate({db:f.db,workspaceId:'ws',userId:'owner',mandateId:m.mandateId,decision:'approve'})]);assert.equal(decline.status,'fulfilled');const code=decline.value.status;assert.ok(code===200||code===409);const rows=await f.db.execute({sql:'SELECT status FROM mandates WHERE id=?',args:[m.mandateId]});if(code===200){assert.equal(rows.rows[0].status,'rejected');assert.equal(approval.status,'rejected')}else{assert.equal(rows.rows[0].status,'authorized');assert.equal(approval.status,'fulfilled')}assert.equal(Number((await f.db.execute('SELECT COUNT(*) AS n FROM paypal_standard_checkouts')).rows[0].n),0);
});
