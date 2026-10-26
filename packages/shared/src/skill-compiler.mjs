import crypto from 'node:crypto';
import { canonicalJSON } from './mandate.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeSingleLine(value, field, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength || /[\r\n\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`invalid_${field}`);
  }
  return text;
}

function escapeMarkdown(text) {
  return text.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
}

function validDomain(domain) {
  return typeof domain === 'string' && domain.length <= 253
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain);
}

/** Compile a constrained SKILL.md. Its checksum binds the policy and emitted workflow lines. */
export function compileRunToSkill({
  skillName,
  description,
  maxPerOrderCents,
  currency = 'USD',
  allowedDomains = [],
  steps = [],
}) {
  const slug = String(skillName || 'verified-skill').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'verified-skill';
  const safeDescription = safeSingleLine(description || skillName || 'Verified workflow', 'description', 300);
  if (!Number.isSafeInteger(maxPerOrderCents) || maxPerOrderCents <= 0) {
    throw new TypeError('max_per_order_cents_must_be_positive_integer');
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new TypeError('invalid_currency');
  if (!Array.isArray(allowedDomains) || !allowedDomains.every(validDomain)) throw new TypeError('invalid_allowed_domains');
  if (!Array.isArray(steps) || steps.length > 100) throw new TypeError('invalid_workflow_steps');
  const domains = [...new Set(allowedDomains.map((d) => d.toLowerCase()))].sort();
  const workflow = steps.map((step, i) => {
    const surface = safeSingleLine(step?.surface || 'STEP', `step_${i + 1}_surface`, 32);
    if (!/^[A-Za-z0-9 _-]+$/.test(surface)) throw new TypeError(`invalid_step_${i + 1}_surface`);
    const instruction = safeSingleLine(step?.instruction, `step_${i + 1}_instruction`, 500);
    return `${i + 1}. **[${surface}]** ${escapeMarkdown(instruction)}`;
  });
  const core = {
    slug, description: safeDescription, maxPerOrderCents, currency,
    allowedDomains: domains, requireWebAuthnPasskey: true,
    paypalIntent: 'AUTHORIZE_THEN_PASSKEY_CAPTURE', workflow,
  };
  const hash = sha256(canonicalJSON(core));
  const markdown = [
    '---',
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(safeDescription)}`,
    'compatible_with: ["kues-desktop-preview"]',
    `max_per_order_cents: ${maxPerOrderCents}`,
    `currency: ${JSON.stringify(currency)}`,
    `allowed_domains: ${JSON.stringify(domains)}`,
    'require_webauthn_passkey: true',
    'paypal_settlement_mode: "AUTHORIZE_THEN_PASSKEY_CAPTURE"',
    'integrity_scope: "policy+workflow"',
    `policy_sha256: ${JSON.stringify(hash)}`,
    '---',
    '',
    `# Skill: ${slug}`,
    '',
    '## Deterministic Spend & Human Approval Gate',
    `- **Ceiling:** ${maxPerOrderCents} minor units ${currency}`,
    `- **Allowed Domains:** ${domains.join(', ') || 'any (constrained only by the server policy)'}`,
    '- **Approval:** a real implementation must verify a transaction-bound user assertion server-side before capture.',
    '',
    '## Recorded Workflow Steps',
    ...workflow,
    '',
  ].join('\n');
  return { slug, policyHash: hash, markdown };
}

function readQuoted(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

/** Verify the documented policy and every recorded workflow line against its checksum. */
export function verifySkillMarkdown(markdown) {
  const text = String(markdown);
  const match = text.match(/^---\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { valid: false, reason: 'missing_frontmatter' };
  const fm = match[1], body = match[2];
  const getRaw = (key) => fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
  const slug = readQuoted(fm, 'name');
  const description = readQuoted(fm, 'description');
  const currency = readQuoted(fm, 'currency');
  const maxPerOrderCents = Number(getRaw('max_per_order_cents'));
  const requirePasskey = getRaw('require_webauthn_passkey') === 'true';
  const paypalIntent = readQuoted(fm, 'paypal_settlement_mode');
  const integrityScope = readQuoted(fm, 'integrity_scope');
  const claimedHash = readQuoted(fm, 'policy_sha256');
  let allowedDomains;
  try { allowedDomains = JSON.parse(getRaw('allowed_domains') || 'null'); } catch { return { valid: false, reason: 'invalid_allowed_domains_json' }; }
  if (!requirePasskey || paypalIntent !== 'AUTHORIZE_THEN_PASSKEY_CAPTURE') {
    return { valid: false, reason: 'passkey_gate_disabled_or_tampered' };
  }
  if (integrityScope !== 'policy+workflow') return { valid: false, reason: 'unsupported_integrity_scope' };
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
      || typeof description !== 'string' || description.length > 300
      || !Number.isSafeInteger(maxPerOrderCents) || maxPerOrderCents <= 0
      || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)
      || !Array.isArray(allowedDomains) || !allowedDomains.every(validDomain)) {
    return { valid: false, reason: 'invalid_policy_fields' };
  }
  const heading = '## Recorded Workflow Steps';
  const sections = body.split(heading);
  if (sections.length !== 2 || sections[0].includes(heading) || sections[1].includes('\n## ')) {
    return { valid: false, reason: 'invalid_workflow_section' };
  }
  const workflow = sections[1].split('\n').map((line) => line.trim()).filter(Boolean);
  if (workflow.length > 100 || workflow.some((line, i) => !new RegExp(`^${i + 1}\\. \\*\\*\\[[A-Za-z0-9 _-]{1,32}\\]\\*\\* .{1,2000}$`).test(line))) {
    return { valid: false, reason: 'invalid_workflow_steps' };
  }
  const core = {
    slug, description, maxPerOrderCents, currency,
    allowedDomains: [...allowedDomains].sort(), requireWebAuthnPasskey: true,
    paypalIntent: 'AUTHORIZE_THEN_PASSKEY_CAPTURE', workflow,
  };
  const expectedHash = sha256(canonicalJSON(core));
  if (expectedHash !== claimedHash) return { valid: false, reason: 'skill_checksum_mismatch_policy_or_workflow' };
  return { valid: true, skill: core, policyHash: expectedHash };
}
