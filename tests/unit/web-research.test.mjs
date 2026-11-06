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

test('primary-source requests use one basic search with six candidates and at most three reads',async()=>{
 const urls=['https://blog.example.com/a','https://other.example.com/b','https://third.example.com/c','https://www.iana.org/domains/reserved','https://www.rfc-editor.org/rfc/rfc2606'];let searches=0,reads=0;
 const service=createWebResearch({enabled:true,apiKey:'test',transport:async(url,options)=>{if(url.hostname==='api.tavily.com'){searches++;const body=JSON.parse(options.body);assert.equal(body.max_results,6);assert.equal(body.search_depth,'basic');assert.match(body.query,/primary sources preferred/);return{status:200,body:JSON.stringify({results:urls.map(url=>({url,title:'Source',content}))})}}reads++;return{status:200,contentType:'text/plain',body:content}}});
 const r=await service.run({agent,query:'What is example.com? Use authoritative sources.',userId:'u'});assert.equal(searches,1);assert.equal(reads,3);assert.equal(r.sources[0].url,urls[3]);assert.equal(r.sources[1].url,urls[4]);assert.match(r.sourceSelectionNotice,/still require checking/);
});
test('source selection rejects spoofed authority suffixes and discloses no verified authority',async()=>{
 const {selectResearchCandidates}=await import('../../apps/web/lib/ai-agent/web-research.mjs');
 const candidates=selectResearchCandidates([{url:'https://iana.org.evil.example.com/'},{url:'https://eviliana.org/'},{url:'https://www.iana.org/'},{url:'https://www.iana.org/#duplicate'},null],true);
 assert.equal(candidates.length,3);assert.equal(candidates[0].url,'https://www.iana.org/');assert.equal(candidates[1].preferredPublisher,false);assert.equal(candidates[2].preferredPublisher,false);
 const service=createWebResearch({enabled:true,apiKey:'test',transport:async url=>url.hostname==='api.tavily.com'?{status:200,body:JSON.stringify(result)}:{status:200,contentType:'text/plain',body:content}});
 const r=await service.run({agent,query:'Find official documentation',userId:'u'});assert.match(researchSourcesMarkdown(r),/not been verified as authoritative/);
});

test('named primary publishers restrict search; explicit RFC reference is read even if search only returns blogs',async()=>{
 let searches=0;const reads=[];const service=createWebResearch({enabled:true,apiKey:'test',transport:async(url,options)=>{if(url.hostname==='api.tavily.com'){searches++;assert.deepEqual(JSON.parse(options.body).include_domains,['iana.org','rfc-editor.org']);return{status:200,body:JSON.stringify(result)}}reads.push(url.href);return{status:200,contentType:'text/plain',body:('Introductory material. '.repeat(200))+' IANA reserves example.com, example.net and example.org for examples. '+content}}});
 const r=await service.run({agent,query:'What is example.com? Use authoritative primary sources, ideally IANA or RFC 2606.',userId:'u'});assert.equal(searches,1);assert.deepEqual(reads,['https://www.rfc-editor.org/rfc/rfc2606.txt']);assert.equal(r.sources.length,1);assert.equal(r.sources[0].pageRead,true);assert.match(r.sources[0].excerpt,/example\.com/);assert(r.sources[0].excerpt.length<=2400);
});
test('targeted sources fail honestly if unavailable and never silently substitute unrelated domains',async()=>{
 const service=createWebResearch({enabled:true,apiKey:'test',transport:async url=>url.hostname==='api.tavily.com'?{status:200,body:JSON.stringify(result)}:{status:404,contentType:'text/plain',body:''}});
 await assert.rejects(service.run({agent,query:'Use primary IANA or RFC 2606 sources',userId:'u'}),e=>e.code==='research_no_sources');
 const {requestedResearchPublishers,researchReferenceCandidates}=await import('../../apps/web/lib/ai-agent/web-research.mjs');assert.deepEqual(requestedResearchPublishers('What is example.com?'),[]);assert.equal(researchReferenceCandidates('Use primary RFC 2606 and RFC 2606 sources').length,1);
});
test('canonical bibliography strips generated duplicate sections while preserving other answer sections',async()=>{
 const {stripResearchBibliography}=await import('../../apps/web/lib/ai-agent/web-research.mjs');
 for(const heading of ['### Sources','Sources:','**Sources**','## References','__Bibliography__']){const result=stripResearchBibliography('Answer [1].\n\n'+heading+'\n- [1] [fake](https://fake.example.com/)\n\n## Limitations\nCheck relevance.');assert.equal(result,'Answer [1].\n\n## Limitations\nCheck relevance.')}
 assert.equal(stripResearchBibliography('Sources of error are discussed below.'),'Sources of error are discussed below.');
});

