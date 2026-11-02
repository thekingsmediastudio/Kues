// New tool permissions are explicit opt-ins. Availability is separate and fail-closed.
export const AGENT_TOOL_KEYS = Object.freeze(['web_search', 'read_webpage', 'read_files', 'create_files', 'run_code']);
export function normalizeAgentExtensions(input) {
  const result = {};
  if (Object.hasOwn(input, 'instructions')) {
    if (typeof input.instructions !== 'string' || input.instructions.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.instructions)) throw new Error('invalid_agent_instructions');
    result.instructions = input.instructions.trim();
  }
  if (Object.hasOwn(input, 'toolPermissions')) {
    const permissions = input.toolPermissions;
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)
      || Object.keys(permissions).some(key => !AGENT_TOOL_KEYS.includes(key))
      || Object.values(permissions).some(value => typeof value !== 'boolean')) throw new Error('invalid_agent_tool_permissions');
    result.toolPermissions = Object.fromEntries(AGENT_TOOL_KEYS.map(key => [key, permissions[key] === true]));
  }
  return result;
}
export function defaultAgentExtensions() {
  return { instructions: '', toolPermissions: Object.fromEntries(AGENT_TOOL_KEYS.map(key => [key, false])) };
}
export function agentToolAccess(agent, key, installedTools = {}) {
  if (!AGENT_TOOL_KEYS.includes(key)) return { allowed: false, ready: false, reason: 'unknown_tool' };
  const allowed = agent?.settings?.toolPermissions?.[key] === true;
  const ready = Object.hasOwn(installedTools, key) && installedTools[key]?.ready === true;
  return { allowed, ready, reason: !allowed ? 'agent_tool_disabled' : !ready ? 'tool_not_installed' : null };
}
export function assertAgentToolAccess(agent, key, installedTools = {}) {
  const access = agentToolAccess(agent, key, installedTools);
  if (access.reason) throw new Error(access.reason);
}
