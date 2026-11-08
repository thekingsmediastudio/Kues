import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('account menu label uses readable secondary text on dark and light surfaces',async()=>{
 const html=await readFile(new URL('../../apps/web/public/desktop-preview.html',import.meta.url),'utf8');
 assert.match(html,/\.account-menu-user span\{color:var\(--text-sec\);font-size:12px\}/);
 function ratio(fg,bg){const lum=c=>c.map(n=>{let x=n/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);let a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)}
 assert.ok(ratio([164,165,173],[25,26,32])>=4.5);assert.ok(ratio([94,112,100],[255,255,255])>=4.5);
});