test('keyless research never sends an API key, remains consent/permission gated and never retries quota failures',async()=>{
 let calls=0; const service=createWebResearch({enabled:true,keyless:true,apiKey:'DO-NOT-SEND',transport:async(url,options)=>{calls++;assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['X-Tavily-Access-Mode'],'keyless');return {status:429,body:''}}});
 assert.equal(service.configured,true);
 await assert.rejects(service.run({agent:{settings:{toolPermissions:{web_search:true}}},query:'laptop',userId:'user'}),e=>e.code==='research_permission_required');assert.equal(calls,0);
 await assert.rejects(service.run({agent,query:'laptop in Lagos under ₦1,000,000',userId:'user'}),e=>e.code==='research_provider_limit');assert.equal(calls,1);
 assert.equal(createWebResearch({enabled:false,keyless:true}).configured,false);
});

test('keyless config is off by default, explicit opt-in and rejects malformed flag', async () => {
 const {loadServerConfig}=await import('../../apps/web/lib/config.mjs');
 const base={AUTH_PROVIDER:'workos',WORKOS_API_KEY:'sk_test_key',WORKOS_CLIENT_ID:'client_1234',WORKOS_REDIRECT_URI:'http://localhost:3100/auth/callback',TURSO_DATABASE_URL:'file:./local.db'};
 assert.equal(loadServerConfig(base).webResearchTavilyKeyless,false);
 assert.equal(loadServerConfig({...base,WEB_RESEARCH_TAVILY_KEYLESS:'1'}).webResearchTavilyKeyless,true);
 assert.throws(()=>loadServerConfig({...base,WEB_RESEARCH_TAVILY_KEYLESS:'maybe'}),/WEB_RESEARCH_TAVILY_KEYLESS/);
});

test('shopping candidate ranking uses only explicit model and GPU hints and warns matches are unverified',async()=>{
 const {selectResearchCandidates}=await import('../../apps/web/lib/ai-agent/web-research.mjs');
 const results=[{url:'https://jiji.ng/ikeja/computers-and-laptops/a.html',title:'HP Victus',content:'budget laptop'}, {url:'https://jiji.ng/ikeja/computers-and-laptops/b.html',title:'HP Omen',content:'RTX 2070 laptop'}, {url:'https://jiji.ng/ikeja/computers-and-laptops/c.html',title:'HP Omen',content:'GTX 1060 laptop'}, {url:'https://jiji.ng/ikeja/computers-and-laptops/d.html',title:'Other',content:'RTX 2070'}];
 const q='Find HP Omen RTX 2070 laptops in Lagos under ₦1,000,000';const selected=selectResearchCandidates(results,false,q);
 assert.equal(selected[0].url,results[1].url);assert(!selected.some(s=>s.url===results[0].url));
 assert.equal(selectResearchCandidates(results,false,'What are laptops?')[0].url,results[0].url);
 assert.match(researchSourcesMarkdown({sources:[{id:1,title:'Example',url:results[0].url,pageRead:false}],retrievedAt:'2026-11-06'},q),/requested specifications are not verified/);
});
