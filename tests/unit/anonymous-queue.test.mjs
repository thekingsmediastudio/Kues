import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnonymousQueue} from '../../apps/web/lib/ai-providers/anonymous-queue.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('anonymous queue starts two, queues three FIFO, and refuses overflow',async()=>{
 const q=createAnonymousQueue({windowMs:60,limit:2,maxQueued:3,maxWaitMs:300});const events=[];
 await q.enter();await q.enter();
 const tasks=[1,2,3].map(n=>q.enter({onQueued:()=>events.push('waiting'+n)}).then(()=>events.push('start'+n)));
 await assert.rejects(q.enter(),e=>e.code==='anonymous_queue_busy');await delay(35);assert.deepEqual(events,['waiting1','waiting2','waiting3']);await Promise.all(tasks);assert.deepEqual(events.filter(x=>x.startsWith('start')),['start1','start2','start3']);
});
test('aborted waiting requests are removed without consuming a slot',async()=>{
 const q=createAnonymousQueue({windowMs:80,limit:1,maxQueued:1,maxWaitMs:300});await q.enter();const c=new AbortController();let ran=false;const first=q.enter({signal:c.signal}).then(()=>{ran=true});c.abort();await assert.rejects(first,e=>e.code==='anonymous_queue_cancelled');const second=q.enter();await delay(90);await second;assert.equal(ran,false);
});
test('queue waiting timeout fails closed and allows later admission',async()=>{
 const q=createAnonymousQueue({windowMs:150,limit:1,maxQueued:1,maxWaitMs:30});await q.enter();const keepAlive=delay(45);await assert.rejects(q.enter(),e=>e.code==='anonymous_queue_busy');await keepAlive;await delay(120);await q.enter();
});

test('chat adapter gates all anonymous OVH calls and translates provider rate limiting to busy without fallback',async()=>{
 const {createAiChatService}=await import('../../apps/web/lib/ai-providers/chat.mjs');const p={providerKey:'ovhcloud-anonymous',modelId:'Qwen2.5-VL-72B-Instruct',apiProtocol:'openai_chat',baseUrl:'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',apiKey:'OVH_ANONYMOUS',enabled:true,isPrimary:true};let calls=0,fallbacks=0,validations=0;
 const aiProviderService={getPrimaryProviderForRuntime:async()=>p,getProviderForRuntime:async()=>p,hasPrimaryProvider:async()=>true,getFallbackProvidersForRuntime:async()=>{fallbacks++;return[]}};
 const service=createAiChatService({aiProviderService,anonymousQueue:createAnonymousQueue({windowMs:60,limit:2,maxQueued:3,maxWaitMs:300}),resolveHost:async()=>[{address:'93.184.216.34',family:4}],requestHttpsImpl:async()=>{calls++;return{status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'ok'}}],usage:{prompt_tokens:10,completion_tokens:2}})}}});
 const params={agent:{name:'Test'},messages:[{role:'user',content:'Hello'}],providerKey:'ovhcloud-anonymous',modelId:p.modelId,beforeProviderCall:async()=>{validations++}};
 const jobs=Array.from({length:5},()=>service.complete(params));await delay(15);assert.equal(calls,2);await assert.rejects(service.complete(params),e=>e.code==='ai_vision_busy'&&e.status===429);await Promise.all(jobs);assert.equal(calls,5);assert.equal(validations,5);assert.equal(fallbacks,0);
 const limited=createAiChatService({aiProviderService,resolveHost:async()=>[{address:'93.184.216.34',family:4}],requestHttpsImpl:async()=>({status:429,body:'{}'})});await assert.rejects(limited.complete(params),e=>e.code==='ai_vision_busy');assert.equal(fallbacks,0);
});

test('queued request revalidates permission immediately before provider call',async()=>{
 const {createAiChatService}=await import('../../apps/web/lib/ai-providers/chat.mjs');const p={providerKey:'ovhcloud-anonymous',modelId:'Qwen2.5-VL-72B-Instruct',apiProtocol:'openai_chat',baseUrl:'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',apiKey:'OVH_ANONYMOUS',enabled:true};let calls=0,allowed=true;
 const service=createAiChatService({aiProviderService:{getProviderForRuntime:async()=>p},anonymousQueue:createAnonymousQueue({windowMs:80,limit:1,maxQueued:1,maxWaitMs:300}),resolveHost:async()=>[{address:'93.184.216.34',family:4}],requestHttpsImpl:async()=>{calls++;return{status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'ok'}}]})}}});
 const params={agent:{name:'Test'},messages:[{role:'user',content:'Hello'}],providerKey:p.providerKey,modelId:p.modelId,beforeProviderCall:async()=>{if(!allowed)throw Object.assign(new Error('revoked'),{code:'file_permission_required'})}};
 await service.complete(params);const pending=service.complete(params);await delay(15);allowed=false;await assert.rejects(pending,e=>e.code==='file_permission_required');assert.equal(calls,1);
});

test('non-admin free-only calls reject a paid or misconfigured endpoint and never fall back',async()=>{
 const {createAiChatService}=await import('../../apps/web/lib/ai-providers/chat.mjs');let requests=0,fallbacks=0;const p={providerKey:'ovhcloud-anonymous',modelId:'Qwen2.5-VL-72B-Instruct',apiProtocol:'openai_chat',baseUrl:'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',apiKey:'PAID-OR-WRONG-KEY',enabled:true};const aiProviderService={getProviderForRuntime:async()=>p,getFallbackProvidersForRuntime:async()=>{fallbacks++;return[]}};
 const service=createAiChatService({aiProviderService,requestHttpsImpl:async()=>{requests++;return{status:200}}});await assert.rejects(service.complete({agent:{name:'Test'},messages:[{role:'user',content:'Hello'}],providerKey:p.providerKey,modelId:p.modelId,allowFallback:false,requireAnonymousProvider:true}),e=>e.code==='ai_free_model_unavailable');assert.equal(requests,0);assert.equal(fallbacks,0);
});

test('free-only OVH failure never tries paid fallback',async()=>{
 const {createAiChatService}=await import('../../apps/web/lib/ai-providers/chat.mjs');const p={providerKey:'ovhcloud-anonymous',modelId:'Qwen2.5-VL-72B-Instruct',apiProtocol:'openai_chat',baseUrl:'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',apiKey:'OVH_ANONYMOUS',enabled:true};let fallbackLookups=0,calls=0;const aiProviderService={getProviderForRuntime:async()=>p,getFallbackProvidersForRuntime:async()=>{fallbackLookups++;return [{...p,providerKey:'paid',apiKey:'secret'}]}};const service=createAiChatService({aiProviderService,resolveHost:async()=>[{address:'93.184.216.34',family:4}],requestHttpsImpl:async()=>{calls++;return{status:503,body:'{}'}}});assert.equal(await service.isAnonymousReady(),true);await assert.rejects(service.complete({agent:{name:'Test'},messages:[{role:'user',content:'Hello'}],providerKey:p.providerKey,modelId:p.modelId,allowFallback:false,requireAnonymousProvider:true}));assert.equal(calls,1);assert.equal(fallbackLookups,0);
});
