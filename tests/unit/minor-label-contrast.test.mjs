import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('agent roles, account detail and small notices use readable theme colors',async()=>{
 const html=await readFile(new URL('../../apps/web/public/desktop-preview.html',import.meta.url),'utf8');
 for(const re of [/\.agent-preview \{ font-size:11\.5px;color:var\(--text-sec\); \}/,/:root\[data-theme="light"\] \.agent-preview\s*\{\s*color: #4e6355;/,/\.account-trigger-copy small\{margin-top:2px;color:var\(--text-sec\);/,/\.composer-preview-note\{margin:7px 6px 0;color:var\(--text-sec\);/,/\.header-coming-soon\{[^}]*color:var\(--text-sec\)\}/])assert.match(html,re);
 const l=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);const r=(a,b)=>(Math.max(l(a),l(b))+.05)/(Math.min(l(a),l(b))+.05);
 assert.ok(r([164,165,173],[45,45,50])>=4.5);assert.ok(r([94,112,100],[239,242,237])>=4.5);assert.ok(r([78,99,85],[239,242,237])>=4.5);
});
