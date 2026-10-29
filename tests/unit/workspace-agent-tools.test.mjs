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
