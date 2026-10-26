import crypto from 'node:crypto';

/** Personal agent identity card, scoped wallet envelope, and group task routing. */
export function createAgentIdentity({
  id,
  name,
  role,
  channelHandle,
  paypalVaultId,
  maxPerOrderCents = 10000,
  dailyBudgetCents = 25000,
  spentTodayCents = 0,
  allowedDomains = [],
}) {
  if (!id || !name || !role) throw new Error('Agent identity requires id, name, and role');
  if (!Number.isSafeInteger(maxPerOrderCents) || maxPerOrderCents <= 0
      || !Number.isSafeInteger(dailyBudgetCents) || dailyBudgetCents <= 0
      || !Number.isSafeInteger(spentTodayCents) || spentTodayCents < 0
      || !Array.isArray(allowedDomains)
      || !allowedDomains.every((d) => typeof d === 'string' && d.length > 0 && d.length <= 253)) {
    throw new TypeError('Agent spending envelope must use valid positive integer minor-unit limits');
  }
  const fingerprint = crypto.createHash('sha256')
    .update(`${id}:${name}:${role}:${paypalVaultId || 'unlinked'}:${maxPerOrderCents}`)
    .digest('hex').slice(0, 12);
  return {
    id,
    name,
    role,
    channelHandle: channelHandle || `@${id.replace(/[^a-z0-9]/gi, '').toLowerCase()}.cue`,
    paypalVaultId: paypalVaultId || null,
    envelope: {
      currency: 'USD', maxPerOrderCents, dailyBudgetCents, spentTodayCents,
      remainingDailyCents: Math.max(0, dailyBudgetCents - spentTodayCents),
      allowedDomains: [...allowedDomains],
    },
    identityHash: `agt_${fingerprint}`,
  };
}

/** Strict envelope check; malformed amounts and envelope state are denied. */
export function checkAgentEnvelope(agent, amountCents, merchantDomain) {
  const env = agent?.envelope;
  if (!env || !Number.isSafeInteger(amountCents) || amountCents <= 0
      || !Number.isSafeInteger(env.maxPerOrderCents) || env.maxPerOrderCents <= 0
      || !Number.isSafeInteger(env.dailyBudgetCents) || env.dailyBudgetCents <= 0
      || !Number.isSafeInteger(env.spentTodayCents) || env.spentTodayCents < 0
      || !Array.isArray(env.allowedDomains)
      || typeof merchantDomain !== 'string' || !merchantDomain.trim()) {
    return { allowed: false, reason: 'invalid_agent_envelope_or_amount' };
  }
  if (!agent.paypalVaultId) return { allowed: false, reason: 'vault_not_linked' };
  if (amountCents > env.maxPerOrderCents) {
    return { allowed: false, reason: `agent_order_cap_exceeded:${amountCents}>${env.maxPerOrderCents}` };
  }
  if (amountCents > env.dailyBudgetCents - env.spentTodayCents) {
    return { allowed: false, reason: `agent_daily_cap_exceeded:${env.spentTodayCents + amountCents}>${env.dailyBudgetCents}` };
  }
  if (env.allowedDomains.length > 0 && !env.allowedDomains.includes(merchantDomain.toLowerCase())) {
    return { allowed: false, reason: `agent_domain_restricted:${merchantDomain}` };
  }
  return { allowed: true };
}

/** Group Cue routing helper. This remains planning-only; it does not run the steps. */
export function planGroupCue(prompt, agents) {
  const lower = String(prompt || '').toLowerCase();
  const needsMobile = lower.includes('whatsapp') || lower.includes('android')
    || lower.includes('phone') || lower.includes('app') || lower.includes('seller');
  const byRole = (role) => agents.find((a) => a.role === role) || agents[0];
  const steps = [];
  const scout = byRole('web_scout');
  if (scout) steps.push({ step: 1, agentId: scout.id, agentName: scout.name,
    surface: 'WEB_BROWSER', action: 'Compare web store listings and capture checkout DOM + screenshot' });
  if (needsMobile) {
    const bridge = byRole('adb_bridge');
    if (bridge) steps.push({ step: steps.length + 1, agentId: bridge.id, agentName: bridge.name,
      surface: 'ANDROID_ADB', action: 'Query vendor quote in native mobile app via ADB (uiautomator + screencap)' });
  }
  const sentinel = byRole('sentinel_guard');
  if (sentinel) steps.push({ step: steps.length + 1, agentId: sentinel.id, agentName: sentinel.name,
    surface: 'SENTINEL_PAYPAL_GATE', action: 'Scan for prompt-injection / fee creep, stage a PayPal AUTHORIZE hold, and request human approval' });
  return { cueId: `cue_${crypto.randomBytes(4).toString('hex')}`, prompt, needsMobile, steps };
}
