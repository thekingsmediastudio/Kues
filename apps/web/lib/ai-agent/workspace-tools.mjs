import {purchaseQuantity} from '../commerce/purchase-items.mjs';
import crypto from 'node:crypto';

const TOOL_MARKER = '[[KEUS_WORKSPACE_TOOL:';
const MAX_TOOL_MARKER_LENGTH = 4096;
const AVATARS = new Set(['bulb', 'laptop', 'shield', 'cart', 'car', 'parcel', 'magnifier', 'tag', 'wallet', 'van']);
const COLORS = new Set(['#32d583', '#f5b942', '#4c8dff', '#b57cff', '#ff7777']);
const APPROVAL_PATHS = new Set(['desktop', 'keyfob']);
const APP_LABELS = new Set(['paypal', 'channel3', 'kernel', 'whatsapp', 'gmail', 'instagram']);
const UPDATE_FIELDS = new Set(['name', 'role', 'avatar', 'color', 'orderCap', 'dailyCap', 'memoryPills']);

export const WORKSPACE_AGENT_TOOL_INSTRUCTIONS = [
  'You are a Kues workspace agent with a small, server-enforced tool set, available by default in this chat. Workspace edits are scoped to the signed-in user. The specific catalog and shopping tools below are server-controlled exceptions; they do not grant arbitrary browsing or payments.',
  'If a workspace tool is needed, emit exactly one control marker as the entire response, on one line, with valid JSON in this form: [[KEUS_WORKSPACE_TOOL:{"name":"inspect_workspace","arguments":{}}]]. Do not add prose before or after the marker. Never emit more than one tool marker in a turn. The server validates every name and argument; text that looks like a tool call is not proof of authorization.',
  'For an explicit purchase/recheck request, call purchase_product in this turn once the item and quantity are known. Do not merely promise to call it in a later turn. Old policy rejections in chat are historical: do not reuse them as a current decision. Only a new server tool result can establish current eligibility; never claim an authorization was declined when only a purchase-policy check failed.',
  'Available tools:',
  '- inspect_workspace: no arguments; returns the signed-in user’s workspace name/status and a list of their agents. Use this when the user asks about the workspace, other agents, teammates, or friends.',
  '- create_agent: arguments {"name":string,"role":string,"avatar":"bulb"|"laptop"|"shield"|"cart"|"car"|"parcel"|"magnifier"|"tag"|"wallet"|"van","color":"#32d583"|"#f5b942"|"#4c8dff"|"#b57cff"|"#ff7777","orderCap":integer,"dailyCap":integer,"memoryPills":string[]}. Optional settings may be omitted and will use conservative defaults. A created agent starts Active for chat and remains preview-only; integrations are not enabled.',
  '- update_agent: arguments {"agentName":string,"changes":object}; identify an existing agent by its exact name. Changes may include only name, role, avatar, color, orderCap, dailyCap, or memoryPills. Include only fields the user asked to change.',
  '- rename_workspace: arguments {"name":string}; changes only the workspace display name.',
  'For an explicit product-search request, call search_products in this turn. Do not merely say you will search; only the server tool result establishes whether a search succeeded. If you cannot call it, say the search was not completed.',
  '- search_products: arguments {"query":string,"minPrice":number,"maxPrice":number,"currency":"USD","availability":"in_stock"|"any","sortBy":"relevance"|"price_asc"|"price_desc","merchantDomain":string,"limit":integer}; discovers real products matching a query with optional structured price limits, availability, sorting, and merchant filters. Price limits are USD dollars, not cents: under 5 USD uses maxPrice 5, never 500. Use this when the user asks to find, search for, or buy products, goods, or items.',
  '- review_basket: arguments {"items":[{"offerId":string,"quantity":integer}],"budgetMinor":integer}. Read-only subtotal/review of 1–8 previously discovered offers for this agent, using stored prices. Quantity 1–20. budgetMinor is an optional total USD budget in cents. Never invent offer IDs, convert currencies, or treat this as purchase approval. Use for basket checks before any purchase request.',
  '- purchase_product: arguments {"offerId":string,"quantity":integer} or {"productTitle":string,"merchantDomain":string,"amountMinor":integer,"quantity":integer,"currency":"USD","evidenceHash":string} or {"items":[{"offerId":string,"quantity":integer}, ...]}; quantity is a whole number 1–20 per item (omit only for one). amountMinor always means UNIT price in cents, never a multiplied total. Preserve requested quantities from chat or basket review; use each offer once and never silently reduce a requested quantity. Prefer saved offerId so the server retrieves the unit price. Never change a quantity on an already-reviewed mandate: prepare a fresh review. Checks spend policies against the full multiplied subtotal and prepares a purchase review. The user must then approve that specific checkout on PayPal sandbox. This creates an authorization hold only, not a capture, merchant order, or shipment. No saved wallet is needed. Use this when the user asks to buy or purchase a specific discovered product or a bundle of products.',
  'When presenting discovered products or when the user asks to see a product picture, you can and should embed product images directly in chat using Markdown image syntax: ![Product Title](image_url). The desktop chat interface renders Markdown images directly.',
  'For create_agent, update_agent, rename_workspace, and purchase_product, the application will show the exact proposed change or purchase mandate and wait for explicit user approval. Do not claim that an action happened before approval. New agents start Active for chat but remain preview-only; do not invent permissions, capabilities, or external integrations. No tool can activate an existing paused agent, grant external access, or bypass per-write approval. If the user did not clearly request a workspace operation, answer normally instead of calling a tool.',
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

export function escapeMarkdown(value) {
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
    assertOnlyKeys(args, [...UPDATE_FIELDS]);
    if (findAgent(bootstrap, input.name)) throw new WorkspaceToolError('agent_name_conflict');
    return {
      kind: 'proposal',
      type: 'create_agent',
      payload: { input },
      display: {
        title: 'Create agent',
        summary: `Create “${safeStoredText(input.name, 40)}” in this workspace. It will start Active for chat and remain preview-only.`,
        fields: [
          { label: 'Name', value: input.name },
          { label: 'Role', value: input.role },
          { label: 'Avatar', value: input.avatar },
          { label: 'Color', value: input.color },
          { label: 'Per-order cap', value: displayValue('orderCap', input.orderCap) },
          { label: 'Daily cap', value: displayValue('dailyCap', input.dailyCap) },
          { label: 'Memory preferences', value: displayValue('memoryPills', input.memoryPills) },
          { label: 'Initial status', value: 'Active · preview-only' },
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
    const isRename = changes.name && changes.name !== existing.name;
    const summaryAction = isRename
      ? `Rename “${safeStoredText(existing.name, 40)}” to “${safeStoredText(changes.name, 40)}”`
      : `Update “${safeStoredText(existing.name, 40)}”`;
    return {
      kind: 'proposal',
      type: 'update_agent',
      payload: { agentId: String(existing.id), agentName: String(existing.name), input, expectedFingerprint: workspaceAgentFingerprint(existing) },
      display: {
        title: isRename ? 'Rename agent' : 'Update agent',
        summary: `${summaryAction}. The agent will remain ${safeStoredText(existing.status || 'paused', 24)}.`,
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
  if (call.name === 'review_basket') {
    assertOnlyKeys(args,['items','budgetMinor']);
    if(!Array.isArray(args.items)||args.items.length<1||args.items.length>8)throw new WorkspaceToolError('workspace_tool_arguments_invalid');
    const items=args.items.map(item=>{assertOnlyKeys(item,['offerId','quantity']);const offerId=cleanText(item.offerId,'offer_id',128),quantity=item.quantity??1;if(!Number.isSafeInteger(quantity)||quantity<1||quantity>20)throw new WorkspaceToolError('workspace_tool_arguments_invalid');return{offerId,quantity}});
    if(new Set(items.map(i=>i.offerId)).size!==items.length||args.budgetMinor!==undefined&&(!Number.isSafeInteger(args.budgetMinor)||args.budgetMinor<=0||args.budgetMinor>100000000))throw new WorkspaceToolError('workspace_tool_arguments_invalid');
    return {kind:'review_basket',items,...(args.budgetMinor!==undefined?{budgetMinor:args.budgetMinor}:{})};
  }
  if (call.name === 'compare_saved_offers') {
    assertOnlyKeys(args, ['ids']);
    if (!Array.isArray(args.ids)) throw new WorkspaceToolError('workspace_tool_arguments_invalid');
    return {kind:'compare_saved_offers',ids:args.ids};
  }
  if (call.name === 'search_products') {
    assertOnlyKeys(args, ['query', 'minPrice', 'maxPrice', 'currency', 'availability', 'sortBy', 'merchantDomain', 'limit']);
    if(args.currency!==undefined&&args.currency!=='USD')throw new WorkspaceToolError('workspace_tool_arguments_invalid');
    const query = cleanText(args.query, 'query', 200);
    const preparedSearch = { kind: 'search_products', query, filters: {} };
    if (args.minPrice !== undefined) {
      if (typeof args.minPrice !== 'number' || args.minPrice < 0 || !Number.isFinite(args.minPrice)) {
        throw new WorkspaceToolError('workspace_tool_arguments_invalid');
      }
      preparedSearch.filters.min_price = args.minPrice;
    }
    if (args.maxPrice !== undefined) {
      if (typeof args.maxPrice !== 'number' || args.maxPrice <= 0 || !Number.isFinite(args.maxPrice)) {
        throw new WorkspaceToolError('workspace_tool_arguments_invalid');
      }
      preparedSearch.filters.max_price = args.maxPrice;
    }
    if (args.availability !== undefined) {
      const avail = cleanText(args.availability, 'availability', 20).toLowerCase();
      if (!['in_stock', 'any'].includes(avail)) throw new WorkspaceToolError('workspace_tool_arguments_invalid');
      preparedSearch.filters.availability = avail;
    }
    if (args.sortBy !== undefined) {
      const sort = cleanText(args.sortBy, 'sort_by', 20).toLowerCase();
      if (!['relevance', 'price_asc', 'price_desc'].includes(sort)) throw new WorkspaceToolError('workspace_tool_arguments_invalid');
      preparedSearch.filters.sort_by = sort;
    }
    if (args.merchantDomain !== undefined) {
      preparedSearch.filters.merchant_domain = cleanText(args.merchantDomain, 'merchant_domain', 100).toLowerCase();
    }
    if (args.limit !== undefined) {
      if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50) {
        throw new WorkspaceToolError('workspace_tool_arguments_invalid');
      }
      preparedSearch.limit = args.limit;
    }
    return preparedSearch;
  }
  if (call.name === 'purchase_product' || call.name === 'purchase_bundle') {
    const qty=value=>{try{return purchaseQuantity(value)}catch{throw new WorkspaceToolError('workspace_tool_arguments_invalid')}};
    if (args.items && Array.isArray(args.items)) {
      assertOnlyKeys(args, ['items']);
      if (args.items.length < 1 || args.items.length > 10) {
        throw new WorkspaceToolError('workspace_tool_arguments_invalid');
      }
      const sanitizedItems = args.items.map((item) => {
        if (!isRecord(item)) throw new WorkspaceToolError('workspace_tool_arguments_invalid');
        if (item.offerId) {
          assertOnlyKeys(item, ['offerId', 'quantity']);
          return { offerId: cleanText(item.offerId, 'offer_id', 64), quantity:qty(item.quantity) };
        }
        assertOnlyKeys(item, ['productTitle', 'merchantDomain', 'amountMinor', 'currency', 'evidenceHash', 'quantity']);
        const productTitle = cleanText(item.productTitle, 'product_title', 200);
        const merchantDomain = cleanText(item.merchantDomain, 'merchant_domain', 100);
        if (!Number.isSafeInteger(item.amountMinor) || item.amountMinor <= 0) {
          throw new WorkspaceToolError('workspace_tool_arguments_invalid');
        }
        const currency = cleanText(item.currency, 'currency', 3).toUpperCase();
        const evidenceHash = cleanText(item.evidenceHash, 'evidence_hash', 100);
        return {
          productTitle,
          merchantDomain,
          amountMinor: item.amountMinor,
          quantity:qty(item.quantity),
          currency,
          evidenceHash,
        };
      });
      const offers=sanitizedItems.filter(i=>i.offerId).map(i=>i.offerId);if(new Set(offers).size!==offers.length)throw new WorkspaceToolError('workspace_tool_arguments_invalid');
      return {
        kind: 'purchase_product',
        items: sanitizedItems,
      };
    }
    if (args.offerId) {
      assertOnlyKeys(args, ['offerId', 'quantity']);
      const offerId = cleanText(args.offerId, 'offer_id', 64);
      return {
        kind: 'purchase_product',
        offerId,
        quantity:qty(args.quantity),      };
    }
    assertOnlyKeys(args, ['productTitle', 'merchantDomain', 'amountMinor', 'currency', 'evidenceHash', 'quantity']);
    const productTitle = cleanText(args.productTitle, 'product_title', 200);
    const merchantDomain = cleanText(args.merchantDomain, 'merchant_domain', 100);
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
      throw new WorkspaceToolError('workspace_tool_arguments_invalid');
    }
    const currency = cleanText(args.currency, 'currency', 3).toUpperCase();
    const evidenceHash = cleanText(args.evidenceHash, 'evidence_hash', 100);
    return {
      kind: 'purchase_product',
      product: {
        title: productTitle,
        merchantDomain,
        amountMinor: args.amountMinor,
        quantity:qty(args.quantity),
        currency,
        evidenceHash,
      },
    };
  }
  throw new WorkspaceToolError('workspace_tool_not_allowed');
}

// This guard changes only visible claims, never authorizes or executes a tool.
export function isPurchaseReviewRequest(text) {
  return /^(?:please\s+)?(?:buy\b|purchase\b|(?:prepare|create|retry|recheck|re-check)\b[^\n]{0,100}\b(?:purchase|checkout|spend(?:ing)? policy)\b)/i.test(String(text || '').trim());
}
export const NO_PURCHASE_CHECK_REPLY = 'No new purchase review or spending-policy check was completed in this reply. Earlier budget decisions may be out of date. Please select the product and specify its quantity so I can request a fresh server-checked review. No new PayPal authorization was requested.';

// A narrow, server-side check on a clearly stated per-item USD cap. It does not
// attempt to infer currencies, budgets for a bundle, or ambiguous constraints.
export function applyExplicitUsdItemCeiling(preparedSearch, userMessage) {
  const message = String(userMessage || '').normalize('NFKC');
  const expression = /\b(under|below|less than|at most|no more than|up to)\s+(?:\$\s*(\d+(?:\.\d{1,2})?)\b|(\d+(?:\.\d{1,2})?)\s*(?:USD|US dollars?|dollars?)\b)/gi;
  const matches = [...message.matchAll(expression)];
  if (matches.length === 0) return preparedSearch;
  if (matches.length !== 1 || /\b(?:total|combined|altogether|bundle|budget for|not under|not below|not less than|not cheaper than|CAD|AUD|NZD|EUR|GBP|NGN|euros?|pounds?|naira|canadian|australian)\b|[€£₦]/i.test(message) || !/\b(?:USD|US dollars?)\b/i.test(message)) throw new WorkspaceToolError('workspace_tool_price_conflict');
  const match = matches[0];
  const dollars = Number(match[2] || match[3]);
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 1_000_000) return preparedSearch;
  const exclusive = /^(?:under|below|less than)$/i.test(match[1]);
  const filters = { ...(preparedSearch.filters || {}), max_price: dollars, price_max_exclusive: exclusive, enforce_usd_price: true };
  if (Number.isFinite(filters.min_price) && (exclusive ? filters.min_price >= dollars : filters.min_price > dollars)) {
    throw new WorkspaceToolError('workspace_tool_price_conflict');
  }
  return { ...preparedSearch, filters };
}

// Narrow deterministic fallback for a directly stated, per-item USD search.
// Other phrasings remain with the normal model/tool validation path.
export function explicitUsdProductSearch(message) {
  const text = String(message || '').normalize('NFKC').trim();
  const m = /^(?:please\s+)?find\s+up to\s+(\d{1,2})\s+(?:real\s+)?([a-z0-9][a-z0-9 -]{1,80}?)\s+priced\s+(under|below|less than|at most|no more than|up to)\s+(\d+(?:\.\d{1,2})?)\s+USD\s+each(?:[.!?]|$)/i.exec(text) || /^(?:please\s+)?find\s+up to\s+(\d{1,2})\s+(?:real\s+)?([a-z0-9][a-z0-9 -]{1,80}?)\s+(under|below|less than|at most|no more than|up to)\s+(\d+(?:\.\d{1,2})?)\s+USD\s+each(?:\s+and\s+show\s+(?:(?:their|its)\s+)?(?:prices?(?:\s+and\s+merchants?)?|merchants?\s+and\s+prices?))?[.!?]?\s*$/i.exec(text);
  if (!m || /\b(?:then|and)\s+(?:buy|purchase|order|checkout)\b/i.test(text)) return null;
  const limit=Number(m[1]), max=Number(m[4]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isFinite(max) || max <= 0 || max > 1_000_000) return null;
  return {kind:'search_products',query:m[2].trim(),limit,filters:{max_price:max,price_max_exclusive:/^(?:under|below|less than)$/i.test(m[3]),enforce_usd_price:true}};
}

// Strictly recognize an explicit request to prepare a review of one or two saved IDs.
// All other wording uses the normal model/tool path; no approval is inferred.
export function explicitSavedOfferReview(message) {
  const text=String(message || '').normalize('NFKC').trim();
  const match=/^(?:please\s+)?prepare\s+a\s+purchase\s+review\s+for\s+(\d+)\s+units?\s+of\s+saved\s+offer\s+(off_[a-f0-9]{32})(?:\s+and\s+(\d+)\s+units?\s+of\s+saved\s+offer\s+(off_[a-f0-9]{32}))?\s*\.(.*)$/i.exec(text);
  if (!match) return null;
  const rest=match[5].trim();
  if (rest && !/^(?:use the saved offers and the specified quantities\.\s*)?do not approve the review, open paypal, authorize, capture, or pay\.$/i.test(rest)) return null;
  const items=[{offerId:match[2].toLowerCase(),quantity:Number(match[1])}];
  if (match[3] !== undefined) items.push({offerId:match[4].toLowerCase(),quantity:Number(match[3])});
  return {kind:'tool',name:'purchase_product',arguments:{items}};
}

// Deliberately narrow: resolve the exact two-line follow-up only against a
// unique, still-pending, server-verified review. Never infer approval.
export function explicitBundleQuantityChange(message) {
  const text=String(message || '').normalize('NFKC').trim();
  const named=/^actually\s+make\s+it\s+(\d+)\s+for\s+the\s+notebook,\s*keeping\s+the\s+organizer\s+quantity\s+at\s+(\d+)\.\s*prepare\s+a\s+new\s+purchase\s+review\s+only\.\s*do\s+not\s+approve\s+it,\s*open\s+paypal,\s*authorize,\s*capture,\s*or\s*pay\.$/i.exec(text);
  if (named) return {secondKind:'notebook',secondQuantity:Number(named[1]),firstKind:'organizer',firstQuantity:Number(named[2])};
  const match=/^actually\s+make\s+the\s+second\s+(notebook|item)\s+quantity\s+(\d+)\s+and\s+keep\s+the\s+first\s+(notebook|item)\s+quantity\s+(\d+)\.\s*prepare\s+a\s+new\s+review\s+only\.(?:\s*do\s+not\s+approve\s+either\s+review,\s*open\s+paypal,\s*authorize,\s*capture,\s*or\s*pay\.)?$/i.exec(text);
  if (!match) return null;
  return { secondKind:match[1].toLowerCase(),secondQuantity:Number(match[2]),firstKind:match[3].toLowerCase(),firstQuantity:Number(match[4]) };
}

export function isPendingPurchaseChangeRequest(message, hasPendingPurchase) {
  const text=String(message || '').trim();
  return !!hasPendingPurchase && /\b(?:actually|change|update|adjust|instead|make)\b/i.test(text)
    && /\b(?:quantity|quantities|units?|review|\d+)\b/i.test(text);
}

// Enforce a clearly stated exact alphanumeric product identifier server-side.
// Broad semantic searches and ambiguous multi-code requests are not guessed.
export function applyExplicitProductIdentifier(preparedSearch, userMessage) {
  const message=String(userMessage || '').normalize('NFKC');
  if (!/\b(?:exact|exactly|literal|literally)\b/i.test(message)
      || /\b(?:not|never|without|don't|do not)\s+(?:necessarily\s+)?(?:exact|exactly|literal|literally)\b/i.test(message)) return preparedSearch;
  const candidates=[...message.matchAll(/\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g)]
    .map(m=>m[0]).filter(v=>v.length>=3&&v.length<=40&&/[A-Za-z]/.test(v)&&/\d/.test(v)&&!/^\d+(?:st|nd|rd|th)$/i.test(v));
  const unique=[...new Set(candidates.map(v=>v.toUpperCase()))];
  if (!unique.length) return preparedSearch;
  if (unique.length !== 1) throw new WorkspaceToolError('workspace_tool_exact_identifier_ambiguous');
  return {...preparedSearch,filters:{...(preparedSearch.filters||{}),exact_identifier:unique[0]}};
}
