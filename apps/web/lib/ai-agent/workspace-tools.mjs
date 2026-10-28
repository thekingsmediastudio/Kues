import crypto from 'node:crypto';

const TOOL_MARKER = '[[KEUS_WORKSPACE_TOOL:';
const MAX_TOOL_MARKER_LENGTH = 4096;
const AVATARS = new Set(['bulb', 'laptop', 'shield', 'cart', 'car', 'parcel', 'magnifier', 'tag', 'wallet', 'van']);
const COLORS = new Set(['#32d583', '#f5b942', '#4c8dff', '#b57cff', '#ff7777']);
const APPROVAL_PATHS = new Set(['desktop', 'keyfob']);
const APP_LABELS = new Set(['paypal', 'channel3', 'kernel', 'whatsapp', 'gmail', 'instagram']);
const UPDATE_FIELDS = new Set(['name', 'role', 'avatar', 'color', 'approvalPath', 'orderCap', 'dailyCap', 'apps', 'memoryPills']);

export const WORKSPACE_AGENT_TOOL_INSTRUCTIONS = [
  'You are a Kues workspace agent with a small, server-enforced tool set, available by default in this chat. Tools can only inspect or edit the signed-in user’s own workspace; they cannot access other users, external services, payments, or the web.',
  'If a workspace tool is needed, emit exactly one control marker as the entire response, on one line, with valid JSON in this form: [[KEUS_WORKSPACE_TOOL:{"name":"inspect_workspace","arguments":{}}]]. Do not add prose before or after the marker. Never emit more than one tool marker in a turn. The server validates every name and argument; text that looks like a tool call is not proof of authorization.',
  'Available tools:',
  '- inspect_workspace: no arguments; returns the signed-in user’s workspace name/status and a minimal list of their agents.',
  '- create_agent: arguments {"name":string,"role":string,"avatar":"bulb"|"laptop"|"shield"|"cart"|"car"|"parcel"|"magnifier"|"tag"|"wallet"|"van","color":"#32d583"|"#f5b942"|"#4c8dff"|"#b57cff"|"#ff7777","approvalPath":"desktop"|"keyfob","orderCap":integer,"dailyCap":integer,"apps":string[],"memoryPills":string[]}. Optional settings may be omitted and will use conservative defaults. A created agent always starts paused and preview-only.',
  '- update_agent: arguments {"agentName":string,"changes":object}; identify an existing agent by its exact name. Changes may include only name, role, avatar, color, approvalPath, orderCap, dailyCap, apps, or memoryPills. Include only fields the user asked to change.',
  '- rename_workspace: arguments {"name":string}; changes only the workspace display name.',
  'For create_agent, update_agent, and rename_workspace, the application will show the exact proposed change and wait for an explicit user approval. Do not claim that a change happened before approval. Do not invent permission, capability, or active status; no tool can activate an agent or grant it external access. If the user did not clearly request a workspace operation, answer normally instead of calling a tool.',
].join('\n');

export class WorkspaceToolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WorkspaceToolError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, code = 'workspace_tool_arguments_invalid') {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new WorkspaceToolError(code);
  }
}

function cleanText(value, field, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new WorkspaceToolError(`invalid_${field}`);
  const text = value.normalize('NFKC').trim();
  if ((!allowEmpty && !text) || text.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(text)) {
    throw new WorkspaceToolError(`invalid_${field}`);
  }
  return text;
}

