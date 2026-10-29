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
