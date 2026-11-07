import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkspaceToolCall,
  prepareWorkspaceToolCall,
  workspaceAgentFingerprint,
  workspaceNameFingerprint,
} from '../../apps/web/lib/ai-agent/workspace-tools.mjs';

const bootstrap = () => ({
  workspace: { id: 'ws-user-1', name: 'Personal workspace', status: 'active', role: 'owner' },
  agents: [{
    id: 'agt-helper-1', name: 'Desk Helper', role: 'Organize my workspace', avatar: 'bulb', status: 'paused',
    settings: {
      color: '#32d583', approvalPath: 'desktop', orderCap: 100, dailyCap: 200,
      apps: [], memoryPills: [], previewOnly: true,
    },
  }],
});

test('workspace tool protocol accepts one standalone bounded JSON marker and rejects mixed or repeated markers', () => {
  const call = parseWorkspaceToolCall('[[KEUS_WORKSPACE_TOOL:{"name":"inspect_workspace","arguments":{}}]]');
  assert.deepEqual(call, { kind: 'tool', name: 'inspect_workspace', arguments: {} });
  assert.deepEqual(parseWorkspaceToolCall('A normal response.'), { kind: 'none', text: 'A normal response.' });
  assert.equal(parseWorkspaceToolCall('I will inspect it.\n[[KEUS_WORKSPACE_TOOL:{"name":"inspect_workspace","arguments":{}}]]').kind, 'invalid');
  assert.equal(parseWorkspaceToolCall('[[KEUS_WORKSPACE_TOOL:{"name":"inspect_workspace","arguments":{}}]]\n[[KEUS_WORKSPACE_TOOL:{"name":"inspect_workspace","arguments":{}}]]').kind, 'invalid');
  assert.equal(parseWorkspaceToolCall('[[KEUS_WORKSPACE_TOOL:{"name":"inspect_workspace","arguments":[]}]]').kind, 'invalid');
  assert.equal(parseWorkspaceToolCall(`[[KEUS_WORKSPACE_TOOL:${'x'.repeat(5000)}]]`).kind, 'invalid');
});

test('workspace inspection exposes only the signed-in workspace summary and minimal agent fields', () => {
  const view = prepareWorkspaceToolCall({ name: 'inspect_workspace', arguments: {} }, bootstrap());
  assert.equal(view.kind, 'read');
  assert.match(view.text, /Personal workspace/);
  assert.match(view.text, /Desk Helper: Organize my workspace · bulb · paused/);
  assert.doesNotMatch(view.text, /ws-user-1|agt-helper-1|previewOnly|orderCap|settings/);
});

test('creating an agent returns a conservative paused proposal but performs no write', () => {
  const view = prepareWorkspaceToolCall({
    name: 'create_agent',
    arguments: { name: 'Planning Helper', role: 'Planning assistant', avatar: 'laptop' },
  }, bootstrap());
  assert.equal(view.kind, 'proposal');
  assert.equal(view.type, 'create_agent');
  assert.deepEqual(view.payload.input, {
    name: 'Planning Helper', role: 'Planning assistant', avatar: 'laptop', color: '#32d583',
    approvalPath: 'desktop', orderCap: 20, dailyCap: 100, apps: [], memoryPills: [],
  });
  assert.match(view.display.summary, /Active for chat and remain preview-only/);
  assert.equal(view.display.fields.at(-1).value, 'Active · preview-only');
});

test('agent edits are exact patches against a workspace-owned agent and cannot change status or external permissions', () => {
  const source = bootstrap();
  const current = source.agents[0];
  const before = workspaceAgentFingerprint(current);
  const view = prepareWorkspaceToolCall({
    name: 'update_agent',
    arguments: { agentName: 'Desk Helper', changes: { role: 'Plan my calendar', dailyCap: 250 } },
  }, source);
  assert.equal(view.kind, 'proposal');
  assert.equal(view.type, 'update_agent');
  assert.equal(view.payload.agentId, 'agt-helper-1');
  assert.equal(view.payload.agentName, 'Desk Helper');
  assert.equal(view.payload.input.role, 'Plan my calendar');
  assert.equal(view.payload.input.dailyCap, 250);
  assert.equal(view.payload.input.orderCap, 100);
  assert.equal(view.payload.expectedFingerprint, before);
  assert.deepEqual(view.display.fields, [
    { label: 'role', before: 'Organize my workspace', value: 'Plan my calendar' },
    { label: 'Daily cap', before: '$200 USD', value: '$250 USD' },
  ]);
  assert.equal(current.role, 'Organize my workspace', 'preparing an edit does not mutate the workspace snapshot');
  assert.throws(() => prepareWorkspaceToolCall({
    name: 'update_agent', arguments: { agentName: 'Desk Helper', changes: { status: 'active' } },
  }, source), /workspace_tool_arguments_invalid/);
  assert.throws(() => prepareWorkspaceToolCall({
    name: 'update_agent', arguments: { agentName: 'Someone else', changes: { role: 'x' } },
  }, source), /agent_not_found/);
});