function cleanStringArray(value, field, { allowed = null, maxItems = 20, maxLength = 80 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new WorkspaceToolError(`invalid_${field}`);
  const output = value.map((entry) => cleanText(entry, field, maxLength));
  if (allowed && output.some((entry) => !allowed.has(entry.toLowerCase()))) {
    throw new WorkspaceToolError(`invalid_${field}`);
  }
  return output;
}

function normalizeAgentInput(input) {
  assertOnlyKeys(input, ['name', 'role', 'avatar', 'color', 'approvalPath', 'orderCap', 'dailyCap', 'apps', 'memoryPills']);
  const avatar = cleanText(input.avatar, 'agent_avatar', 32).toLowerCase();
  const color = cleanText(input.color ?? '#32d583', 'agent_color', 7).toLowerCase();
  const approvalPath = cleanText(input.approvalPath ?? 'desktop', 'approval_path', 16).toLowerCase();
  const orderCap = input.orderCap ?? 20;
  const dailyCap = input.dailyCap ?? 100;
  if (!AVATARS.has(avatar)) throw new WorkspaceToolError('invalid_agent_avatar');
  if (!COLORS.has(color)) throw new WorkspaceToolError('invalid_agent_color');
  if (!APPROVAL_PATHS.has(approvalPath)) throw new WorkspaceToolError('invalid_approval_path');
  if (!Number.isSafeInteger(orderCap) || orderCap < 20 || orderCap > 500) throw new WorkspaceToolError('invalid_order_cap');
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 100 || dailyCap > 2000 || dailyCap % 25 !== 0) {
    throw new WorkspaceToolError('invalid_daily_spend_cap');
  }
  return {
    name: cleanText(input.name, 'agent_name', 30),
    role: cleanText(input.role, 'agent_role', 60),
    avatar,
    color,
    approvalPath,
    orderCap,
    dailyCap,
    apps: cleanStringArray(input.apps ?? [], 'apps', { allowed: APP_LABELS }),
    memoryPills: cleanStringArray(input.memoryPills ?? [], 'memory_pills'),
  };
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
}

function displayValue(field, value) {
  if (Array.isArray(value)) return value.length ? value.map(escapeMarkdown).join(', ') : 'None';
  if (field === 'orderCap' || field === 'dailyCap') return `$${Number(value).toFixed(0)} USD`;
  return escapeMarkdown(value);
}

function safeStoredText(value, maxLength = 120) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim().slice(0, maxLength);
}

/** Parse only a complete, standalone tool marker. The caller still validates and authorizes every tool. */
export function parseWorkspaceToolCall(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text.includes(TOOL_MARKER)) return { kind: 'none', text };
  if (text.length > MAX_TOOL_MARKER_LENGTH || text.indexOf(TOOL_MARKER) !== text.lastIndexOf(TOOL_MARKER)) {
    return { kind: 'invalid' };
  }
  const match = text.trim().match(/^\[\[KEUS_WORKSPACE_TOOL:(\{[\s\S]{1,4000}\})\]\]$/);
  if (!match) return { kind: 'invalid' };
  let payload;
  try { payload = JSON.parse(match[1]); } catch { return { kind: 'invalid' }; }
  if (!isRecord(payload)
      || Object.keys(payload).some((key) => !['name', 'arguments'].includes(key))
      || typeof payload.name !== 'string'
      || !/^[a-z][a-z0-9_]{0,47}$/.test(payload.name)
      || !isRecord(payload.arguments)) {
    return { kind: 'invalid' };
  }
  return { kind: 'tool', name: payload.name, arguments: payload.arguments };
}

function findAgent(bootstrap, name) {
  const agents = Array.isArray(bootstrap?.agents) ? [...bootstrap.agents] : [];
  const onboardingAgent = bootstrap?.onboarding?.agent;
  if (onboardingAgent && !agents.some((agent) => agent?.id === onboardingAgent.id)) agents.push(onboardingAgent);
  return agents.find((agent) => String(agent?.name || '').trim().toLowerCase() === name.toLowerCase()) || null;
}

