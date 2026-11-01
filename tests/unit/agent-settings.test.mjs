import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentExtensions, defaultAgentExtensions, agentToolAccess, assertAgentToolAccess } from '../../apps/web/lib/ai-agent/agent-settings.mjs';
test('new agent tools default off and reject unknown permissions or coercion',()=>{
 assert.deepEqual(Object.values(defaultAgentExtensions().toolPermissions),[false,false,false,false]);
 assert.deepEqual(normalizeAgentExtensions({}),{});
 for(const toolPermissions of [null,[],{web_search:'true'},{send_email:true},{__unknown:true}]) assert.throws(()=>normalizeAgentExtensions({toolPermissions}));
 assert.equal(normalizeAgentExtensions({toolPermissions:{web_search:true}}).toolPermissions.read_files,false);
});
test('instructions are bounded plain text; clearing them is supported',()=>{
 assert.deepEqual(normalizeAgentExtensions({instructions:'  concise\nwith sources  '}),{instructions:'concise\nwith sources'});
 assert.equal(normalizeAgentExtensions({instructions:''}).instructions,'');
 for(const instructions of [42,null,'a'.repeat(4001),'hello\u0000world'])assert.throws(()=>normalizeAgentExtensions({instructions}));
});
test('agent permission and server readiness are independent and fail closed',()=>{
 const allowed={settings:{toolPermissions:{web_search:true}}};
 assert.equal(agentToolAccess(allowed,'web_search').reason,'tool_not_installed');
 assert.throws(()=>assertAgentToolAccess(allowed,'web_search'),/tool_not_installed/);
 assert.throws(()=>assertAgentToolAccess({},'web_search',{web_search:{ready:true}}),/agent_tool_disabled/);
 assert.doesNotThrow(()=>assertAgentToolAccess(allowed,'web_search',{web_search:{ready:true}}));
 assert.throws(()=>assertAgentToolAccess(allowed,'send_email'),/unknown_tool/);
});
