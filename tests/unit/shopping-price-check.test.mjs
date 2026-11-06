import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNairaCeiling,reportedJijiPrice,shoppingPriceEvidence} from '../../apps/web/lib/ai-agent/shopping-price-check.mjs';
import {researchAnswerForDisplay,researchSourcesMarkdown} from '../../apps/web/lib/ai-agent/web-research.mjs';
const url='https://jiji.ng/ikeja/computers-and-laptops/laptop-hp-omen-15-32gb-intel-core-i7-ssd-512gb-8zuDVQt11i372rztKA91fM7.html';
const source=(text)=>({title:'Laptop HP Omen',url,excerpt:text,pageRead:false});
test('naira budgets use exact integer money and honor strict and inclusive limits',()=>{
 for(const q of ['Budget maximum 1,000,000 NGN','up to ₦1 million','at most ₦1,000,000','at or below 1000000 naira'])assert.deepEqual(parseNairaCeiling(q),{kobo:100000000,inclusive:true},q);
 assert.deepEqual(parseNairaCeiling('under ₦1,000,000'),{kobo:100000000,inclusive:false});
 assert.deepEqual(parseNairaCeiling('below 999999.50 NGN'),{kobo:99999950,inclusive:false});
});
test('ambiguous, mixed, unsupported or multiple budgets never become a numeric filter',()=>{
 for(const q of ['laptop budget','under $100','under 1000000','between ₦500,000 and ₦1,000,000','not under ₦1,000,000','at least ₦500,000 up to ₦1,000,000','under ₦1,000,000 or under ₦800,000','under 1,00 NGN','under ₦1,000,000 USD','budget maximum ₦1,000,000 per month'])assert.equal(parseNairaCeiling(q),null,q);
});
test('only individual Jiji listing explicit current-labeled price fields qualify',()=>{
 assert.equal(reportedJijiPrice(source('Price: ₦ 990,000. Market price: ₦ 1.07 M ~ 1.27 M')),99000000);
 assert.equal(reportedJijiPrice({...source('Price: ₦990,000'),title:'Price: ₦ 990000'}),99000000);
 for(const text of ['₦990,000','Market price: ₦990,000','Price: ₦990,000 to ₦1,000,000','Previous price: ₦990,000','Price: ₦990,000 Price: ₦1,100,000','Price: ₦1,00','Price: $990,000'])assert.equal(reportedJijiPrice(source(text)),null,text);
 assert.equal(reportedJijiPrice({...source('Price: ₦990,000'),url:'https://jiji.ng/ikeja/computers-and-laptops/hp-omen'}),null);
 assert.equal(reportedJijiPrice({...source('Price: ₦990,000'),url:'https://evil.example/item.html'}),null);
});
test('budget checks use source evidence not LLM claims; equality and inclusive vs exclusive differ',()=>{
 const research={retrievedAt:'2026-11-06T12:00:00Z',sources:[source('Price: ₦990,000'),source('Price: ₦1,100,000'),source('Price: ₦1,000,000'),source('Price unknown')]};
 const q='/research Find laptops at or below 1,000,000 NGN';const text=researchSourcesMarkdown(research,q);
 assert.match(text,/\[1\] Reported price ₦990,000 — within stated item-price limit/);
 assert.match(text,/\[2\] Reported price ₦1,100,000 — over stated item-price limit/);
 assert.match(text,/\[3\] Reported price ₦1,000,000 — within stated item-price limit/);
 assert.match(text,/\[4\] Price or listing evidence ambiguous/);
 assert.match(shoppingPriceEvidence(research,'/research laptops under ₦1,000,000'),/\[3\] Reported price ₦1,000,000 — over/);
 assert.match(shoppingPriceEvidence(research,'/research site:jiji.ng/ikeja laptop'),/budget limit not unambiguously stated/);
 assert.doesNotMatch(researchAnswerForDisplay('₦1,100,000 is inside the budget',q),/₦1,100,000/);
 assert.match(text,/delivery and other fees are not verified/);
});

test('negated, ranged and mixed-currency price evidence is not compared',()=>{
 for(const q of ['not maximum ₦1,000,000','budget ₦500,000 to ₦1,000,000','budget maximum ₦500,000–₦1,000,000','up to ₦1,000,000 or $600'])assert.equal(parseNairaCeiling(q),null,q);
 assert.equal(reportedJijiPrice(source('Price: ₦990,000. Price: USD 600')),null);
});