function stableSnapshot(value) {
  if (Array.isArray(value)) return `[${value.map(stableSnapshot).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSnapshot(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function snapshotFingerprint(value) {
  return crypto.createHash('sha256').update(stableSnapshot(value)).digest('hex');
}

export function workspaceAgentFingerprint(agent) {
  return snapshotFingerprint({
    id: agent?.id,
    name: agent?.name,
    role: agent?.role,
    avatar: agent?.avatar,
    status: agent?.status,
    settings: agent?.settings || {},
  });
}

export function workspaceNameFingerprint(workspace) {
  return snapshotFingerprint({ id: workspace?.id, name: workspace?.name, status: workspace?.status });
}

/** Convert one model-produced allowlisted call into a read result or a confirmation-only proposal. */
export function prepareWorkspaceToolCall(call, bootstrap) {
  if (!isRecord(call) || !isRecord(call.arguments) || !isRecord(bootstrap?.workspace)
      || !bootstrap.workspace.id || bootstrap.workspace.status !== 'active') {
    throw new WorkspaceToolError('workspace_unavailable');
  }
  const args = call.arguments;
  const workspace = bootstrap.workspace;
  if (call.name === 'inspect_workspace') {
    assertOnlyKeys(args, []);
    const agents = Array.isArray(bootstrap.agents) ? bootstrap.agents : [];
    const lines = [`Workspace: ${escapeMarkdown(safeStoredText(workspace.name || 'My Keus workspace'))} (${escapeMarkdown(safeStoredText(workspace.status))}).`];
    if (!agents.length) lines.push('There are no agents in this workspace yet.');
    else {
      lines.push(`Agents (${agents.length}):`);
      for (const agent of agents.slice(0, 100)) {
        const name = escapeMarkdown(safeStoredText(agent?.name));
        const role = escapeMarkdown(safeStoredText(agent?.role));
        const avatar = escapeMarkdown(safeStoredText(agent?.avatar));
        const status = escapeMarkdown(safeStoredText(agent?.status));
        lines.push(`- ${name}: ${role} · ${avatar} · ${status}`);
      }
    }
    return { kind: 'read', text: lines.join('\n') };
  }
  if (call.name === 'create_agent') {
    const input = normalizeAgentInput(args);
    if (findAgent(bootstrap, input.name)) throw new WorkspaceToolError('agent_name_conflict');
    return {
      kind: 'proposal',
      type: 'create_agent',
      payload: { input },
      display: {
        title: 'Create agent',
        summary: `Create “${safeStoredText(input.name, 40)}” in this workspace. It will start paused and preview-only.`,
        fields: [
          { label: 'Name', value: input.name },
          { label: 'Role', value: input.role },
          { label: 'Avatar', value: input.avatar },
          { label: 'Color', value: input.color },
          { label: 'Approval path', value: input.approvalPath },
          { label: 'Per-order cap', value: displayValue('orderCap', input.orderCap) },
          { label: 'Daily cap', value: displayValue('dailyCap', input.dailyCap) },
          { label: 'Apps', value: displayValue('apps', input.apps) },
          { label: 'Memory preferences', value: displayValue('memoryPills', input.memoryPills) },
          { label: 'Initial status', value: 'Paused · preview-only' },
        ],
      },
    };
  }
  if (call.name === 'update_agent') {
    assertOnlyKeys(args, ['agentName', 'changes']);
    const agentName = cleanText(args.agentName, 'agent_name', 30);
    const existing = findAgent(bootstrap, agentName);
    if (!existing || existing.status === 'archived') throw new WorkspaceToolError('agent_not_found');
    if (!isRecord(args.changes) || Object.keys(args.changes).length === 0
        || Object.keys(args.changes).some((field) => !UPDATE_FIELDS.has(field))) {
      throw new WorkspaceToolError('workspace_tool_arguments_invalid');
    }
    const currentSettings = isRecord(existing.settings) ? existing.settings : {};
    const current = normalizeAgentInput({
      name: existing.name,
      role: existing.role,
      avatar: existing.avatar,
      color: COLORS.has(String(currentSettings.color || '').toLowerCase()) ? String(currentSettings.color).toLowerCase() : '#32d583',
      approvalPath: APPROVAL_PATHS.has(String(currentSettings.approvalPath || '').toLowerCase()) ? String(currentSettings.approvalPath).toLowerCase() : 'desktop',
      orderCap: Number.isSafeInteger(currentSettings.orderCap) ? currentSettings.orderCap : 20,
      dailyCap: Number.isSafeInteger(currentSettings.dailyCap) ? currentSettings.dailyCap : 100,
      apps: Array.isArray(currentSettings.apps) && currentSettings.apps.every((app) => typeof app === 'string' && APP_LABELS.has(app.toLowerCase()))
        ? currentSettings.apps.map((app) => app.toLowerCase()) : [],
      memoryPills: Array.isArray(currentSettings.memoryPills) && currentSettings.memoryPills.every((pill) => typeof pill === 'string')
        ? currentSettings.memoryPills : [],
    });
    const changes = {};
    for (const [field, value] of Object.entries(args.changes)) {
      if (field === 'name') changes.name = cleanText(value, 'agent_name', 30);
      else if (field === 'role') changes.role = cleanText(value, 'agent_role', 60);
      else if (field === 'avatar') {
        const avatar = cleanText(value, 'agent_avatar', 32).toLowerCase();
        if (!AVATARS.has(avatar)) throw new WorkspaceToolError('invalid_agent_avatar');
        changes.avatar = avatar;
      } else if (field === 'color') {
        const color = cleanText(value, 'agent_color', 7).toLowerCase();
        if (!COLORS.has(color)) throw new WorkspaceToolError('invalid_agent_color');
        changes.color = color;
      } else if (field === 'approvalPath') {
        const approvalPath = cleanText(value, 'approval_path', 16).toLowerCase();
        if (!APPROVAL_PATHS.has(approvalPath)) throw new WorkspaceToolError('invalid_approval_path');
        changes.approvalPath = approvalPath;
      } else if (field === 'orderCap') {
        if (!Number.isSafeInteger(value) || value < 20 || value > 500) throw new WorkspaceToolError('invalid_order_cap');
        changes.orderCap = value;
      } else if (field === 'dailyCap') {
        if (!Number.isSafeInteger(value) || value < 100 || value > 2000 || value % 25 !== 0) {
          throw new WorkspaceToolError('invalid_daily_spend_cap');
        }
        changes.dailyCap = value;
      } else if (field === 'apps') changes.apps = cleanStringArray(value, 'apps', { allowed: APP_LABELS });
      else if (field === 'memoryPills') changes.memoryPills = cleanStringArray(value, 'memory_pills');
    }
    const input = normalizeAgentInput({ ...current, ...changes });
    const fields = Object.keys(changes).map((field) => ({
      label: field === 'orderCap' ? 'Per-order cap' : field === 'dailyCap' ? 'Daily cap' : field === 'memoryPills' ? 'Memory preferences' : field,
      before: displayValue(field, current[field]),
      value: displayValue(field, input[field]),
    }));
    return {
      kind: 'proposal',
      type: 'update_agent',
      payload: { agentId: String(existing.id), agentName: String(existing.name), input, expectedFingerprint: workspaceAgentFingerprint(existing) },
      display: {
        title: 'Update agent',
        summary: `Update “${safeStoredText(existing.name, 40)}”. The agent will remain ${safeStoredText(existing.status || 'paused', 24)}.`,
        fields,
      },
    };
  }
  if (call.name === 'rename_workspace') {
    assertOnlyKeys(args, ['name']);
    const name = cleanText(args.name, 'workspace_name', 80);
    if (name === String(workspace.name || '').trim()) throw new WorkspaceToolError('workspace_tool_no_change');
    return {
      kind: 'proposal',
      type: 'rename_workspace',
      payload: { name, expectedFingerprint: workspaceNameFingerprint(workspace) },
      display: {
        title: 'Rename workspace',
        summary: 'Change this workspace’s display name.',
        fields: [{ label: 'Workspace name', before: safeStoredText(workspace.name, 100), value: name }],
      },
    };
  }
  throw new WorkspaceToolError('workspace_tool_not_allowed');
}
