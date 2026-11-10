// Stored blocked conditions do not yet have a supported, versioned grammar.
// Never silently treat a configured or malformed condition as permission.
export async function hasUnverifiedBlockedConditions(tx, workspaceId, agentId) {
  const policies = await tx.execute({
    sql: 'SELECT blocked_conditions_json FROM spend_policies WHERE workspace_id=? AND active=1 AND (agent_id=? OR agent_id IS NULL)',
    args: [workspaceId, agentId || null],
  });
  return policies.rows.some(({blocked_conditions_json: raw}) => {
    try { const value = JSON.parse(raw); return !Array.isArray(value) || value.length !== 0; }
    catch { return true; }
  });
}