test('workspace rename is confirmation-only and binds the proposal to the current workspace snapshot', () => {
  const source = bootstrap();
  const fingerprint = workspaceNameFingerprint(source.workspace);
  const view = prepareWorkspaceToolCall({ name: 'rename_workspace', arguments: { name: 'Studio Workspace' } }, source);
  assert.equal(view.kind, 'proposal');
  assert.equal(view.type, 'rename_workspace');
  assert.equal(view.payload.name, 'Studio Workspace');
  assert.equal(view.payload.expectedFingerprint, fingerprint);
  assert.equal(source.workspace.name, 'Personal workspace');
  assert.throws(() => prepareWorkspaceToolCall({ name: 'rename_workspace', arguments: { name: 'Personal workspace' } }, source), /workspace_tool_no_change/);
});

test('unsupported tools, extra arguments, and out-of-policy settings fail closed', () => {
  const source = bootstrap();
  assert.throws(() => prepareWorkspaceToolCall({ name: 'delete_agent', arguments: { agentName: 'Desk Helper' } }, source), /workspace_tool_not_allowed/);
  assert.throws(() => prepareWorkspaceToolCall({ name: 'inspect_workspace', arguments: { workspaceId: 'other' } }, source), /workspace_tool_arguments_invalid/);
  assert.throws(() => prepareWorkspaceToolCall({
    name: 'create_agent', arguments: { name: 'Unsafe Helper', role: 'helper', avatar: 'bulb', apps: ['webhook'] },
  }, source), /invalid_apps/);
  assert.throws(() => prepareWorkspaceToolCall({
    name: 'create_agent', arguments: { name: 'Bad Cap', role: 'helper', avatar: 'bulb', dailyCap: 230 },
  }, source), /invalid_daily_spend_cap/);
});

test('search_products tool accepts structured price, availability, sort, and merchant filters', () => {
  const source = bootstrap();
  const search1 = prepareWorkspaceToolCall({
    name: 'search_products',
    arguments: {
      query: 'mechanical keyboard',
      minPrice: 50,
      maxPrice: 150,
      currency: 'USD',
      availability: 'in_stock',
      sortBy: 'price_asc',
      merchantDomain: 'keychron.com',
      limit: 12,
    },
  }, source);

  assert.equal(search1.kind, 'search_products');
  assert.equal(search1.query, 'mechanical keyboard');
  assert.equal(search1.limit, 12);
  assert.deepEqual(search1.filters, {
    min_price: 50,
    max_price: 150,
    availability: 'in_stock',
    sort_by: 'price_asc',
    merchant_domain: 'keychron.com',
  });

  const search2 = prepareWorkspaceToolCall({
    name: 'search_products',
    arguments: {
      query: 'ergonomic mouse',
      sortBy: 'price_desc',
      availability: 'any',
    },
  }, source);
  assert.equal(search2.query, 'ergonomic mouse');
  assert.equal(search2.filters.sort_by, 'price_desc');
  assert.equal(search2.filters.availability, 'any');

  // Fails closed on invalid filters
  assert.throws(() => prepareWorkspaceToolCall({
    name: 'search_products',
    arguments: { query: 'laptop', minPrice: -10 },
  }, source), /workspace_tool_arguments_invalid/);

  assert.throws(() => prepareWorkspaceToolCall({
    name: 'search_products',
    arguments: { query: 'laptop', maxPrice: 0 },
  }, source), /workspace_tool_arguments_invalid/);

  assert.throws(() => prepareWorkspaceToolCall({
    name: 'search_products',
    arguments: { query: 'laptop', sortBy: 'unknown_sort' },
  }, source), /workspace_tool_arguments_invalid/);

  assert.throws(() => prepareWorkspaceToolCall({
    name: 'search_products',
    arguments: { query: 'laptop', availability: 'invalid_avail' },
  }, source), /workspace_tool_arguments_invalid/);

  assert.throws(() => prepareWorkspaceToolCall({
    name: 'search_products',
    arguments: { query: 'laptop', limit: 100 },
  }, source), /workspace_tool_arguments_invalid/);

  assert.throws(() => prepareWorkspaceToolCall({
    name: 'search_products',
    arguments: { query: 'laptop', unexpectedKey: true },
  }, source), /workspace_tool_arguments_invalid/);
});

