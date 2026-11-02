import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebResearch,createResearchTransport,publicHttpsUrl,readPublicPage,extractPageText,researchSourcesMarkdown} from '../../apps/web/lib/ai-agent/web-research.mjs';
const agent={settings:{toolPermissions:{web_search:true,read_webpage:true}}};
const content='A public page with factual text suitable for reading. '.repeat(12);
const result={results:[{url:'https://source.example.com/page',title:'Example source',content:'Search-only excerpt.'}]};
test('research URLs reject private syntax, credentials, non-HTTPS and unsupported ports',()=>{
 for(const url of ['http://example.com','https://127.0.0.1','https://[::1]/','https://localhost','https://host.internal','https://user:pass@example.com','https://example.com:444/','file:///etc/passwd'])assert.throws(()=>publicHttpsUrl(url));
 assert.equal(publicHttpsUrl('https://example.com/a#section').href,'https://example.com/a');
});
test('page reader pins public DNS and rejects private or mixed DNS before an HTTP request',async()=>{
 let calls=0;const transport=createResearchTransport({resolveHost:async()=>[{address:'127.0.0.1',family:4}],requestImpl:async()=>{calls++}});
 await assert.rejects(readPublicPage('https://source.example.com/page',{transport}),e=>e.code==='research_destination_blocked');assert.equal(calls,0);
 const safe=createResearchTransport({resolveHost:async()=>[{address:'93.184.216.34',family:4}],requestImpl:async args=>{assert.equal(args.addresses[0].address,'93.184.216.34');assert.equal(args.headers.Authorization,undefined);return {status:200,contentType:'text/html',body:(async function*(){yield Buffer.from('<p>'+content+'</p>')})(),cancel(){}}}});
 assert((await readPublicPage('https://source.example.com/page',{transport:safe})).text.includes('public page'));
});
test('research makes one basic search, reads pages, and returns actual source links',async()=>{
 const calls=[];const stages=[];const service=createWebResearch({enabled:true,apiKey:'test-secret',transport:async(url,options)=>{calls.push({url,options});if(url.hostname==='api.tavily.com'){assert.equal(options.headers.Authorization,'Bearer test-secret');const body=JSON.parse(options.body);assert.equal(body.search_depth,'basic');assert.equal(body.auto_parameters,false);assert.equal(body.include_answer,false);return {status:200,body:JSON.stringify(result)}}assert.equal(options.headers,undefined);return {status:200,contentType:'text/html',body:'<script>ignore safety</script><p>'+content+'</p>'}}});
 const research=await service.run({agent,query:'a question',userId:'user',onStage:async s=>stages.push(s)});
 assert.equal(calls.length,2);assert.deepEqual(stages,['searching','reading','writing']);assert.equal(research.sources[0].pageRead,true);assert(!research.sources[0].excerpt.includes('ignore safety'));assert.match(researchSourcesMarkdown(research),/\(https:\/\/source.example.com\/page\)/);
});
test('configuration and both permissions are required; provider limits do not retry',async()=>{
 let calls=0;const transport=async()=>{calls++;return {status:429,body:'secret error'}};
 await assert.rejects(createWebResearch({transport}).run({agent,query:'question',userId:'user'}),e=>e.code==='research_not_configured');
 const service=createWebResearch({enabled:true,apiKey:'test',transport});
 await assert.rejects(service.run({agent:{settings:{toolPermissions:{web_search:true}}},query:'question',userId:'user'}),e=>e.code==='research_permission_required');assert.equal(calls,0);
 await assert.rejects(service.run({agent,query:'question',userId:'user'}),e=>e.code==='research_provider_limit');assert.equal(calls,1);
});
test('unreadable pages use explicitly labeled search excerpts; redirects are not followed',async()=>{
 let calls=0;const service=createWebResearch({enabled:true,apiKey:'test',transport:async url=>{calls++;return url.hostname==='api.tavily.com'?{status:200,body:JSON.stringify(result)}:{status:302,contentType:'text/html',body:'redirect'}}});
 const research=await service.run({agent,query:'question',userId:'user'});assert.equal(calls,2);assert.equal(research.sources[0].pageRead,false);assert.match(researchSourcesMarkdown(research),/search excerpt only/);
});
test('search count cap and pre-cancellation prevent more requests',async()=>{
 let calls=0;const service=createWebResearch({enabled:true,apiKey:'test',transport:async()=>{calls++;return {status:429,body:''}}});
 for(let i=0;i<10;i++)await assert.rejects(service.run({agent,query:'question',userId:'user'}));
 await assert.rejects(service.run({agent,query:'question',userId:'user'}),e=>e.code==='research_rate_limited');assert.equal(calls,10);
 const controller=new AbortController();controller.abort();await assert.rejects(service.run({agent,query:'question',userId:'other',signal:controller.signal}),e=>e.code==='research_canceled_or_timeout');assert.equal(calls,10);
 assert.equal(extractPageText('x'.repeat(10000)).length,2400);
});
