import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('agent status text uses readable dark and light theme colors',async()=>{
 const html=await readFile(new URL('../../apps/web/public/desktop-preview.html',import.meta.url),'utf8');
 assert.match(html,/\.agent-row\[data-status="paused"\] \.agent-time\s*\{\s*color:\s*var\(--text-sec\)/);
 assert.match(html,/\.agent-time \{ color:var\(--text-sec\); \}/);
 assert.match(html,/:root\[data-theme="light"\] \.agent-time\s*\{\s*color:\s*#4e6355/);
 assert.match(html,/:root\[data-theme="light"\] \.agent-row\[data-status="active"\] \.agent-time\s*\{\s*color:\s*#147548/);
 const l=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);const ratio=(a,b)=>(Math.max(l(a),l(b))+.05)/(Math.min(l(a),l(b))+.05);
 for(const fg of [[78,99,85],[20,117,72]])assert.ok(ratio(fg,[239,242,237])>=4.5);
 assert.ok(ratio([164,165,173],[45,45,50])>=4.5);
});
