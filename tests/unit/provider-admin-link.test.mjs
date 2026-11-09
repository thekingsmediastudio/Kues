import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../apps/web/public/desktop-preview.html',import.meta.url),'utf8');
const server=readFileSync(new URL('../../apps/web/server.mjs',import.meta.url),'utf8');
test('provider management link points to the actual authenticated admin route',()=>{
  assert.match(html,/<a href="\/admin\/ai-providers" target="_blank" rel="noopener">Manage provider connections<\/a>/);
  assert.match(server,/url\.pathname === '\/admin\/ai-providers'/);
  assert.doesNotMatch(html,/href="\/ai-providers-admin"/);
});