test('purchase_product tool accepts multi-product bundles and enforces structural validation', () => {
  const source = bootstrap();
  const bundleCall = prepareWorkspaceToolCall({
    name: 'purchase_product',
    arguments: {
      items: [
        { offerId: 'off_item1' },
        {
          productTitle: 'Desk Pad',
          merchantDomain: 'grovemade.com',
          amountMinor: 4500,
          currency: 'USD',
          evidenceHash: 'sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        },
      ],
    },
  }, source);

  assert.equal(bundleCall.kind, 'purchase_product');
  assert.equal(bundleCall.items.length, 2);
  assert.equal(bundleCall.items[0].offerId, 'off_item1');
  assert.equal(bundleCall.items[1].productTitle, 'Desk Pad');
  assert.equal(bundleCall.items[1].amountMinor, 4500);

  // Fails closed on empty items or > 10 items
  assert.throws(() => prepareWorkspaceToolCall({
    name: 'purchase_product',
    arguments: { items: [] },
  }, source), /workspace_tool_arguments_invalid/);

  assert.throws(() => prepareWorkspaceToolCall({
    name: 'purchase_product',
    arguments: { items: Array.from({ length: 11 }, () => ({ offerId: 'off_1' })) },
  }, source), /workspace_tool_arguments_invalid/);

  // Fails on invalid item structure
  assert.throws(() => prepareWorkspaceToolCall({
    name: 'purchase_product',
    arguments: { items: [{ unexpectedKey: true }] },
  }, source), /workspace_tool_arguments_invalid/);
});


test('agent proposals remove app and approval preferences while preserving legacy data on unrelated edits', () => {
  const source = bootstrap();
  source.agents[0].settings.apps = ['channel3'];
  const created = prepareWorkspaceToolCall({name:'create_agent',arguments:{name:'New helper',role:'Shopping',avatar:'bulb'}},source);
  assert.equal(created.payload.input.approvalPath, 'desktop');
  assert.deepEqual(created.payload.input.apps, []);
  assert.ok(created.display.fields.every(f=> !/apps|approval path/i.test(f.label)));
  const edited = prepareWorkspaceToolCall({name:'update_agent',arguments:{agentName:'Desk Helper',changes:{role:'Compare prices'}}},source);
  assert.deepEqual(edited.payload.input.apps, ['channel3']);
  for (const changes of [{apps:['channel3']},{approvalPath:'keyfob'}]) {
    assert.throws(()=>prepareWorkspaceToolCall({name:'update_agent',arguments:{agentName:'Desk Helper',changes}},source),/workspace_tool_arguments_invalid/);
    assert.throws(()=>prepareWorkspaceToolCall({name:'create_agent',arguments:{name:'New helper',role:'Shopping',avatar:'bulb',...changes}},source),/workspace_tool_arguments_invalid/);
  }
});

test('purchase tools preserve requested quantities and reject fractions, strings and duplicate offers',()=>{const source=bootstrap();for(const quantity of [1,3,20]){const tool=prepareWorkspaceToolCall({name:'purchase_product',arguments:{offerId:'offer-1',quantity}},source);assert.equal(tool.quantity,quantity);}for(const quantity of [0,21,1.5,'2',null])assert.throws(()=>prepareWorkspaceToolCall({name:'purchase_product',arguments:{offerId:'offer-1',quantity}},source),/arguments_invalid/);const bundle=prepareWorkspaceToolCall({name:'purchase_bundle',arguments:{items:[{offerId:'one',quantity:2},{offerId:'two',quantity:3}]}},source);assert.deepEqual(bundle.items.map(i=>i.quantity),[2,3]);assert.throws(()=>prepareWorkspaceToolCall({name:'purchase_bundle',arguments:{items:[{offerId:'same',quantity:2},{offerId:'same',quantity:3}]}},source),/arguments_invalid/);});

test('purchase claim guard recognizes direct review requests but not comparison, negation or attachments',async()=>{
  const {isPurchaseReviewRequest,NO_PURCHASE_CHECK_REPLY}=await import('../../apps/web/lib/ai-agent/workspace-tools.mjs');
  for(const text of ['Buy 3 notebooks','Please purchase this item','Prepare a fresh purchase review for 3 notebooks','Please re-check the spending policy'])assert.equal(isPurchaseReviewRequest(text),true,text);
  for(const text of ['Do not buy anything','Compare these notebooks','Explain yesterday’s purchase','/research buy notebooks','The document says buy three'])assert.equal(isPurchaseReviewRequest(text),false,text);
  assert.match(NO_PURCHASE_CHECK_REPLY,/No new purchase review/);
  assert.match(NO_PURCHASE_CHECK_REPLY,/Earlier budget decisions may be out of date/);
});

test('explicit saved-offer review requires precise consent and refuses ambiguous trailing instructions',async()=>{
 const {explicitSavedOfferReview,prepareWorkspaceToolCall}=await import('../../apps/web/lib/ai-agent/workspace-tools.mjs');
 const a='off_'+'a'.repeat(32),b='off_'+'b'.repeat(32);const message=`Prepare a purchase review for 2 units of saved offer ${a} and 3 units of saved offer ${b}. Use the saved offers and the specified quantities. Do not approve the review, open PayPal, authorize, capture, or pay.`;
 const tool=explicitSavedOfferReview(message);assert.deepEqual(tool.arguments.items,[{offerId:a,quantity:2},{offerId:b,quantity:3}]);
 assert.deepEqual(prepareWorkspaceToolCall(tool,bootstrap()).items,tool.arguments.items);
 assert.equal(explicitSavedOfferReview(`Do not prepare a purchase review for 2 units of saved offer ${a} and 3 units of saved offer ${b}.`),null);
 assert.equal(explicitSavedOfferReview(`Prepare a purchase review for 2 units of saved offer ${a} and 3 units of saved offer ${b}. Actually make the first 4.`),null);
 assert.equal(explicitSavedOfferReview(`Prepare a purchase review for 2 units of saved offer ${a} and 3 units of saved offer ${b}. Do not prepare the review.`),null);
 assert.throws(()=>prepareWorkspaceToolCall(explicitSavedOfferReview(`Prepare a purchase review for 21 units of saved offer ${a} and 3 units of saved offer ${b}.`),bootstrap()),/arguments_invalid/);
 assert.throws(()=>prepareWorkspaceToolCall(explicitSavedOfferReview(`Prepare a purchase review for 2 units of saved offer ${a} and 3 units of saved offer ${a}.`),bootstrap()),/arguments_invalid/);
});

test('explicit single saved-offer review requires precise consent and rejects ambiguous requests',async()=>{
 const {explicitSavedOfferReview,prepareWorkspaceToolCall}=await import('../../apps/web/lib/ai-agent/workspace-tools.mjs');
 const id='off_'+'a'.repeat(32);
 for (const suffix of ['', ' Do not approve the review, open PayPal, authorize, capture, or pay.', ' Use the saved offers and the specified quantities. Do not approve the review, open PayPal, authorize, capture, or pay.']) {
  const tool=explicitSavedOfferReview(`Prepare a purchase review for 1 unit of saved offer ${id}.${suffix}`);
  assert.deepEqual(tool.arguments.items,[{offerId:id,quantity:1}]);assert.deepEqual(prepareWorkspaceToolCall(tool,bootstrap()).items,tool.arguments.items);
 }
 for(const text of [`Do not prepare a purchase review for 1 unit of saved offer ${id}.`,`Prepare a purchase review for 1 unit of saved offer ${id}. Do not prepare the review.`,`Prepare a purchase review for 1 unit of saved offer ${id}. Actually make it 5.`,`Prepare a purchase review for 1 unit of saved offer ${id} and 2 units of saved offer invalid.`])assert.equal(explicitSavedOfferReview(text),null,text);
 for(const quantity of [0,21])assert.throws(()=>prepareWorkspaceToolCall(explicitSavedOfferReview(`Prepare a purchase review for ${quantity} units of saved offer ${id}.`),bootstrap()),/arguments_invalid/);
});

test('quantity-change interpretation requires a clear review request and suppresses unverified follow-up claims',async()=>{
 const {explicitBundleQuantityChange,isPendingPurchaseChangeRequest}=await import('../../apps/web/lib/ai-agent/workspace-tools.mjs');
 const message='Actually make the second notebook quantity 4 and keep the first notebook quantity 2. Prepare a new review only. Do not approve either review, open PayPal, authorize, capture, or pay.';
 assert.deepEqual(explicitBundleQuantityChange(message),{secondKind:'notebook',secondQuantity:4,firstKind:'notebook',firstQuantity:2});
 assert.equal(explicitBundleQuantityChange('Actually make the second notebook quantity 4 and keep the first notebook quantity 2. Do not prepare a new review.'),null);
 assert.equal(explicitBundleQuantityChange(message+' Actually make it 8.'),null);
 assert.equal(isPendingPurchaseChangeRequest('Actually make it 5, and prepare a new review.',true),true);
 assert.equal(isPendingPurchaseChangeRequest('Actually make it 5, and prepare a new review.',false),false);
});
