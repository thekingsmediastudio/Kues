import { Freestyle } from 'freestyle';
import { createExecutionJobs } from './lib/ai-agent/execution-jobs.mjs';
import { createExecutionRoutes } from './lib/ai-agent/execution-routes.mjs';
import { workspaceLibraryFromEnv } from './lib/ai-agent/workspace-storage.mjs';
import { createWorkspaceFileRoutes } from './lib/ai-agent/workspace-file-routes.mjs';
import { createFileTools, createFileRoutes, FileToolError, FILE_CONSENT } from './lib/ai-agent/file-tools.mjs';
import { createWebResearch, researchSourcesMarkdown, RESEARCH_CONSENT, ResearchError } from './lib/ai-agent/web-research.mjs';
import http from 'node:http';
import { createAudioRoutes, createGroqTranscription } from './lib/audio/groq-transcription.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from './lib/config.mjs';
import { createDatabaseClient } from './lib/db/client.mjs';
import { applyMigrations } from './lib/db/migrate.mjs';
import { withReadTransaction } from './lib/db/transaction.mjs';
import { AuthError, createAuthService } from './lib/auth/service.mjs';
import { createBrevoEmailDelivery } from './lib/auth/brevo-delivery.mjs';
import { createWorkOSAuth } from './lib/auth/workos-auth.mjs';
import { ApiHubError, createApiHubService } from './lib/api-hub/service.mjs';
import { AiProviderError, createAiProviderService } from './lib/ai-providers/service.mjs';
import { AiChatHistoryError, createAiChatHistoryService } from './lib/ai-providers/history.mjs';
import { AI_CHAT_AVATAR_CUES, AI_CHAT_AVATAR_EMOTION_CUES, AI_CHAT_MAX_AVATAR_CUES_PER_REPLY, AI_CHAT_MAX_OUTPUT_TOKENS, createAiChatService, normalizeAiChatAvatarEmotionCue, normalizeAiChatMessages } from './lib/ai-providers/chat.mjs';
import { UsageLimitError, UsageReservationError, reserveTokens, releaseTokenReservation, settleTokenReservation } from './lib/db/usage.mjs';
import { WorkspaceError, createWorkspaceService } from './lib/workspaces/service.mjs';
import { WorkspaceToolError, escapeMarkdown, parseWorkspaceToolCall, prepareWorkspaceToolCall, workspaceAgentFingerprint, workspaceNameFingerprint } from './lib/ai-agent/workspace-tools.mjs';
import { Channel3Error, createChannel3Client } from './lib/channel3/client.mjs';
import { discoverProducts, getProductOffersForRun } from './lib/channel3/discovery.mjs';
import {
  MandatePolicyError,
  createPurchaseMandate,
  authorizePurchaseMandate,
  getMandateDetails,
  evaluateSpendPolicy,
} from './lib/channel3/mandate-service.mjs';
import {
  createSandboxPaymentAuthorization,
  voidSandboxPaymentAuthorization,
  captureSandboxPaymentAuthorization,
  refundSandboxPaymentCapture,
  getSandboxPaymentTransaction,
  createWalletSetupToken,
  linkWorkspaceWallet,
  getWorkspaceWallet,
  unlinkWorkspaceWallet,
  PayPalSandboxError,
} from './lib/paypal/service.mjs';
import {
  compileRunToSkill,
} from '../../packages/shared/src/skill-compiler.mjs';
import {
  evaluateCheckoutRail,
  executeCheckoutMandate,
  voidCheckoutMandate,
  getCheckoutExecution,
} from './lib/commerce/checkout-engine.mjs';
import {
  createPasskeyRegistrationOptions,
  verifyAndSavePasskeyRegistration,
  listUserPasskeys,
  revokePasskey,
  getMandatePasskeyChallenge,
  verifyMandatePasskeyApproval,
  PasskeyError,
} from './lib/auth/passkey-service.mjs';
import { WorkOS } from '@workos-inc/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const landingHtmlPath = path.join(publicDir, 'landing.html');
const dashboardHtmlPath = path.join(publicDir, 'dashboard.html');
const desktopPreviewHtmlPath = path.join(publicDir, 'desktop-preview.html');
const onboardingHtmlPath = path.join(publicDir, 'onboarding.html');
const loginHtmlPath = path.join(publicDir, 'login.html');
const authVerifyHtmlPath = path.join(publicDir, 'auth-verify.html');
const pocketHtmlPath = path.join(publicDir, 'pocket.html');
const apiHubHtmlPath = path.join(publicDir, 'api-hub.html');
const aiProviderAdminHtmlPath = path.join(publicDir, 'ai-providers-admin.html');
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const STATIC_ASSETS = new Map([
  ['/execution-ui.mjs', ['execution-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/workspace-files-ui.mjs', ['workspace-files-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/file-tools-ui.mjs', ['file-tools-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/local-audio.mjs', ['local-audio.mjs', 'text/javascript; charset=utf-8']],
  ['/local-audio-capture.mjs', ['local-audio-capture.mjs', 'text/javascript; charset=utf-8']],
  ['/local-dictation-worker.mjs', ['local-dictation-worker.mjs', 'text/javascript; charset=utf-8']],
  ['/keus-icon.svg', ['keus-icon.svg', 'image/svg+xml']],
  ['/keus-logo.svg', ['keus-logo.svg', 'image/svg+xml']],
]);
const LEGACY_BRAND_REDIRECTS = new Map([
  ['/cueclaw-icon.png', '/keus-logo.svg'],
  ['/cueclaw-logo.png', '/keus-icon.svg'],
]);
const PROTECTED_AUTH_PATHS = new Set(['/app', '/dashboard', '/desktop-preview', '/desktop', '/desktop.html', '/onboarding']);

class RequestError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function writeSseEvent(res, event, payload, signal) {
  if (signal?.aborted || res.destroyed || res.writableEnded) {
    return Promise.reject(Object.assign(new Error('ai_chat_stream_client_closed'), { code: 'ai_chat_stream_client_closed' }));
  }
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  let writable;
  try { writable = res.write(frame); }
  catch (error) { return Promise.reject(error); }
  if (writable) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(Object.assign(new Error('ai_chat_stream_client_closed'), { code: 'ai_chat_stream_client_closed' })); };
    const onError = (error) => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(Object.assign(new Error('ai_chat_stream_client_closed'), { code: 'ai_chat_stream_client_closed' })); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function explicitAvatarEmotionCue(message) {
  const word = String(message || '').normalize('NFKC').trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!/^[a-z_]{1,32}$/.test(word)) return null;
  return normalizeAiChatAvatarEmotionCue(word);
}

const WORKSPACE_TOOL_APPROVAL_TTL_MS = 10 * 60 * 1000;
const WORKSPACE_TOOL_APPROVAL_LIMIT = 500;

function pruneWorkspaceToolApprovals(pendingApprovals, now = Date.now()) {
  for (const [actionId, approval] of pendingApprovals) {
    if (!approval || approval.expiresAt <= now) pendingApprovals.delete(actionId);
  }
}

function safeWorkspaceApprovalDisplay(display) {
  const safeText = (value, maxLength = 240) => typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, maxLength)
    : '';
  const fields = Array.isArray(display?.fields) ? display.fields.slice(0, 20).map((field) => ({
    label: safeText(field?.label, 60),
    ...(typeof field?.before === 'string' ? { before: safeText(field.before, 160) } : {}),
    value: safeText(field?.value, 240),
  })).filter((field) => field.label && field.value) : [];
  return {
    title: safeText(display?.title, 80) || 'Workspace change',
    summary: safeText(display?.summary, 240) || 'Review this workspace change before it is applied.',
    fields,
  };
}

function createPendingWorkspaceToolApproval(pendingApprovals, { userId, workspaceId, chatAgentId, prepared }) {
  pruneWorkspaceToolApprovals(pendingApprovals);
  if (pendingApprovals.size >= WORKSPACE_TOOL_APPROVAL_LIMIT) {
    throw new RequestError('workspace_tool_approval_limit', 429);
  }
  const actionId = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + WORKSPACE_TOOL_APPROVAL_TTL_MS;
  const display = safeWorkspaceApprovalDisplay(prepared.display);
  pendingApprovals.set(actionId, {
    actionId,
    userId: String(userId),
    workspaceId: String(workspaceId),
    chatAgentId: String(chatAgentId),
    type: prepared.type,
    payload: prepared.payload,
    display,
    expiresAt,
    status: 'pending',
  });
  return { actionId, expiresAt, action: display };
}

function pendingWorkspaceToolApprovalViews(pendingApprovals, { userId, workspaceId, chatAgentId }) {
  pruneWorkspaceToolApprovals(pendingApprovals);
  const views = [];
  for (const approval of pendingApprovals.values()) {
    if (approval.status !== 'pending'
        || approval.userId !== String(userId)
        || approval.workspaceId !== String(workspaceId)
        || approval.chatAgentId !== String(chatAgentId)) continue;
    views.push({ actionId: approval.actionId, expiresAt: approval.expiresAt, action: approval.display });
  }
  return views.slice(-20);
}

function workspaceToolFailureMessage(error) {
  const code = error instanceof WorkspaceToolError ? error.code : '';
  const messages = {
    workspace_unavailable: 'I could not access your active workspace, so nothing was changed.',
    agent_not_found: 'I could not find that agent in your workspace, so nothing was changed.',
    agent_name_conflict: 'An agent with that name already exists. Choose a different name.',
    workspace_tool_no_change: 'That workspace name is already set; nothing needed changing.',
    invalid_agent_name: 'The proposed agent name is invalid. Nothing was changed.',
    invalid_agent_role: 'The proposed agent role is invalid. Nothing was changed.',
    invalid_agent_avatar: 'That avatar is not available. Nothing was changed.',
    invalid_agent_color: 'That color is not available. Nothing was changed.',
    invalid_approval_path: 'That approval path is not available. Nothing was changed.',
    invalid_order_cap: 'The proposed per-order cap is outside the allowed range. Nothing was changed.',
    invalid_daily_spend_cap: 'The proposed daily cap is outside the allowed range. Nothing was changed.',
    invalid_apps: 'One or more proposed apps are not available. Nothing was changed.',
    invalid_memory_pills: 'The proposed memory preferences are invalid. Nothing was changed.',
    invalid_workspace_name: 'The proposed workspace name is invalid. Nothing was changed.',
    invalid_query: 'The search query is invalid. Please specify a product query.',
  };
  return messages[code] || 'I could not safely interpret that workspace operation, so nothing was changed. Please try a single, specific request.';
}

async function executeProductSearchTool(preparedSearch, { channel3Client, db, workspaceId, userId, agentId }) {
  const query = typeof preparedSearch === 'string' ? preparedSearch : preparedSearch?.query;
  const filters = (preparedSearch && typeof preparedSearch === 'object' && preparedSearch.filters) || {};
  const limit = Number.isSafeInteger(preparedSearch?.limit) ? preparedSearch.limit : 9;

  try {
    const discovery = await discoverProducts({
      channel3Client,
      query,
      limit,
      filters,
      db,
      workspaceId,
      userId,
      agentId,
      allowFixtureFallback: true,
    });

    const lines = [];
    const sourceLabel = discovery.isLive ? 'Channel3 (Live Search)' : 'Channel3 (Sample Fixtures)';
    lines.push(`Discovered ${discovery.products.length} product${discovery.products.length === 1 ? '' : 's'} matching "${escapeMarkdown(query)}":`);

    const filterBadges = [];
    if (Number.isFinite(filters.min_price) && Number.isFinite(filters.max_price)) {
      filterBadges.push(`$${filters.min_price}–$${filters.max_price} USD`);
    } else if (Number.isFinite(filters.min_price)) {
      filterBadges.push(`From $${filters.min_price} USD`);
    } else if (Number.isFinite(filters.max_price)) {
      filterBadges.push(`Under $${filters.max_price} USD`);
    }
    if (filters.availability === 'in_stock') filterBadges.push('In Stock Only');
    if (filters.sort_by === 'price_asc') filterBadges.push('Price: Low to High');
    else if (filters.sort_by === 'price_desc') filterBadges.push('Price: High to Low');
    if (filters.merchant_domain) filterBadges.push(`Merchant: ${filters.merchant_domain}`);

    if (filterBadges.length > 0) {
      lines.push(`*Filters applied:* ${filterBadges.map((b) => `\`${b}\``).join(' · ')}\n`);
    } else {
      lines.push('');
    }

    lines.push(':::products-grid');
    if (filterBadges.length > 0) {
      lines.push(`[Filters: ${filterBadges.join(' · ')}]`);
    }
    for (let i = 0; i < discovery.products.length; i++) {
      const p = discovery.products[i];
      const stock = p.availability === 'in_stock' ? 'In Stock' : (p.availability === 'out_of_stock' ? 'Out of Stock' : p.availability);
      lines.push(`${i + 1}. **${escapeMarkdown(p.title)}**${p.brand ? ` by ${escapeMarkdown(p.brand)}` : ''}`);
      if (p.imageUrl) {
        lines.push(`   ![${escapeMarkdown(p.title)}](${p.imageUrl})`);
      }
      const sellerDomain = p.merchantDomain && p.merchantDomain !== 'unknown.example' ? ` (${p.merchantDomain})` : '';
      lines.push(`   - **Price:** ${p.priceFormatted}`);
      lines.push(`   - **Seller:** ${escapeMarkdown(p.merchantName)}${sellerDomain}`);
      lines.push(`   - **Status:** ${stock}`);
      if (p.offerId) lines.push(`   - **Offer ID:** \`${p.offerId}\``);
      if (p.url) lines.push(`   - **Link:** [View product](${p.url})`);
      lines.push(`   - **Evidence:** \`${p.evidenceHash.slice(0, 19)}...\``);
      lines.push('');
    }
    lines.push(':::');
    lines.push('');
    lines.push(`*Source:* ${sourceLabel}${discovery.runId ? ` · *Run ID:* \`${discovery.runId}\`` : ''}`);
    return lines.join('\n');
  } catch (err) {
    if (err instanceof Channel3Error && err.code === 'channel3_not_configured') {
      return 'Channel3 product discovery is not configured. Add CHANNEL3_API_KEY to search live products.';
    }
    return `Product discovery failed: ${err.message || 'unknown error'}`;
  }
}

async function executePurchaseProductTool(toolCall, { db, workspaceId, userId, agentId }) {
  if (!db || !workspaceId) {
    return {
      kind: 'text',
      text: 'Cannot formulate purchase mandate: workspace database is unavailable.',
    };
  }
  try {
    const mandateResult = await createPurchaseMandate({
      db,
      workspaceId,
      userId,
      agentId,
      offerId: toolCall.offerId,
      product: toolCall.product,
      items: toolCall.items,
    });

    if (!mandateResult.allowed) {
      const blockedLines = [
        '⚠️ **Purchase Blocked by Spend Policy**',
        '',
        mandateResult.failureReason,
        '',
      ];
      if (mandateResult.isBundle && Array.isArray(mandateResult.items)) {
        blockedLines.push(`- **Bundle Items (${mandateResult.items.length}):**`);
        mandateResult.items.forEach((item, idx) => {
          blockedLines.push(`  ${idx + 1}. ${escapeMarkdown(item.title)} ($${(item.amountMinor / 100).toFixed(2)} ${item.currency})`);
        });
        blockedLines.push(`- **Subtotal:** $${(mandateResult.product.amountMinor / 100).toFixed(2)} ${mandateResult.product.currency}`);
      } else {
        blockedLines.push(`- **Item:** ${escapeMarkdown(mandateResult.product.title)}`);
        blockedLines.push(`- **Merchant:** ${escapeMarkdown(mandateResult.product.merchantDomain)}`);
      }
      blockedLines.push(`- **Per-Order Cap:** $${(mandateResult.limits.maxPerOrderMinor / 100).toFixed(2)} USD`);
      blockedLines.push(`- **Daily Budget:** $${(mandateResult.limits.dailyBudgetMinor / 100).toFixed(2)} USD (Spent today: $${(mandateResult.limits.dailySpentMinor / 100).toFixed(2)} USD)`);

      return {
        kind: 'text',
        text: blockedLines.join('\n'),
      };
    }

    const priceText = `$${(mandateResult.product.amountMinor / 100).toFixed(2)} ${mandateResult.product.currency}`;
    const isBundle = Boolean(mandateResult.isBundle && Array.isArray(mandateResult.items));

    const fields = [];
    if (isBundle) {
      mandateResult.items.forEach((item, idx) => {
        fields.push({
          label: `Item ${idx + 1}`,
          value: `${item.title} ($${(item.amountMinor / 100).toFixed(2)} ${item.currency})`,
        });
      });
      fields.push({ label: 'Bundle Total', value: priceText });
      fields.push({ label: 'Merchants', value: mandateResult.product.merchantDomain });
    } else {
      fields.push({ label: 'Item', value: mandateResult.product.title });
      fields.push({ label: 'Price', value: priceText });
      fields.push({ label: 'Merchant', value: mandateResult.product.merchantDomain });
    }
    fields.push({ label: 'Policy Status', value: `Approved (Within $${(mandateResult.limits.maxPerOrderMinor / 100).toFixed(2)} limit)` });
    fields.push({ label: 'Mandate ID', value: mandateResult.mandateId });
    fields.push({ label: 'Evidence Hash', value: `${mandateResult.product.evidenceHash.slice(0, 24)}…` });

    const railEval = evaluateCheckoutRail({
      merchantDomain: mandateResult.product.merchantDomain,
      offerId: mandateResult.product.offerId || null,
      amountMinor: mandateResult.product.amountMinor,
      currency: mandateResult.product.currency,
    });
    fields.push({
      label: 'Autonomous Rail',
      value: railEval.selectedRail === 'card_bridge'
        ? 'Tier 3: Single-Use Virtual Card Bridge (PayPal JIT Drawdown)'
        : (railEval.selectedRail === 'channel3_ucp'
          ? 'Tier 2: Channel3 UCP Direct API'
          : 'Tier 1: PayPal Native Vault'),
    });
    fields.push({ label: 'Routing Strategy', value: railEval.reasoning });

    const title = isBundle ? 'Authorize Bundle Purchase Mandate' : 'Authorize Purchase Mandate';
    const summary = isBundle
      ? `Authorize bundle purchase of ${mandateResult.items.length} items for ${priceText} across ${mandateResult.product.merchantDomain}.`
      : `Authorize purchase of “${mandateResult.product.title}” for ${priceText} from ${mandateResult.product.merchantDomain}.`;

    const prepared = {
      type: 'purchase_product',
      payload: {
        mandateId: mandateResult.mandateId,
        approvalId: mandateResult.approvalId,
        amountMinor: mandateResult.product.amountMinor,
        currency: mandateResult.product.currency,
        productTitle: mandateResult.product.title,
        merchantDomain: mandateResult.product.merchantDomain,
        evidenceHash: mandateResult.product.evidenceHash,
        isBundle,
        bundleItems: isBundle ? mandateResult.items : undefined,
      },
      display: {
        title,
        summary,
        fields,
      },
    };

    return {
      kind: 'proposal',
      prepared,
      mandateResult,
    };
  } catch (err) {
    if (err instanceof MandatePolicyError) {
      return {
        kind: 'text',
        text: `Unable to prepare purchase mandate: ${err.message}`,
      };
    }
    return {
      kind: 'text',
      text: `Purchase mandate error: ${err.message || 'unknown error'}`,
    };
  }
}

async function handleWorkspaceToolApprovalRequest(req, res, {
  user,
  workspaceService,
  aiChatHistoryService,
  pendingApprovals,
  db = null,
  channel3Client = null,
}) {
  let body;
  try { body = await readJsonBody(req, 4096); }
  catch { sendJson(res, 400, { error: 'workspace_tool_approval_invalid' }); return; }
  if (Object.keys(body).some((key) => !['actionId', 'decision', 'passkey'].includes(key))
      || typeof body.actionId !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(body.actionId)
      || !['approve', 'reject'].includes(body.decision)) {
    sendJson(res, 400, { error: 'workspace_tool_approval_invalid' });
    return;
  }
  const approval = pendingApprovals.get(body.actionId);
  if (!approval || approval.userId !== String(user.id)) {
    sendJson(res, 404, { error: 'workspace_tool_approval_not_found' });
    return;
  }
  if (approval.expiresAt <= Date.now()) {
    pendingApprovals.delete(body.actionId);
    sendJson(res, 410, { error: 'workspace_tool_approval_expired' });
    return;
  }
  if (approval.status === 'completed') {
    if (approval.decision === body.decision) sendJson(res, 200, approval.result);
    else sendJson(res, 409, { error: 'workspace_tool_approval_already_used' });
    return;
  }
  if (approval.status === 'processing') {
    sendJson(res, 409, { error: 'workspace_tool_approval_processing' });
    return;
  }
  approval.status = 'processing';
  approval.decision = body.decision;
  try {
    let message;
    if (body.decision === 'reject') {
      if (approval.type === 'purchase_product' && db) {
        await authorizePurchaseMandate({
          db,
          workspaceId: approval.workspaceId,
          userId: user.id,
          mandateId: approval.payload.mandateId,
          decision: 'reject',
        });
        message = `Declined purchase mandate \`${approval.payload.mandateId}\` for “${String(approval.payload.productTitle).slice(0, 50)}”. Nothing was charged.`;
      } else {
        message = 'Cancelled the proposed change. Nothing was changed.';
      }
    } else {
      if (approval.type === 'purchase_product') {
        if (!db) throw new WorkspaceError('database_not_configured', 503);
        let passkeyVerified = false;
        let passkeyNotice = '';
        let mandateAuth;

        if (body.passkey && body.passkey.credentialId) {
          try {
            const pResult = await verifyMandatePasskeyApproval({
              db,
              workspaceId: approval.workspaceId,
              mandateId: approval.payload.mandateId,
              userId: user.id,
              credentialId: body.passkey.credentialId,
              signature: body.passkey.signature,
              authenticatorData: body.passkey.authenticatorData,
              clientDataJSON: body.passkey.clientDataJSON,
              simulate: Boolean(body.passkey.simulate),
            });
            passkeyVerified = pResult.verified;
            passkeyNotice = ` [Passkey Verified: ${body.passkey.credentialId}]`;
            mandateAuth = {
              mandateId: approval.payload.mandateId,
              amountMinor: approval.payload.amountMinor,
              currency: approval.payload.currency || 'USD',
            };
          } catch (passkeyErr) {
            console.warn('Passkey verification note:', passkeyErr.message);
            throw passkeyErr;
          }
        } else {
          mandateAuth = await authorizePurchaseMandate({
            db,
            workspaceId: approval.workspaceId,
            userId: user.id,
            mandateId: approval.payload.mandateId,
            credentialId: null,
            decision: 'approve',
          });
        }

        let holdNotice = '';
        let paymentHold = null;
        let checkoutExecution = null;
        try {
          checkoutExecution = await executeCheckoutMandate({
            db,
            workspaceId: approval.workspaceId,
            userId: user.id,
            mandateId: approval.payload.mandateId,
            channel3Client,
          });
          paymentHold = checkoutExecution.paypalHold;
          if (checkoutExecution.selectedRail === 'card_bridge') {
            holdNotice = ` [Tier 3: Single-Use Virtual Card Minted (${checkoutExecution.railDetails.maskedPan})] [PayPal Sandbox Hold Created: ${paymentHold.authorizationId}]`;
          } else if (checkoutExecution.selectedRail === 'channel3_ucp') {
            holdNotice = ` [Tier 2: Channel3 UCP Direct API Order (${checkoutExecution.railDetails.ucpOrderId})] [PayPal Sandbox Hold Created: ${paymentHold.authorizationId}]`;
          } else {
            holdNotice = ` [Tier 1: PayPal Native Vault Order] [PayPal Sandbox Hold Created: ${paymentHold.authorizationId}]`;
          }
        } catch (holdErr) {
          console.warn('Checkout execution note:', holdErr.message);
        }
        message = `Authorized purchase mandate \`${mandateAuth.mandateId}\`${passkeyNotice} for “${String(approval.payload.productTitle).slice(0, 50)}” ($${(mandateAuth.amountMinor / 100).toFixed(2)} ${mandateAuth.currency}).${holdNotice}`;
        approval.paymentHold = paymentHold;
        approval.checkoutExecution = checkoutExecution;
        approval.passkeyVerified = passkeyVerified;
      } else {
        const bootstrap = await workspaceService.getBootstrap({ userId: user.id });
        const workspace = bootstrap?.workspace;
        if (!workspace || workspace.id !== approval.workspaceId || workspace.status !== 'active') {
          throw new WorkspaceError('workspace_tool_proposal_stale', 409);
        }
        const currentAgents = Array.isArray(bootstrap.agents) ? [...bootstrap.agents] : [];
        if (bootstrap.onboarding?.agent && !currentAgents.some((agent) => agent?.id === bootstrap.onboarding.agent.id)) {
          currentAgents.push(bootstrap.onboarding.agent);
        }
        if (!currentAgents.some((agent) => String(agent?.id) === approval.chatAgentId && agent.status !== 'archived')) {
          throw new WorkspaceError('workspace_tool_proposal_stale', 409);
        }
        if (approval.type === 'create_agent') {
          const input = approval.payload?.input;
          const duplicate = currentAgents.some((agent) => String(agent?.name || '').trim().toLowerCase() === String(input?.name || '').toLowerCase());
          if (duplicate) throw new WorkspaceError('agent_name_conflict', 409);
          await workspaceService.createAgent({ userId: user.id, input });
          message = `Created “${String(input.name).slice(0, 80)}”. The agent is Active for chat and remains preview-only.`;
        } else if (approval.type === 'update_agent') {
          const agent = currentAgents.find((entry) => String(entry?.id) === String(approval.payload?.agentId));
          if (!agent || workspaceAgentFingerprint(agent) !== approval.payload?.expectedFingerprint) {
            throw new WorkspaceError('workspace_tool_proposal_stale', 409);
          }
          await workspaceService.updateAgent({ userId: user.id, agentId: agent.id, input: approval.payload.input });
          const newName = approval.payload?.input?.name;
          message = newName && newName !== agent.name
            ? `Renamed “${String(agent.name || '').slice(0, 40)}” to “${String(newName).slice(0, 40)}”.`
            : `Updated “${String(agent.name || '').slice(0, 80)}”.`;
        } else if (approval.type === 'rename_workspace') {
          if (workspaceNameFingerprint(workspace) !== approval.payload?.expectedFingerprint) {
            throw new WorkspaceError('workspace_tool_proposal_stale', 409);
          }
          await workspaceService.updateWorkspaceName({ userId: user.id, name: approval.payload.name });
          message = `Renamed the workspace to “${String(approval.payload.name).slice(0, 100)}”.`;
        } else {
          throw new WorkspaceError('workspace_tool_not_allowed', 400);
        }
      }
    }

    const historyUserMessage = `${body.decision === 'approve' ? 'Approved' : 'Declined'} workspace change: ${approval.display.summary}`.slice(0, 800);
    const result = {
      actionId: approval.actionId,
      status: body.decision === 'approve' ? 'approved' : 'rejected',
      message,
      historyUserMessage,
      paymentHold: approval.paymentHold || null,
      checkoutExecution: approval.checkoutExecution || null,
      passkeyVerified: approval.passkeyVerified || false,
    };
    approval.status = 'completed';
    approval.result = result;
    approval.completedAt = Date.now();
    try {
      await aiChatHistoryService.appendExchange({
        workspaceId: approval.workspaceId,
        userId: user.id,
        agentId: approval.chatAgentId,
        userMessage: historyUserMessage,
        assistantMessage: message,
      });
    } catch (error) {
      console.error('Workspace tool approval history persistence failed:', JSON.stringify({ error: error?.name || 'Error' }));
    }
    sendJson(res, 200, result);
  } catch (error) {
    const stale = error instanceof WorkspaceError && error.code === 'workspace_tool_proposal_stale';
    const duplicate = error instanceof WorkspaceError && error.code === 'agent_name_conflict';
    const message = stale
      ? 'This proposal is out of date. Nothing was changed; ask the agent to prepare it again.'
      : duplicate
        ? 'An agent with that name already exists. Nothing was changed.'
        : 'The change could not be applied. Nothing was changed; review the workspace and try again.';
    const result = { actionId: approval.actionId, status: stale ? 'stale' : 'failed', message };
    approval.status = 'completed';
    approval.result = result;
    approval.completedAt = Date.now();
    sendJson(res, 200, result);
  }
}

function requestOrigin(req) {
  const origin = req.headers.origin;
  if (origin == null) return { present: false, valid: true, sameOrigin: true, value: null };
  try {
    const raw = String(origin);
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.origin !== raw || parsed.username || parsed.password
        || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return { present: true, valid: false, sameOrigin: false, value: null };
    }
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const protocol = forwardedProto ? `${forwardedProto}:` : req.socket.encrypted ? 'https:' : 'http:';
    // Use the request Host value set by the trusted front proxy; never let an
    // untrusted X-Forwarded-Host header override it.
    const requestHost = String(req.headers.host || '');
    const sameOrigin = parsed.protocol === protocol && parsed.host.toLowerCase() === requestHost.toLowerCase();
    return { present: true, valid: true, sameOrigin, value: parsed.origin };
  } catch {
    return { present: true, valid: false, sameOrigin: false, value: null };
  }
}

function requireSameOrigin(req) {
  const origin = requestOrigin(req);
  if (!origin.present || !origin.valid || !origin.sameOrigin) throw new RequestError('same_origin_required', 403);
}

function applyAllowedCors(req, res, config) {
  const origin = requestOrigin(req);
  if (!origin.valid) return false;
  if (!origin.present || origin.sameOrigin) return true;
  if (!config.allowedOrigins.includes(origin.value)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin.value);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  return true;
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new RequestError('application_json_required', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError('request_body_too_large', 413);
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError('invalid_json', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError('json_object_required', 400);
  }
  return value;
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sessionCookieName(config) {
  return config.nodeEnv === 'production' ? '__Host-kues_session' : 'kues_session';
}

function setSessionCookie(config, token) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${sessionCookieName(config)}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function clearSessionCookie(config) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${sessionCookieName(config)}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

const WORKOS_STATE_COOKIE = 'kues_workos_state';
const PENDING_AUTH_COOKIE = 'kues_pending_auth';
const PASSWORD_RESET_COOKIE = 'kues_password_reset';

function pendingAuthCookieValue(challenge) {
  const value = Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64url');
  if (!value || value.length > 4096) throw new AuthError('verification_flow_unavailable', 503);
  return value;
}

function parsePendingAuthCookie(value) {
  const encoded = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(encoded)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const email = String(parsed.email || '').trim().normalize('NFKC').toLowerCase();
    if (email.length > 254 || !email.includes('@') || Array.from(email).some((char) => char.charCodeAt(0) <= 32)) return null;
    if (parsed.kind === 'pending') {
      const token = String(parsed.token || '');
      if (!token || token.length > 4096) return null;
      return { kind: 'pending', token, email };
    }
    if (parsed.kind === 'user') {
      const userId = String(parsed.userId || '');
      if (!userId || userId.length > 255) return null;
      return { kind: 'user', userId, email };
    }
    return null;
  } catch {
    return null;
  }
}

function setPendingAuthCookie(config, challenge) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${PENDING_AUTH_COOKIE}=${pendingAuthCookieValue(challenge)}; Max-Age=600; Path=/api/auth/password; HttpOnly; SameSite=Strict${secure}`;
}

function clearPendingAuthCookie(config) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${PENDING_AUTH_COOKIE}=; Max-Age=0; Path=/api/auth/password; HttpOnly; SameSite=Strict${secure}`;
}

function passwordResetCookieValue(challenge) {
  const email = String(challenge?.email || '').trim().normalize('NFKC').toLowerCase();
  if (challenge?.kind !== 'password_reset' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('password_reset_unavailable', 503);
  }
  const value = Buffer.from(JSON.stringify({ kind: 'password_reset', email }), 'utf8').toString('base64url');
  if (!value || value.length > 4096) throw new AuthError('password_reset_unavailable', 503);
  return value;
}

function parsePasswordResetCookie(value) {
  const encoded = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(encoded)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'password_reset') return null;
    const email = String(parsed.email || '').trim().normalize('NFKC').toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return { kind: 'password_reset', email };
  } catch {
    return null;
  }
}

function setPasswordResetCookie(config, challenge) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${PASSWORD_RESET_COOKIE}=${passwordResetCookieValue(challenge)}; Max-Age=600; Path=/api/auth/password/reset; HttpOnly; SameSite=Strict${secure}`;
}

function clearPasswordResetCookie(config) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${PASSWORD_RESET_COOKIE}=; Max-Age=0; Path=/api/auth/password/reset; HttpOnly; SameSite=Strict${secure}`;
}

function setWorkOSStateCookie(config, state) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${WORKOS_STATE_COOKIE}=${state}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function clearWorkOSStateCookie(config) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${WORKOS_STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function sameState(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === 43 && b.length === 43 && crypto.timingSafeEqual(a, b);
}

function redirect(res, location, setCookie) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
  });
  res.end();
}

function readHtml(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

async function handleAuthRequest(req, res, url, config, authService, workosAuth, {
  googleEnabled = false,
  githubEnabled = false,
} = {}, workspaceService = null, db = null) {
  if (url.pathname === '/api/auth/demo-fastlane') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    requireSameOrigin(req);
    if (!authService) {
      sendJson(res, 503, { error: 'auth_service_unavailable' });
      return true;
    }

    const sessionResult = await authService.createWorkOSSession({
      providerSubject: 'sub_paypal_hackathon_judge',
      email: 'judge@paypal.sandbox',
      emailVerified: true,
      displayName: 'PayPal Hackathon Judge',
    });

    if (workspaceService && db) {
      const bootstrap = await workspaceService.getBootstrap({ userId: sessionResult.user.id });
      const wsId = bootstrap.workspace.id;

      if (!bootstrap.agents || bootstrap.agents.length === 0) {
        await workspaceService.createAgent({
          userId: sessionResult.user.id,
          input: {
            name: 'Procure Scout',
            role: 'Autonomous buyer',
            avatar: 'cart',
            color: '#4c8dff',
            approvalPath: 'desktop',
            orderCap: 150,
            dailyCap: 500,
            apps: ['channel3', 'paypal'],
            memoryPills: ['Stay under order limit cap'],
          },
        });
      }

      try {
        await linkWorkspaceWallet({
          db,
          workspaceId: wsId,
          userId: sessionResult.user.id,
          setupTokenId: 'ST-SANDBOX-JUDGE-PRELINKED-WALLET',
          payerEmail: 'judge-sandbox@personal.example.com',
          simulate: true,
        });
      } catch {}

      await db.execute({
        sql: `INSERT INTO workspace_onboarding (
                workspace_id, completed, step, agent_name, agent_role, agent_avatar,
                agent_color, approval_path, order_cap, daily_cap, apps_json, memory_pills_json, updated_at
              ) VALUES (?, 1, 4, 'Procure Scout', 'Autonomous buyer', 'cart',
                '#4c8dff', 'desktop', 150, 500, '["channel3","paypal"]', '[]', datetime('now')
              ) ON CONFLICT(workspace_id) DO UPDATE SET completed = 1`,
        args: [wsId],
      });
    }

    sendJson(res, 200, {
      authenticated: true,
      redirect: '/app',
      user: sessionResult.user,
    }, {
      'Set-Cookie': [setSessionCookie(config, sessionResult.sessionToken), clearPendingAuthCookie(config)],
    });
    return true;
  }

  if (url.pathname === '/api/auth/config' && req.method === 'GET') {
    sendJson(res, 200, {
      provider: config.authProvider,
      enabled: config.workosConfigured,
      emailEnabled: config.workosConfigured,
      emailPasswordEnabled: config.authProvider === 'workos' && config.workosConfigured,
      emailAuthMethod: config.authProvider === 'workos' && config.workosConfigured ? 'password' : null,
      magicAuthEnabled: false,
      googleEnabled,
      githubEnabled,
      otherMethodsEnabled: googleEnabled || githubEnabled,
    });
    return true;
  }

  if (config.authProvider === 'workos') {
    const retiredMagicAuthPaths = new Set([
      '/api/auth/email/start',
      '/api/auth/email/verify',
      '/api/auth/email/consume',
    ]);
    if (retiredMagicAuthPaths.has(url.pathname)) {
      sendJson(res, 410, { error: 'password_auth_required' });
      return true;
    }

    const passwordPaths = new Set([
      '/api/auth/password/signup',
      '/api/auth/password/login',
      '/api/auth/password/verify',
      '/api/auth/password/resend',
      '/api/auth/password/reset/start',
      '/api/auth/password/reset/verify',
    ]);
    if (passwordPaths.has(url.pathname)) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS');
        sendJson(res, 405, { error: 'method_not_allowed' });
        return true;
      }
      requireSameOrigin(req);
      if (!authService || !workosAuth) {
        sendJson(res, 503, { error: 'auth_provider_not_configured' });
        return true;
      }
      const body = await readJsonBody(req);
      const metadata = {
        ipAddress: req.socket.remoteAddress,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
      };

      if (url.pathname === '/api/auth/password/signup') {
        const result = await workosAuth.signUpWithPassword({ ...body, ...metadata });
        if (result.needsEmailVerification === true && result.challenge) {
          sendJson(res, 202, { accepted: true, email: result.email }, {
            'Set-Cookie': setPendingAuthCookie(config, result.challenge),
          });
        } else if (result.passwordResetAvailable === true) {
          sendJson(res, 202, { accepted: true, email: result.email }, {
            'Set-Cookie': clearPendingAuthCookie(config),
          });
        } else {
          sendJson(res, 200, {
            authenticated: true,
            isNewUser: result.isNewUser === true,
            needsOnboarding: result.needsOnboarding === true || result.isNewUser === true,
            user: result.user,
          }, {
            'Set-Cookie': [setSessionCookie(config, result.sessionToken), clearPendingAuthCookie(config)],
          });
        }
        return true;
      }

      if (url.pathname === '/api/auth/password/login' || url.pathname === '/api/auth/password/resend') {
        const result = url.pathname.endsWith('/resend')
          ? await workosAuth.resendPasswordVerification({ ...body, ...metadata })
          : await workosAuth.signInWithPassword({ ...body, ...metadata });
        if (result.needsEmailVerification === true && result.challenge) {
          sendJson(res, 202, { verificationRequired: true, email: result.email }, {
            'Set-Cookie': setPendingAuthCookie(config, result.challenge),
          });
        } else {
          sendJson(res, 200, {
            authenticated: true,
            isNewUser: result.isNewUser === true,
            needsOnboarding: result.needsOnboarding === true || result.isNewUser === true,
            user: result.user,
          }, {
            'Set-Cookie': [setSessionCookie(config, result.sessionToken), clearPendingAuthCookie(config)],
          });
        }
        return true;
      }

      if (url.pathname === '/api/auth/password/verify') {
        const challenge = parsePendingAuthCookie(cookieValue(req, PENDING_AUTH_COOKIE));
        if (!challenge) {
          sendJson(res, 400, { error: 'invalid_or_expired_code' });
          return true;
        }
        const result = await workosAuth.verifyPasswordEmail({
          ...body,
          challenge,
          ...metadata,
        });
        sendJson(res, 200, {
          authenticated: true,
          isNewUser: result.isNewUser === true,
          needsOnboarding: result.needsOnboarding === true || result.isNewUser === true,
          user: result.user,
        }, {
          'Set-Cookie': [setSessionCookie(config, result.sessionToken), clearPendingAuthCookie(config)],
        });
        return true;
      }

      if (url.pathname === '/api/auth/password/reset/start') {
        const result = await workosAuth.startPasswordReset(body);
        sendJson(res, 202, {
          accepted: true,
          message: 'If an account exists for that email, a password reset code will be sent.',
        }, {
          'Set-Cookie': setPasswordResetCookie(config, result.challenge),
        });
        return true;
      }

      if (url.pathname === '/api/auth/password/reset/verify') {
        const challenge = parsePasswordResetCookie(cookieValue(req, PASSWORD_RESET_COOKIE));
        if (!challenge) {
          sendJson(res, 400, { error: 'invalid_or_expired_code' });
          return true;
        }
        const result = await workosAuth.completePasswordReset({ ...body, challenge, ...metadata });
        if (result?.passwordUpdated !== true) throw new AuthError('password_reset_unavailable', 503);
        sendJson(res, 200, { passwordUpdated: true }, {
          'Set-Cookie': clearPasswordResetCookie(config),
        });
        return true;
      }
    }
  }

  if (!authService) {
    sendJson(res, 503, { error: 'auth_storage_not_configured' });
    return true;
  }

  if (url.pathname === '/api/auth/session' && req.method === 'GET') {
    const token = cookieValue(req, sessionCookieName(config));
    const user = token ? await authService.getSession({ token }) : null;
    sendJson(res, 200, user ? { authenticated: true, user } : { authenticated: false, user: null });
    return true;
  }

  if (url.pathname === '/api/auth/email/start' && req.method === 'POST') {
    const body = await readJsonBody(req);
    await authService.requestEmailMagicLink({ email: body.email });
    sendJson(res, 202, {
      accepted: true,
      message: 'If email sign-in is enabled, a sign-in link will be sent.',
    });
    return true;
  }

  if (url.pathname === '/api/auth/email/consume' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const result = await authService.consumeEmailMagicLink({ token: body.token });
    sendJson(res, 200, {
      authenticated: true,
      isNewUser: result.isNewUser === true,
      needsOnboarding: result.needsOnboarding === true || result.isNewUser === true,
      user: result.user,
    }, {
      'Set-Cookie': setSessionCookie(config, result.sessionToken),
    });
    return true;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = cookieValue(req, sessionCookieName(config));
    if (token) await authService.revokeSession({ token });
    sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': [clearSessionCookie(config), clearPendingAuthCookie(config), clearPasswordResetCookie(config)] });
    return true;
  }

  return false;
}

async function handleAiProviderAdminRequest(req, res, url, { config, authService, aiProviderService }) {
  if (!config.aiProvidersEnabled || !aiProviderService) {
    sendJson(res, 503, { error: 'ai_provider_admin_not_configured' });
    return true;
  }
  const collectionPath = '/api/admin/ai-providers';
  const providerMatch = url.pathname.match(/^\/api\/admin\/ai-providers\/([0-9a-f-]{36})$/i);
  if (url.pathname !== collectionPath && !providerMatch) {
    sendJson(res, 404, { error: 'ai_provider_admin_route_not_found' });
    return true;
  }
  const readOnly = req.method === 'GET' && url.pathname === collectionPath;
  const writeMethod = ['POST', 'PUT', 'DELETE'].includes(req.method);
  if (!readOnly && !writeMethod) {
    res.setHeader('Allow', providerMatch ? 'PUT, DELETE, OPTIONS' : 'GET, POST, OPTIONS');
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  if (writeMethod) {
    const origin = requestOrigin(req);
    if (!origin.present || !origin.valid || !origin.sameOrigin) {
      sendJson(res, 403, { error: 'same_origin_required' });
      return true;
    }
  }
  if (!authService) {
    sendJson(res, 503, { error: 'auth_storage_not_configured' });
    return true;
  }
  let user = null;
  try {
    const token = cookieValue(req, sessionCookieName(config));
    user = token ? await authService.getSession({ token }) : null;
  } catch {
    user = null;
  }
  if (!user) {
    sendJson(res, 401, { error: 'authentication_required' });
    return true;
  }
  const admins = Array.isArray(config.aiProviderAdminEmails) ? config.aiProviderAdminEmails : [];
  if (!admins.includes(String(user.email || '').trim().normalize('NFKC').toLowerCase())) {
    sendJson(res, 403, { error: 'ai_provider_admin_required' });
    return true;
  }

  try {
    if (req.method === 'GET') {
      sendJson(res, 200, { providers: await aiProviderService.listProviders() });
      return true;
    }
    if (req.method === 'POST' && url.pathname === collectionPath) {
      const input = await readJsonBody(req, 16 * 1024);
      const provider = await aiProviderService.createProvider({ input });
      sendJson(res, 201, { provider });
      return true;
    }
    if (req.method === 'PUT' && providerMatch) {
      const input = await readJsonBody(req, 16 * 1024);
      const provider = await aiProviderService.updateProvider({ providerId: providerMatch[1], input });
      sendJson(res, 200, { provider });
      return true;
    }
    if (req.method === 'DELETE' && providerMatch) {
      const result = await aiProviderService.deleteProvider({ providerId: providerMatch[1] });
      sendJson(res, 200, result);
      return true;
    }
    sendJson(res, 404, { error: 'ai_provider_admin_route_not_found' });
  } catch (error) {
    if (error instanceof AiProviderError || error instanceof RequestError) {
      sendJson(res, error.status, { error: error.code });
    } else {
      console.error('AI provider admin request failed:', error?.name || 'Error');
      sendJson(res, 500, { error: 'ai_provider_request_failed' });
    }
  }
  return true;
}

function consumeAiChatRateLimit(rateWindows, userId) {
  const now = Date.now();
  let bucket = rateWindows.get(userId);
  if (!bucket || now - bucket.startedAt >= 60_000 || now < bucket.startedAt) {
    bucket = { startedAt: now, count: 0 };
    rateWindows.set(userId, bucket);
  }
  if (bucket.count >= 8) throw new RequestError('ai_chat_rate_limited', 429);
  bucket.count += 1;
  if (rateWindows.size > 5000) {
    for (const [id, item] of rateWindows) {
      if (now - item.startedAt > 60_000) rateWindows.delete(id);
    }
  }
}

function aiProviderAdminAllowed(config, user) {
  const email = String(user?.email || '').trim().normalize('NFKC').toLowerCase();
  const admins = Array.isArray(config.aiProviderAdminEmails) ? config.aiProviderAdminEmails : [];
  return Boolean(email && admins.includes(email));
}

function adminProviderAttribution(config, user, completion) {
  if (!aiProviderAdminAllowed(config, user) || !completion || typeof completion !== 'object') return null;
  const label = (value, limit) => typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, limit)
    : '';
  const provider = label(completion.provider, 100) || label(completion.providerDisplayName, 100);
  const providerDisplayName = label(completion.providerDisplayName, 100) || provider;
  const model = label(completion.model, 160);
  return provider && model ? { provider, providerDisplayName, model } : null;
}

function adminChatErrorDiagnostics(config, user, requestId, error) {
  if (config.aiProviderChatTestEnabled !== true || !aiProviderAdminAllowed(config, user)) return null;
  const label = (value, limit) => typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, limit)
    : '';
  const safeCode = (value) => {
    const code = label(value, 80);
    return /^[a-z0-9_]+$/i.test(code) ? code : 'request_failed';
  };
  const context = error?.providerContext && typeof error.providerContext === 'object'
    ? error.providerContext
    : null;
  const provider = context ? {
    key: label(context.providerKey, 64),
    name: label(context.providerDisplayName, 80),
    model: label(context.model, 160),
  } : null;
  const attempts = Array.isArray(error?.attempts)
    ? error.attempts.slice(0, 3).map((attempt) => ({
      providerKey: label(attempt?.providerKey, 64),
      providerName: label(attempt?.providerDisplayName, 80),
      model: label(attempt?.model, 160),
      code: safeCode(attempt?.code),
      ...(Number.isInteger(attempt?.upstreamStatus) && attempt.upstreamStatus >= 100 && attempt.upstreamStatus <= 599
        ? { upstreamStatus: attempt.upstreamStatus }
        : {}),
      retryable: attempt?.retryable === true,
    }))
    : [];
  const upstreamStatus = Number(error?.upstreamStatus);
  const fallbackAttempts = Number(error?.fallbackAttempts);
  return {
    requestId: label(requestId, 64),
    code: safeCode(error?.code),
    ...(provider && (provider.key || provider.name || provider.model) ? { provider } : {}),
    ...(Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599 ? { upstreamStatus } : {}),
    retryable: error?.retryable === true,
    ...(Number.isSafeInteger(fallbackAttempts) && fallbackAttempts >= 0 ? { fallbackAttempts } : {}),
    ...(attempts.length ? { attempts } : {}),
  };
}

function createWorkspaceToolStreamGate(onText) {
  const markerPrefix = '[[KEUS_WORKSPACE_TOOL:';
  let pending = '';
  let visibleText = '';
  let markerDetected = false;
  const emit = async (text) => {
    if (!text) return;
    visibleText += text;
    await onText(text);
  };
  const suffixPrefixLength = (value) => {
    const limit = Math.min(value.length, markerPrefix.length - 1);
    for (let length = limit; length > 0; length -= 1) {
      if (value.endsWith(markerPrefix.slice(0, length))) return length;
    }
    return 0;
  };
  return {
    async push(value) {
      const text = typeof value === 'string' ? value : '';
      if (!text) return;
      if (markerDetected) {
        pending += text;
        return;
      }
      pending += text;
      const markerIndex = pending.indexOf(markerPrefix);
      if (markerIndex >= 0) {
        const preceding = pending.slice(0, markerIndex);
        if (visibleText || preceding.trim()) await emit(preceding);
        pending = pending.slice(markerIndex);
        markerDetected = true;
        return;
      }
      const holdLength = suffixPrefixLength(pending);
      const safeLength = pending.length - holdLength;
      if (!safeLength) return;
      const safeText = pending.slice(0, safeLength);
      if (visibleText || safeText.trim()) {
        pending = pending.slice(safeLength);
        await emit(safeText);
      }
    },
    async flush() {
      if (markerDetected || !pending) return;
      if (suffixPrefixLength(pending) > 0) {
        markerDetected = true;
        return;
      }
      const remaining = pending;
      pending = '';
      if (visibleText || remaining.trim()) await emit(remaining);
    },
    visibleText() { return visibleText; },
    hasMarkerCandidate() { return markerDetected || suffixPrefixLength(pending) > 0; },
  };
}

async function handleDesktopAiChatRequest(req, res, url, {
  config,
  authService,
  workspaceService,
  aiChatService,
  aiChatHistoryService,
  aiProviderService,
  usageService,
  rateWindows,
  pendingToolApprovals,
  researchService,
  filesService,
  channel3Client,
  db,
}) {
  const statusRoute = url.pathname === '/api/chat/status';
  const historyRoute = url.pathname === '/api/chat/history';
  const modelCatalogRoute = url.pathname === '/api/chat/models';
  const toolApprovalRoute = url.pathname === '/api/chat/tool-approval';
  const chatRoute = url.pathname === '/api/chat';
  const streamingRequest = chatRoute && String(req.headers.accept || '').split(',')
    .some((entry) => /^\s*text\/event-stream(?:\s*;|\s*$)/i.test(entry));
  if (!statusRoute && !historyRoute && !modelCatalogRoute && !toolApprovalRoute && !chatRoute) return false;

  const expectedMethod = statusRoute || historyRoute || modelCatalogRoute ? 'GET' : 'POST';
  if (req.method !== expectedMethod) {
    res.setHeader('Allow', `${expectedMethod}, OPTIONS`);
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  if (chatRoute || toolApprovalRoute || ((historyRoute || modelCatalogRoute) && requestOrigin(req).present)) {
    try { requireSameOrigin(req); } catch (error) {
      sendJson(res, error.status || 403, { error: error.code || 'same_origin_required' });
      return true;
    }
  }
  if (!authService) {
    sendJson(res, statusRoute ? 200 : 503, statusRoute ? { available: false } : { error: 'ai_chat_unavailable' });
    return true;
  }

  let user = null;
  try {
    const token = cookieValue(req, sessionCookieName(config));
    user = token ? await authService.getSession({ token }) : null;
  } catch {
    user = null;
  }
  if (!user) {
    sendJson(res, 401, { error: 'authentication_required' });
    return true;
  }

  const enabledForAdmin = config.aiProviderChatTestEnabled === true
    && Boolean(aiChatService)
    && Boolean(aiChatHistoryService)
    && aiProviderAdminAllowed(config, user);
  if (modelCatalogRoute) {
    if (!enabledForAdmin || typeof aiChatService.listModels !== 'function') {
      sendJson(res, 503, { error: 'ai_chat_unavailable' });
      return true;
    }
    const providerKeys = url.searchParams.getAll('providerKey');
    const refreshValues = url.searchParams.getAll('refresh');
    const forceRefresh = refreshValues.length === 1 && refreshValues[0] === '1';
    const hasUnexpectedParameter = [...url.searchParams.keys()].some((key) => !['providerKey', 'refresh'].includes(key));
    if (hasUnexpectedParameter || refreshValues.length > 1 || (refreshValues.length && !forceRefresh) || providerKeys.length > 1
        || (providerKeys.length === 1 && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(providerKeys[0].trim()))) {
      sendJson(res, 400, { error: 'ai_chat_request_invalid' });
      return true;
    }
    const providerKey = providerKeys.length ? providerKeys[0].trim().toLowerCase() : undefined;
    try {
      const catalog = await aiChatService.listModels({ ...(providerKey ? { providerKey } : {}), ...(forceRefresh ? { forceRefresh: true } : {}) });
      const safeText = (value, limit) => typeof value === 'string'
        ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, limit)
        : '';
      const configuredModelId = safeText(catalog?.configuredModelId, 160);
      if (!configuredModelId) throw new Error('ai_chat_model_catalog_invalid');
      const choices = catalog?.catalogAvailable === true && Array.isArray(catalog.models) ? catalog.models : [];
      const models = choices.map((model) => {
        const id = safeText(model?.id, 160);
        if (!id) return null;
        return {
          id,
          displayName: safeText(model?.displayName, 160) || id,
          isConfigured: model?.isConfigured === true || id === configuredModelId,
          ...(forceRefresh ? { catalogConfirmed: model?.catalogConfirmed === true } : {}),
        };
      }).filter(Boolean).slice(0, 500);
      if (!models.some((model) => model.id === configuredModelId)) {
        models.unshift({ id: configuredModelId, displayName: configuredModelId, isConfigured: true });
        models.length = Math.min(models.length, 500);
      }
      sendJson(res, 200, {
        configuredModelId,
        catalogAvailable: catalog?.catalogAvailable === true,
        models,
      });
    } catch (error) {
      if (error instanceof AiProviderError) {
        sendJson(res, error.status, { error: error.code });
      } else {
        console.error('Desktop AI model catalog failed:', JSON.stringify({ error: error?.name || 'Error' }));
        sendJson(res, 503, { error: 'ai_chat_model_catalog_unavailable' });
      }
    }
    return true;
  }
  if (statusRoute) {
    let available = false;
    if (enabledForAdmin) {
      try { available = await aiChatService.isReady(); } catch { available = false; }
    }
    const statusPayload = { available: available === true, ...(enabledForAdmin ? { researchConfigured: researchService?.configured === true, fileToolsAvailable: filesService?.ready === true } : {}) };
    if (available && typeof aiProviderService?.listProviders === 'function') {
      try {
        const configured = await aiProviderService.listProviders();
        statusPayload.providers = (Array.isArray(configured) ? configured : [])
          .filter((provider) => provider?.enabled === true)
          .map((provider) => ({
            providerKey: String(provider.providerKey || '').trim().slice(0, 64),
            displayName: String(provider.displayName || provider.providerKey || '').normalize('NFKC')
              .replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 80),
            modelId: String(provider.modelId || '').normalize('NFKC')
              .replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 160),
            isPrimary: provider.isPrimary === true,
            isFallback: provider.isFallback === true,
          }))
          .filter((provider) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(provider.providerKey) && provider.modelId)
          .slice(0, 100);
        statusPayload.adminControls = statusPayload.providers.length > 0;
      } catch {
        statusPayload.providers = [];
        statusPayload.adminControls = false;
      }
    }
    sendJson(res, 200, statusPayload);
    return true;
  }

  if (!enabledForAdmin || !workspaceService || !aiChatHistoryService
      || !(pendingToolApprovals instanceof Map)
      || typeof aiChatService.complete !== 'function'
      || (streamingRequest && typeof aiChatService.stream !== 'function')) {
    sendJson(res, 503, { error: 'ai_chat_unavailable' });
    return true;
  }

  const loadOwnedAgent = async (agentId) => {
    const bootstrap = await workspaceService.getBootstrap({ userId: user.id });
    const workspace = bootstrap?.workspace;
    const agent = (Array.isArray(bootstrap?.agents) ? bootstrap.agents : [])
      .find((entry) => String(entry?.id) === agentId)
      || (String(bootstrap?.onboarding?.agent?.id || '') === agentId ? bootstrap.onboarding.agent : null);
    if (!workspace?.id || workspace.status !== 'active' || !agent || agent.status === 'archived') {
      throw new RequestError('ai_chat_agent_unavailable', 404);
    }
    return { workspace, agent };
  };

  const agentIdFromUrl = () => {
    const agentId = String(url.searchParams.get('agentId') || '').trim();
    if (!agentId || agentId.length > 255 || /[\r\n\0]/.test(agentId)) {
      throw new RequestError('ai_chat_request_invalid', 400);
    }
    return agentId;
  };

  if (historyRoute) {
    try {
      if (!aiChatHistoryService || !workspaceService) throw new RequestError('ai_chat_unavailable', 503);
      const agentId = agentIdFromUrl();
      const { workspace } = await loadOwnedAgent(agentId);
      const history = await aiChatHistoryService.getHistory({ workspaceId: workspace.id, userId: user.id, agentId });
      const pendingActions = pendingWorkspaceToolApprovalViews(pendingToolApprovals, {
        userId: user.id, workspaceId: workspace.id, chatAgentId: agentId,
      });
      sendJson(res, 200, { messages: history.messages, pendingActions });
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(res, error.status, { error: error.code });
      } else if (error instanceof WorkspaceError) {
        sendJson(res, error.status, { error: 'ai_chat_agent_unavailable' });
      } else {
        const requestId = crypto.randomUUID();
        console.error('Desktop AI chat history failed:', JSON.stringify({ requestId, error: error?.name || 'Error' }));
        sendJson(res, error instanceof AiChatHistoryError ? error.status : 503, {
          error: 'ai_chat_history_unavailable',
          requestId,
        });
      }
    }
    return true;
  }

  if (toolApprovalRoute) {
    await handleWorkspaceToolApprovalRequest(req, res, {
      user, workspaceService, aiChatHistoryService, pendingApprovals: pendingToolApprovals, db, channel3Client,
    });
    return true;
  }

  if (!usageService
      || typeof usageService.reserveTokens !== 'function'
      || typeof usageService.settleTokenReservation !== 'function'
      || typeof usageService.releaseTokenReservation !== 'function') {
    sendJson(res, 503, { error: 'ai_chat_unavailable' });
    return true;
  }

  const requestId = crypto.randomUUID();
  let streamResponseStarted = false;
  let streamController = null;
  let tokenReservationHeld = false;
  let streamCompletion = null;
  let streamAvatarCueCount = 0;
  let streamAvatarEmotionCount = 0;
  let streamHistoryAttempted = false;
  let streamHistoryPersisted = false;
  let pendingApprovalView = null;
  let streamWorkspaceGate = null;
  let workspace = null;
  let agent = null;
  let agentId = '';
  let requestProviderKey;
  let requestModelId;
  let newUserMessage = null;
  let fileContext = null;
  let idempotencyKey = null;
  try {
    consumeAiChatRateLimit(rateWindows, String(user.id || ''));
    const input = await readJsonBody(req, 16 * 1024);
    if (Object.keys(input).some((key) => !['agentId', 'message', 'providerKey', 'modelId', 'agentMode', 'fileIds'].includes(key))) {
      throw new RequestError('ai_chat_request_invalid', 400);
    }
    if (input.agentMode !== undefined && typeof input.agentMode !== 'boolean') {
      throw new RequestError('ai_chat_request_invalid', 400);
    }
    // Older clients may still send agentMode; the workspace agent is always enabled regardless of its value.
    if (input.providerKey !== undefined) {
      if (typeof input.providerKey !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(input.providerKey.trim())) {
        throw new AiProviderError('ai_provider_key_invalid');
      }
      requestProviderKey = input.providerKey.trim().toLowerCase();
    }
    if (input.modelId !== undefined) {
      if (typeof input.modelId !== 'string' || !input.modelId.trim() || input.modelId.trim().length > 160
          || /[\u0000-\u001f\u007f-\u009f]/.test(input.modelId)) {
        throw new AiProviderError('ai_provider_model_invalid');
      }
      requestModelId = input.modelId.trim();
    }
    agentId = String(input.agentId || '').trim();
    if (!agentId || agentId.length > 255 || /[\r\n\0]/.test(agentId)) {
      throw new RequestError('ai_chat_request_invalid', 400);
    }
    newUserMessage = normalizeAiChatMessages([{ role: 'user', content: input.message }])[0];
    const wantsResearch = /^\/research(?:\s|$)/i.test(newUserMessage.content);
    const researchQuery = wantsResearch ? newUserMessage.content.replace(/^\/research\s*/i, '').trim() : '';
    let researchContext = null;
    if (input.fileIds !== undefined && (!Array.isArray(input.fileIds) || input.fileIds.length < 1 || input.fileIds.length > 3)) throw new FileToolError('file_selection_invalid');
    if (input.fileIds && req.headers['x-file-consent'] !== FILE_CONSENT) throw new FileToolError('file_consent_required');
    if (input.fileIds && wantsResearch) throw new FileToolError('file_research_combination_unsupported');
    if (wantsResearch) {
      if (req.headers['x-research-consent'] !== RESEARCH_CONSENT) throw new ResearchError('research_consent_required', 400);
      if (!researchService?.configured) throw new ResearchError('research_not_configured', 503);
      if (!researchQuery || researchQuery.length > 1000) throw new ResearchError('research_query_invalid', 400);
    }
    if (!await aiChatService.isReady()) throw new AiProviderError('ai_provider_primary_unavailable', 503);

    ({ workspace, agent } = await loadOwnedAgent(agentId));
    if (input.fileIds) fileContext = filesService.context({ ids: input.fileIds, userId: user.id, workspaceId: workspace.id, agent });
    const requireResearchPermissions = async () => {
      const current = await loadOwnedAgent(agentId);
      if (current.workspace.id !== workspace.id || current.agent.settings?.toolPermissions?.web_search !== true || current.agent.settings?.toolPermissions?.read_webpage !== true) throw new ResearchError('research_permission_required', 403);
    };
    if (wantsResearch) await requireResearchPermissions();
    const refreshFileContext = async () => {
      if (!input.fileIds) return;
      const current = await loadOwnedAgent(agentId);
      if (current.workspace.id !== workspace.id) throw new FileToolError('file_unavailable', 404);
      fileContext = filesService.context({ ids: input.fileIds, userId: user.id, workspaceId: workspace.id, agent: current.agent });
    };
    const researchBeforeReply = async (signal, onStage) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted || req.aborted || res.destroyed) abort();
      signal?.addEventListener('abort', abort, { once: true }); res.once('close', abort);
      try {
        researchContext = await researchService.run({ agent, query: researchQuery, userId: user.id, signal: controller.signal, onStage });
        await requireResearchPermissions();
      } finally { signal?.removeEventListener('abort', abort); res.off('close', abort); }
    };
    const storedMessages = await aiChatHistoryService.getRecentMessages({
      workspaceId: workspace.id,
      userId: user.id,
      agentId,
      limit: 11,
    });
    const context = [];
    let contextCharacters = newUserMessage.content.length;
    for (let index = storedMessages.length - 1; index >= 0 && context.length < 11; index -= 1) {
      const entry = storedMessages[index];
      const content = String(entry.content || '').slice(0, 4_000);
      if (contextCharacters + content.length > 16_000) break;
      context.unshift({ role: entry.role, content });
      contextCharacters += content.length;
    }
    if (context[0]?.role === 'assistant') context.shift();
    const messages = normalizeAiChatMessages([...context, newUserMessage]);

    const messageCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
    const profileCharacters = String(agent.name || '').length + String(agent.role || '').length + String(agent.settings?.instructions || '').length + (wantsResearch ? 18000 : 0) + (fileContext ? JSON.stringify(fileContext).length + 1000 : 0) + 600;
    const estimatedTokens = Math.ceil((messageCharacters + profileCharacters + 1_000) / 2) + AI_CHAT_MAX_OUTPUT_TOKENS;
    idempotencyKey = `ai-chat:${crypto.randomUUID()}`;
    await usageService.reserveTokens({
      workspaceId: workspace.id,
      userId: user.id,
      idempotencyKey,
      estimatedTokens,
    });
    tokenReservationHeld = true;

    if (streamingRequest) {
      streamController = new AbortController();
      const abortOnRequest = () => streamController.abort();
      const abortOnResponseClose = () => {
        if (!res.writableEnded) streamController.abort();
      };
      req.once('aborted', abortOnRequest);
      res.once('close', abortOnResponseClose);
      if (req.aborted || res.destroyed) streamController.abort();
      streamResponseStarted = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      try {
        await refreshFileContext();
        if (wantsResearch) await researchBeforeReply(streamController.signal, stage => writeSseEvent(res, 'research_status', { stage }, streamController.signal));
        const requestedMoodCue = explicitAvatarEmotionCue(newUserMessage?.content);
        if (requestedMoodCue) {
          streamAvatarCueCount += 1;
          streamAvatarEmotionCount += 1;
          await writeSseEvent(res, 'avatar_cue', { avatar: 'emotion', cue: requestedMoodCue }, streamController.signal);
        }
        streamWorkspaceGate = createWorkspaceToolStreamGate((text) => writeSseEvent(res, 'delta', { text }, streamController.signal));
        const completion = await aiChatService.stream({
          agent,
          messages,
          workspaceTools: !wantsResearch && !fileContext,
          ...(researchContext ? { researchContext } : {}),
          ...(fileContext ? { fileContext } : {}),
          ...(requestProviderKey ? { providerKey: requestProviderKey } : {}),
          ...(requestModelId ? { modelId: requestModelId } : {}),
          signal: streamController.signal,
          onDelta: (text) => streamWorkspaceGate.push(text),
          onAvatarCue: (cue) => {
            const isScoutCue = String(agent?.avatar || '').trim().toLowerCase() === 'magnifier'
              && AI_CHAT_AVATAR_CUES.includes(cue);
            const isEmotionCue = AI_CHAT_AVATAR_EMOTION_CUES.includes(cue);
            if ((!isScoutCue && !isEmotionCue)
                || streamAvatarCueCount >= AI_CHAT_MAX_AVATAR_CUES_PER_REPLY
                || (isEmotionCue && streamAvatarEmotionCount >= 1)) return Promise.resolve();
            streamAvatarCueCount += 1;
            if (isEmotionCue) streamAvatarEmotionCount += 1;
            return writeSseEvent(res, 'avatar_cue', {
              avatar: isEmotionCue ? 'emotion' : 'magnifier',
              cue,
            }, streamController.signal);
          },
        });
        await streamWorkspaceGate.flush();
        const parsedToolCall = parseWorkspaceToolCall(completion.text);
        const toolCall = parsedToolCall.kind === 'none' && streamWorkspaceGate.hasMarkerCandidate()
          ? { kind: 'invalid' }
          : parsedToolCall;
        const safePrefix = streamWorkspaceGate.visibleText();
        let visibleReply = typeof completion.text === 'string' ? completion.text : '';
        streamCompletion = { ...completion, text: safePrefix.trim() ? safePrefix : 'I could not safely complete that workspace request. Nothing was changed.' };
        if ((wantsResearch || fileContext) && toolCall.kind !== 'none') {
          visibleReply = 'The analysis response could not be safely presented. No action was taken.';
          await writeSseEvent(res, 'delta', { text: visibleReply }, streamController.signal);
        } else if (toolCall.kind === 'invalid') {
          visibleReply = safePrefix.trim()
            ? safePrefix
            : 'I could not safely interpret that workspace operation, so nothing was changed. Please try a single, specific request.';
          streamCompletion = { ...completion, text: visibleReply };
          if (!safePrefix.trim()) await writeSseEvent(res, 'delta', { text: visibleReply }, streamController.signal);
        } else if (toolCall.kind === 'tool') {
          visibleReply = 'I could not safely complete that workspace request. Nothing was changed.';
          streamCompletion = { ...completion, text: visibleReply };
          const bootstrap = await workspaceService.getBootstrap({ userId: user.id });
          let prepared;
          if (String(bootstrap?.workspace?.id || '') !== String(workspace.id)) {
            visibleReply = 'Your active workspace changed during this request, so nothing was changed. Please try again.';
          } else {
            try { prepared = prepareWorkspaceToolCall(toolCall, bootstrap); }
            catch (error) {
              if (!(error instanceof WorkspaceToolError)) throw error;
              visibleReply = workspaceToolFailureMessage(error);
            }
          }
          if (prepared?.kind === 'read') {
            visibleReply = prepared.text;
          } else if (prepared?.kind === 'search_products') {
            visibleReply = await executeProductSearchTool(prepared, {
              channel3Client,
              db,
              workspaceId: workspace.id,
              userId: user.id,
              agentId,
            });
          } else if (prepared?.kind === 'purchase_product') {
            const purchaseExec = await executePurchaseProductTool(prepared, {
              db,
              workspaceId: workspace.id,
              userId: user.id,
              agentId,
            });
            if (purchaseExec.kind === 'proposal') {
              pendingApprovalView = createPendingWorkspaceToolApproval(pendingToolApprovals, {
                userId: user.id,
                workspaceId: workspace.id,
                chatAgentId: agentId,
                prepared: purchaseExec.prepared,
              });
              visibleReply = `I evaluated our spend policy and formulated an autonomous purchase mandate for **${escapeMarkdown(purchaseExec.prepared.payload.productTitle)}** ($${(purchaseExec.prepared.payload.amountMinor / 100).toFixed(2)} ${purchaseExec.prepared.payload.currency}). Please review and authorize the purchase below:`;
            } else {
              visibleReply = purchaseExec.text;
            }
          } else if (prepared?.kind === 'proposal') {
            pendingApprovalView = createPendingWorkspaceToolApproval(pendingToolApprovals, {
              userId: user.id,
              workspaceId: workspace.id,
              chatAgentId: agentId,
              prepared,
            });
            visibleReply = 'I prepared a workspace change for your review. Nothing will be changed unless you approve it below.';
          }
          if (!visibleReply.trim()) visibleReply = 'I could not complete that workspace request. Please try again.';
          streamCompletion = { ...completion, text: visibleReply };
          await writeSseEvent(res, 'delta', { text: visibleReply }, streamController.signal);
        } else {
          if (!visibleReply.trim()) visibleReply = 'I could not complete that workspace request. Please try again.';
          streamCompletion = { ...completion, text: visibleReply };
          const alreadySent = streamWorkspaceGate.visibleText();
          if (visibleReply.startsWith(alreadySent)) {
            const remainder = visibleReply.slice(alreadySent.length);
            if (remainder) await writeSseEvent(res, 'delta', { text: remainder }, streamController.signal);
          } else if (!alreadySent.trim()) {
            await writeSseEvent(res, 'delta', { text: visibleReply }, streamController.signal);
          }
        }
        if (researchContext) { const sources = researchSourcesMarkdown(researchContext); visibleReply += sources; await writeSseEvent(res, 'delta', { text: sources }, streamController.signal); }
        streamCompletion = { ...completion, text: visibleReply };
        if (streamCompletion.fallbackUsed === true) {
          const fallbackAttempts = Number.isSafeInteger(streamCompletion.fallbackAttempts) ? streamCompletion.fallbackAttempts : 0;
          console.info('Desktop AI chat used an approved fallback:', JSON.stringify({ requestId, fallbackAttempts }));
        }
        await usageService.settleTokenReservation({
          workspaceId: workspace.id,
          idempotencyKey,
          provider: streamCompletion.provider,
          model: streamCompletion.model,
          inputTokens: streamCompletion.inputTokens,
          outputTokens: streamCompletion.outputTokens,
        });
        tokenReservationHeld = false;
        streamHistoryAttempted = true;
        await aiChatHistoryService.appendExchange({
          workspaceId: workspace.id,
          userId: user.id,
          agentId,
          userMessage: newUserMessage.content + (fileContext ? '\n\n[Attached files: ' + fileContext.files.map(file => file.name).join(', ') + ']' : ''),
          assistantMessage: streamCompletion.text,
        });
        streamHistoryPersisted = true;
        if (pendingApprovalView) {
          await writeSseEvent(res, 'tool_approval_required', pendingApprovalView, streamController.signal);
        }
        const attribution = adminProviderAttribution(config, user, streamCompletion);
        await writeSseEvent(res, 'done', { requestId, ...(attribution ? { attribution } : {}) }, streamController.signal);
        res.end();
        return true;
      } finally {
        req.removeListener('aborted', abortOnRequest);
        res.removeListener('close', abortOnResponseClose);
      }
    }

    let completion;
    try {
      await refreshFileContext();
      if (wantsResearch) await researchBeforeReply();
      completion = await aiChatService.complete({
        agent,
        messages,
        workspaceTools: !wantsResearch && !fileContext,
        ...(researchContext ? { researchContext } : {}),
          ...(fileContext ? { fileContext } : {}),
        ...(requestProviderKey ? { providerKey: requestProviderKey } : {}),
        ...(requestModelId ? { modelId: requestModelId } : {}),
      });
    } catch (error) {
      try {
        await usageService.releaseTokenReservation({ workspaceId: workspace.id, idempotencyKey });
        tokenReservationHeld = false;
      } catch {}
      throw error;
    }

    const toolCall = parseWorkspaceToolCall(completion.text);
    let visibleReply = typeof completion.text === 'string' ? completion.text : '';
    let preparedWorkspaceProposal = null;
    if ((wantsResearch || fileContext) && toolCall.kind !== 'none') {
      visibleReply = 'The analysis response could not be safely presented. No action was taken.';
    } else if (toolCall.kind === 'invalid') {
      visibleReply = 'I could not safely interpret that workspace operation, so nothing was changed. Please try a single, specific request.';
    } else if (toolCall.kind === 'tool') {
      visibleReply = 'I could not safely complete that workspace request. Nothing was changed.';
      const bootstrap = await workspaceService.getBootstrap({ userId: user.id });
      if (String(bootstrap?.workspace?.id || '') !== String(workspace.id)) {
        visibleReply = 'Your active workspace changed during this request, so nothing was changed. Please try again.';
      } else {
        let prepared;
        try { prepared = prepareWorkspaceToolCall(toolCall, bootstrap); }
        catch (error) {
          if (!(error instanceof WorkspaceToolError)) throw error;
          visibleReply = workspaceToolFailureMessage(error);
        }
        if (prepared?.kind === 'read') {
          visibleReply = prepared.text;
        } else if (prepared?.kind === 'search_products') {
          visibleReply = await executeProductSearchTool(prepared, {
            channel3Client,
            db,
            workspaceId: workspace.id,
            userId: user.id,
            agentId,
          });
        } else if (prepared?.kind === 'purchase_product') {
          const purchaseExec = await executePurchaseProductTool(prepared, {
            db,
            workspaceId: workspace.id,
            userId: user.id,
            agentId,
          });
          if (purchaseExec.kind === 'proposal') {
            preparedWorkspaceProposal = { workspaceId: workspace.id, prepared: purchaseExec.prepared };
            visibleReply = `I evaluated our spend policy and formulated an autonomous purchase mandate for **${escapeMarkdown(purchaseExec.prepared.payload.productTitle)}** ($${(purchaseExec.prepared.payload.amountMinor / 100).toFixed(2)} ${purchaseExec.prepared.payload.currency}). Please review and authorize the purchase below:`;
          } else {
            visibleReply = purchaseExec.text;
          }
        } else if (prepared?.kind === 'proposal') {
          preparedWorkspaceProposal = { workspaceId: workspace.id, prepared };
          visibleReply = 'I prepared a workspace change for your review. Nothing will be changed unless you approve it.';
        }
      }
    }
    if (!visibleReply.trim()) visibleReply = 'I could not complete that workspace request. Please try again.';
    if (researchContext) visibleReply += researchSourcesMarkdown(researchContext);
    completion = { ...completion, text: visibleReply };

    try {
      await usageService.settleTokenReservation({
        workspaceId: workspace.id,
        idempotencyKey,
        provider: completion.provider,
        model: completion.model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      });
      tokenReservationHeld = false;
    } catch (error) {
      console.error('AI chat usage settlement failed:', JSON.stringify({ requestId, error: error?.name || 'Error' }));
      sendJson(res, 503, { error: 'ai_chat_unavailable', requestId });
      return true;
    }

    if (completion.fallbackUsed === true) {
      const fallbackAttempts = Number.isSafeInteger(completion.fallbackAttempts) ? completion.fallbackAttempts : 0;
      console.info('Desktop AI chat used an approved fallback:', JSON.stringify({ requestId, fallbackAttempts }));
    }
    if (preparedWorkspaceProposal) {
      pendingApprovalView = createPendingWorkspaceToolApproval(pendingToolApprovals, {
        userId: user.id,
        workspaceId: preparedWorkspaceProposal.workspaceId,
        chatAgentId: agentId,
        prepared: preparedWorkspaceProposal.prepared,
      });
    }
    await aiChatHistoryService.appendExchange({
      workspaceId: workspace.id,
      userId: user.id,
      agentId,
      userMessage: newUserMessage.content + (fileContext ? '\n\n[Attached files: ' + fileContext.files.map(file => file.name).join(', ') + ']' : ''),
      assistantMessage: completion.text,
    });
    streamHistoryPersisted = true;
    const attribution = adminProviderAttribution(config, user, completion);
    sendJson(res, 200, {
      reply: completion.text,
      requestId,
      ...(attribution ? { attribution } : {}),
      ...(pendingApprovalView ? { pendingAction: pendingApprovalView } : {}),
    });
  } catch (error) {
    const safeCode = error instanceof UsageLimitError || error instanceof UsageReservationError
      || error instanceof RequestError || error instanceof ResearchError || error instanceof FileToolError || error instanceof AiProviderError || error instanceof AiChatHistoryError
      ? String(error.code || 'request_failed').slice(0, 80)
      : 'internal_error';
    const upstreamStatus = Number.isInteger(error?.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599
      ? error.upstreamStatus
      : undefined;
    const fallbackAttempts = Number.isSafeInteger(error?.fallbackAttempts) && error.fallbackAttempts >= 0
      ? error.fallbackAttempts
      : undefined;
    const adminDiagnostics = adminChatErrorDiagnostics(config, user, requestId, error);
    const addAdminDiagnostics = (payload) => adminDiagnostics ? { ...payload, adminDiagnostics } : payload;
    console.error('Desktop AI chat failed:', JSON.stringify({
      requestId,
      error: error?.name || 'Error',
      code: safeCode,
      ...(upstreamStatus ? { upstreamStatus } : {}),
      ...(fallbackAttempts !== undefined ? { fallbackAttempts } : {}),
    }));

    if (!streamingRequest && tokenReservationHeld && workspace && idempotencyKey) {
      try {
        await usageService.releaseTokenReservation({ workspaceId: workspace.id, idempotencyKey });
        tokenReservationHeld = false;
      } catch (releaseError) {
        console.error('AI chat usage reservation release failed:', JSON.stringify({ requestId, error: releaseError?.name || 'Error' }));
      }
    }
    if (pendingApprovalView && !streamHistoryPersisted) pendingToolApprovals.delete(pendingApprovalView.actionId);
    if (streamingRequest && streamResponseStarted) {
      const partialCompletion = error?.partialCompletion && typeof error.partialCompletion === 'object'
        ? error.partialCompletion
        : null;
      let completionToSave = streamCompletion || partialCompletion;
      if (!streamCompletion && partialCompletion && streamWorkspaceGate
          && (streamWorkspaceGate.hasMarkerCandidate() || parseWorkspaceToolCall(partialCompletion.text).kind !== 'none')) {
        const safePrefix = streamWorkspaceGate.visibleText();
        completionToSave = {
          ...partialCompletion,
          text: safePrefix.trim() ? safePrefix : 'I could not safely interpret that workspace operation, so nothing was changed. Please try again.',
        };
      }
      let streamFailure = error;

      if (tokenReservationHeld && completionToSave) {
        try {
          await usageService.settleTokenReservation({
            workspaceId: workspace.id,
            idempotencyKey,
            provider: completionToSave.provider,
            model: completionToSave.model,
            inputTokens: completionToSave.inputTokens,
            outputTokens: completionToSave.outputTokens,
          });
          tokenReservationHeld = false;
        } catch (settlementError) {
          console.error('AI chat usage settlement failed:', JSON.stringify({ requestId, error: settlementError?.name || 'Error' }));
          streamFailure = settlementError;
        }
      } else if (tokenReservationHeld) {
        try {
          await usageService.releaseTokenReservation({ workspaceId: workspace.id, idempotencyKey });
          tokenReservationHeld = false;
        } catch (releaseError) {
          console.error('AI chat usage reservation release failed:', JSON.stringify({ requestId, error: releaseError?.name || 'Error' }));
        }
      }

      if (completionToSave && !tokenReservationHeld && !streamHistoryAttempted) {
        streamHistoryAttempted = true;
        try {
          await aiChatHistoryService.appendExchange({
            workspaceId: workspace.id,
            userId: user.id,
            agentId,
            userMessage: newUserMessage.content + (fileContext ? '\n\n[Attached files: ' + fileContext.files.map(file => file.name).join(', ') + ']' : ''),
            assistantMessage: completionToSave.text,
          });
        } catch (historyError) {
          streamFailure = historyError;
          console.error('Desktop AI chat history persistence failed:', JSON.stringify({ requestId, error: historyError?.name || 'Error' }));
        }
      }

      const clientGone = streamController?.signal.aborted === true
        || res.destroyed || error?.code === 'ai_chat_stream_client_closed';
      if (!clientGone && !res.writableEnded) {
        if (!res.headersSent) {
          sendJson(res, 503, addAdminDiagnostics({ error: 'ai_chat_unavailable', requestId }));
          return true;
        }
        let publicError = 'ai_chat_unavailable';
        if (streamFailure instanceof UsageLimitError) publicError = 'token_usage_limit_exceeded';
        else if (streamFailure instanceof UsageReservationError) {
          publicError = streamFailure.code === 'active_entitlement_required' ? 'active_entitlement_required' : 'ai_chat_unavailable';
        } else if (streamFailure instanceof RequestError || streamFailure instanceof ResearchError || streamFailure instanceof FileToolError) publicError = streamFailure.code;
        else if (streamFailure instanceof AiChatHistoryError) publicError = 'ai_chat_history_unavailable';
        else if (streamFailure instanceof WorkspaceError) publicError = 'ai_chat_agent_unavailable';
        else if (streamFailure instanceof AiProviderError && streamFailure.code === 'ai_chat_messages_invalid') {
          publicError = streamFailure.code;
        }
        try {
          await writeSseEvent(res, 'error', addAdminDiagnostics({ error: publicError, requestId }), streamController?.signal);
        } catch {}
        if (!res.destroyed && !res.writableEnded) res.end();
      }
      return true;
    }

    if (error instanceof UsageLimitError) {
      sendJson(res, 429, addAdminDiagnostics({ error: 'token_usage_limit_exceeded', requestId }));
    } else if (error instanceof UsageReservationError) {
      sendJson(res, error.code === 'active_entitlement_required' ? 403 : 409, addAdminDiagnostics({
        error: error.code === 'active_entitlement_required' ? 'active_entitlement_required' : 'ai_chat_unavailable',
        requestId,
      }));
    } else if (error instanceof RequestError || error instanceof ResearchError || error instanceof FileToolError) {
      sendJson(res, error.status, addAdminDiagnostics({ error: error.code, requestId }));
    } else if (error instanceof AiChatHistoryError) {
      sendJson(res, error.status, addAdminDiagnostics({ error: 'ai_chat_history_unavailable', requestId }));
    } else if (error instanceof AiProviderError) {
      if (error.code === 'ai_chat_messages_invalid') {
        sendJson(res, error.status, addAdminDiagnostics({ error: error.code, requestId }));
      } else {
        sendJson(res, 502, addAdminDiagnostics({ error: 'ai_chat_unavailable', requestId }));
      }
    } else if (error instanceof WorkspaceError) {
      sendJson(res, error.status, addAdminDiagnostics({ error: 'ai_chat_agent_unavailable', requestId }));
    } else {
      sendJson(res, 500, addAdminDiagnostics({ error: 'ai_chat_unavailable', requestId }));
    }
  }
  return true;
}

async function handleApiHubRequest(req, res, url, { config, authService, apiHubService }) {
  if (!config.apiHubEnabled || !apiHubService) {
    sendJson(res, 503, { error: 'api_hub_not_configured' });
    return true;
  }

  const adminPaths = url.pathname.startsWith('/api/hub/admin/');
  if (adminPaths) {
    if (req.method !== 'GET') {
      const origin = requestOrigin(req);
      if (!origin.present || !origin.valid || !origin.sameOrigin) {
        sendJson(res, 403, { error: 'same_origin_required' });
        return true;
      }
    }
    if (!authService) {
      sendJson(res, 503, { error: 'auth_storage_not_configured' });
      return true;
    }
    let user = null;
    try {
      const token = cookieValue(req, sessionCookieName(config));
      user = token ? await authService.getSession({ token }) : null;
    } catch {
      user = null;
    }
    if (!user) {
      sendJson(res, 401, { error: 'authentication_required' });
      return true;
    }
    const admins = Array.isArray(config.apiHubAdminEmails) ? config.apiHubAdminEmails : [];
    if (!admins.includes(String(user.email || '').trim().normalize('NFKC').toLowerCase())) {
      sendJson(res, 403, { error: 'api_hub_admin_required' });
      return true;
    }

    try {
      if (url.pathname === '/api/hub/admin/connectors' && req.method === 'GET') {
        sendJson(res, 200, { connectors: await apiHubService.listConnectors({ ownerUserId: user.id }) });
        return true;
      }
      if (url.pathname === '/api/hub/admin/connectors' && req.method === 'POST') {
        const input = await readJsonBody(req, 64 * 1024);
        const connector = await apiHubService.createConnector({ ownerUserId: user.id, input });
        sendJson(res, 201, { connector });
        return true;
      }
      const updateConnectorMatch = url.pathname.match(/^\/api\/hub\/admin\/connectors\/([0-9a-f-]{36})$/i);
      if (updateConnectorMatch && req.method === 'PUT') {
        const input = await readJsonBody(req, 64 * 1024);
        const connector = await apiHubService.updateConnector({
          ownerUserId: user.id,
          connectorId: updateConnectorMatch[1],
          input,
        });
        sendJson(res, 200, { connector });
        return true;
      }
      const deleteConnectorMatch = url.pathname.match(/^\/api\/hub\/admin\/connectors\/([0-9a-f-]{36})$/i);
      if (deleteConnectorMatch && req.method === 'DELETE') {
        sendJson(res, 200, await apiHubService.deleteConnector({ ownerUserId: user.id, connectorId: deleteConnectorMatch[1] }));
        return true;
      }
      if (url.pathname === '/api/hub/admin/tokens' && req.method === 'GET') {
        sendJson(res, 200, { tokens: await apiHubService.listTokens({ ownerUserId: user.id }) });
        return true;
      }
      if (url.pathname === '/api/hub/admin/tokens' && req.method === 'POST') {
        const body = await readJsonBody(req, 16 * 1024);
        const token = await apiHubService.createAccessToken({
          ownerUserId: user.id,
          label: body.label,
          scopes: body.scopes,
          expiresInDays: body.expiresInDays,
        });
        sendJson(res, 201, { token });
        return true;
      }
      const revokeTokenMatch = url.pathname.match(/^\/api\/hub\/admin\/tokens\/([0-9a-f-]{36})\/revoke$/i);
      if (revokeTokenMatch && req.method === 'POST') {
        sendJson(res, 200, await apiHubService.revokeAccessToken({ ownerUserId: user.id, tokenId: revokeTokenMatch[1] }));
        return true;
      }
      if (url.pathname === '/api/hub/admin/audit' && req.method === 'GET') {
        sendJson(res, 200, { events: await apiHubService.listAudit({ ownerUserId: user.id }) });
        return true;
      }
      sendJson(res, 404, { error: 'api_hub_admin_route_not_found' });
      return true;
    } catch (error) {
      if (error instanceof ApiHubError || error instanceof RequestError) {
        sendJson(res, error.status, { error: error.code });
      } else {
        console.error('API Hub admin request failed:', error?.name || 'Error');
        sendJson(res, 500, { error: 'api_hub_request_failed' });
      }
      return true;
    }
  }

  if (url.pathname === '/api/hub/manifest' && req.method === 'GET') {
    const match = String(req.headers.authorization || '').match(/^Bearer (khub_[A-Za-z0-9_-]{43})$/);
    if (!match) {
      sendJson(res, 401, { error: 'agent_token_invalid' });
      return true;
    }
    try {
      sendJson(res, 200, await apiHubService.listManifest({ token: match[1] }));
    } catch (error) {
      if (error instanceof ApiHubError) sendJson(res, error.status, { error: error.code });
      else {
        console.error('API Hub manifest request failed:', error?.name || 'Error');
        sendJson(res, 500, { error: 'api_hub_request_failed' });
      }
    }
    return true;
  }

  if (url.pathname === '/api/hub/invoke' && req.method === 'POST') {
    const match = String(req.headers.authorization || '').match(/^Bearer (khub_[A-Za-z0-9_-]{43})$/);
    if (!match) {
      sendJson(res, 401, { error: 'agent_token_invalid' });
      return true;
    }
    try {
      const body = await readJsonBody(req, 96 * 1024);
      const result = await apiHubService.invoke({ ...body, token: match[1] });
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof ApiHubError || error instanceof RequestError) {
        sendJson(res, error.status, { error: error.code });
      } else {
        console.error('API Hub invocation failed:', error?.name || 'Error');
        sendJson(res, 500, { error: 'api_hub_request_failed' });
      }
    }
    return true;
  }

  sendJson(res, 404, { error: 'api_hub_route_not_found' });
  return true;
}

async function handleWorkspaceRequest(req, res, url, { config, authService, workspaceService }) {
  const bootstrapRoute = url.pathname === '/api/workspace/bootstrap';
  const onboardingRoute = url.pathname === '/api/onboarding/complete';
  const createAgentRoute = url.pathname === '/api/workspace/agents';
  if (!bootstrapRoute && !onboardingRoute && !createAgentRoute) return false;

  const expectedMethod = bootstrapRoute ? 'GET' : 'POST';
  if (req.method !== expectedMethod) {
    res.setHeader('Allow', `${expectedMethod}, OPTIONS`);
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  if (onboardingRoute || createAgentRoute) {
    const origin = requestOrigin(req);
    if (!origin.present || !origin.valid || !origin.sameOrigin) {
      sendJson(res, 403, { error: 'same_origin_required' });
      return true;
    }
  }
  if (!authService) {
    sendJson(res, 503, { error: 'auth_storage_not_configured' });
    return true;
  }
  if (!workspaceService) {
    sendJson(res, 503, { error: 'workspace_storage_not_configured' });
    return true;
  }

  let user = null;
  try {
    const token = cookieValue(req, sessionCookieName(config));
    user = token ? await authService.getSession({ token }) : null;
  } catch {
    user = null;
  }
  if (!user) {
    sendJson(res, 401, { error: 'authentication_required' });
    return true;
  }

  try {
    if (bootstrapRoute) {
      const bootstrap = await workspaceService.getBootstrap({ userId: user.id });
      sendJson(res, 200, bootstrap);
      return true;
    }
    const input = await readJsonBody(req, 16 * 1024);
    if (onboardingRoute) {
      const bootstrap = await workspaceService.completeOnboarding({ userId: user.id, input });
      sendJson(res, 200, { saved: true, ...bootstrap });
      return true;
    }
    const bootstrap = await workspaceService.createAgent({ userId: user.id, input });
    sendJson(res, 201, { created: true, ...bootstrap });
    return true;
  } catch (error) {
    if (error instanceof WorkspaceError || error instanceof RequestError) {
      sendJson(res, error.status, { error: error.code });
    } else {
      console.error('Workspace request failed:', error?.name || 'Error');
      sendJson(res, 500, { error: 'workspace_request_failed' });
    }
    return true;
  }
}

async function handleSettingsRequest(req, res, url, { config, authService, workspaceService, workosAuth }) {
  const emailChangeRoute = url.pathname === '/api/settings/email-change';
  const settingsRoute = new Set([
    '/api/settings/profile',
    '/api/settings/workspace',
    '/api/settings/theme',
    '/api/settings/password',
    '/api/settings/email-change/start',
    '/api/settings/email-change/confirm',
  ]).has(url.pathname);
  const agentMatch = url.pathname.match(/^\/api\/settings\/agents\/([^/]+)$/);
  if (!settingsRoute && !emailChangeRoute && !agentMatch) return false;

  const readPendingEmail = emailChangeRoute && req.method === 'GET';
  const expectedMethod = readPendingEmail ? 'GET'
    : ['/api/settings/email-change/start', '/api/settings/email-change/confirm'].includes(url.pathname) ? 'POST'
      : 'PUT';
  if (req.method !== expectedMethod) {
    res.setHeader('Allow', `${expectedMethod}, OPTIONS`);
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  if (!readPendingEmail) {
    try { requireSameOrigin(req); } catch (error) {
      sendJson(res, error.status || 403, { error: error.code || 'same_origin_required' });
      return true;
    }
  }
  if (!authService) {
    sendJson(res, 503, { error: 'auth_storage_not_configured' });
    return true;
  }

  const sessionToken = cookieValue(req, sessionCookieName(config));
  let user = null;
  try { user = sessionToken ? await authService.getSession({ token: sessionToken }) : null; } catch { user = null; }
  if (!user) {
    sendJson(res, 401, { error: 'authentication_required' });
    return true;
  }

  const metadata = {
    ipAddress: req.socket.remoteAddress,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
  };
  try {
    if (readPendingEmail) {
      const pending = await authService.getPendingEmailChange({ userId: user.id, sessionToken });
      sendJson(res, 200, {
        pending: pending ? { email: pending.newEmail, expiresAt: pending.expiresAt } : null,
      });
      return true;
    }

    const body = await readJsonBody(req, 16 * 1024);
    if (url.pathname === '/api/settings/profile') {
      const updatedUser = await authService.updateDisplayName({ userId: user.id, displayName: body.displayName });
      sendJson(res, 200, { updated: true, user: updatedUser });
      return true;
    }
    if (url.pathname === '/api/settings/theme') {
      const result = await authService.updateTheme({ userId: user.id, theme: body.theme });
      sendJson(res, 200, result);
      return true;
    }
    if (url.pathname === '/api/settings/workspace') {
      if (!workspaceService) {
        sendJson(res, 503, { error: 'workspace_storage_not_configured' });
        return true;
      }
      const bootstrap = await workspaceService.updateWorkspaceName({ userId: user.id, name: body.name });
      sendJson(res, 200, { saved: true, ...bootstrap });
      return true;
    }
    if (agentMatch) {
      if (!workspaceService) {
        sendJson(res, 503, { error: 'workspace_storage_not_configured' });
        return true;
      }
      let agentId;
      try { agentId = decodeURIComponent(agentMatch[1]); } catch { throw new WorkspaceError('invalid_agent_id', 400); }
      const bootstrap = await workspaceService.updateAgent({ userId: user.id, agentId, input: body });
      sendJson(res, 200, { saved: true, ...bootstrap });
      return true;
    }
    if (url.pathname === '/api/settings/password') {
      if (config.authProvider !== 'workos' || !workosAuth) {
        sendJson(res, 503, { error: 'auth_provider_not_configured' });
        return true;
      }
      const identity = await authService.getWorkOSIdentity({ userId: user.id });
      const result = await workosAuth.changePassword({
        ...body,
        userId: identity.providerSubject,
        email: user.email,
        ...metadata,
      });
      sendJson(res, 200, result);
      return true;
    }
    if (url.pathname === '/api/settings/email-change/start') {
      if (config.authProvider !== 'workos' || !workosAuth) {
        sendJson(res, 503, { error: 'auth_provider_not_configured' });
        return true;
      }
      const identity = await authService.getWorkOSIdentity({ userId: user.id });
      await workosAuth.reauthenticatePassword({
        userId: identity.providerSubject,
        email: user.email,
        currentPassword: body.currentPassword,
        ...metadata,
      });
      const pending = await authService.reservePendingEmailChange({
        userId: user.id,
        newEmail: body.newEmail,
        sessionToken,
      });
      try {
        await authService.reserveWorkOSCodeRequest({ email: pending.newEmail });
        const delivery = await workosAuth.sendEmailChangeCode({
          userId: identity.providerSubject,
          newEmail: pending.newEmail,
        });
        let expiresAt = pending.expiresAt;
        if (delivery?.expiresAt) {
          const adjusted = await authService.setPendingEmailChangeExpiry({
            userId: user.id,
            sessionToken,
            expiresAt: delivery.expiresAt,
          });
          expiresAt = adjusted.expiresAt;
        }
        sendJson(res, 202, { accepted: true, email: pending.newEmail, expiresAt });
      } catch (error) {
        await authService.cancelPendingEmailChange({ userId: user.id, sessionToken }).catch(() => {});
        throw error;
      }
      return true;
    }
    if (url.pathname === '/api/settings/email-change/confirm') {
      if (config.authProvider !== 'workos' || !workosAuth) {
        sendJson(res, 503, { error: 'auth_provider_not_configured' });
        return true;
      }
      const pending = await authService.getPendingEmailChange({ userId: user.id, sessionToken });
      if (!pending) throw new AuthError('invalid_email_change_code', 400);
      const identity = await authService.getWorkOSIdentity({ userId: user.id });
      let confirmed;
      try {
        confirmed = await workosAuth.confirmEmailChange({
          userId: identity.providerSubject,
          code: body.code,
          expectedEmail: pending.newEmail,
        });
      } catch (error) {
        if (error instanceof AuthError && error.code === 'invalid_email_change_code') {
          await authService.recordPendingEmailChangeFailure({ userId: user.id, sessionToken }).catch(() => {});
        }
        throw error;
      }
      if (confirmed?.user?.id !== identity.providerSubject
          || String(confirmed?.user?.email || '').trim().toLowerCase() !== pending.newEmail
          || confirmed?.user?.emailVerified !== true) {
        throw new AuthError('email_change_confirmation_failed', 502);
      }
      const updatedUser = await authService.completePendingEmailChange({
        userId: user.id,
        providerSubject: identity.providerSubject,
        newEmail: pending.newEmail,
        sessionToken,
      });
      sendJson(res, 200, { emailChanged: true, user: updatedUser });
      return true;
    }

    sendJson(res, 404, { error: 'settings_route_not_found' });
    return true;
  } catch (error) {
    if (error instanceof AuthError || error instanceof WorkspaceError || error instanceof RequestError) {
      sendJson(res, error.status, { error: error.code });
    } else {
      console.error('Settings request failed:', error?.name || 'Error');
      sendJson(res, 500, { error: 'settings_request_failed' });
    }
    return true;
  }
}

async function handleProductDiscoveryRequest(req, res, url, {
  config,
  authService,
  workspaceService,
  channel3Client,
  db,
}) {
  if (url.pathname !== '/api/products/search' && url.pathname !== '/api/products/offers') {
    sendJson(res, 404, { error: 'product_route_not_found' });
    return true;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  if (!authService) {
    sendJson(res, 503, { error: 'auth_storage_not_configured' });
    return true;
  }

  const sessionToken = cookieValue(req, sessionCookieName(config));
  let user = null;
  try {
    user = sessionToken ? await authService.getSession({ token: sessionToken }) : null;
  } catch {
    user = null;
  }

  if (!user) {
    sendJson(res, 401, { error: 'authentication_required' });
    return true;
  }

  let workspaceId = null;
  let agentId = null;
  if (workspaceService) {
    try {
      const bootstrap = await workspaceService.getBootstrap({ userId: user.id });
      workspaceId = bootstrap?.workspace?.id || null;
      agentId = bootstrap?.agents?.[0]?.id || null;
    } catch {}
  }

  if (url.pathname === '/api/products/offers') {
    const runId = (url.searchParams.get('runId') || '').trim();
    if (!runId) {
      sendJson(res, 400, { error: 'run_id_required' });
      return true;
    }
    if (!db || !workspaceId) {
      sendJson(res, 503, { error: 'database_not_configured' });
      return true;
    }
    try {
      const offers = await getProductOffersForRun({ db, workspaceId, runId });
      sendJson(res, 200, { ok: true, runId, count: offers.length, offers });
      return true;
    } catch (err) {
      console.error('Product offers query failed:', err?.message || err);
      sendJson(res, 500, { error: 'product_offers_query_failed' });
      return true;
    }
  }

  const query = (url.searchParams.get('q') || '').trim();
  if (!query) {
    sendJson(res, 400, { error: 'query_required', message: 'Query parameter q is required' });
    return true;
  }

  const limitRaw = parseInt(url.searchParams.get('limit') || '10', 10);
  const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 10, 50));

  const filters = {};
  const minPrice = parseFloat(url.searchParams.get('minPrice') || url.searchParams.get('min_price') || '');
  if (Number.isFinite(minPrice) && minPrice >= 0) filters.min_price = minPrice;
  const maxPrice = parseFloat(url.searchParams.get('maxPrice') || url.searchParams.get('max_price') || '');
  if (Number.isFinite(maxPrice) && maxPrice > 0) filters.max_price = maxPrice;
  const availability = (url.searchParams.get('availability') || '').trim().toLowerCase();
  if (availability) filters.availability = availability;
  const sortBy = (url.searchParams.get('sortBy') || url.searchParams.get('sort_by') || '').trim().toLowerCase();
  if (sortBy) filters.sort_by = sortBy;
  const merchantDomain = (url.searchParams.get('merchantDomain') || url.searchParams.get('merchant_domain') || '').trim().toLowerCase();
  if (merchantDomain) filters.merchant_domain = merchantDomain;

  try {
    const result = await discoverProducts({
      channel3Client: channel3Client || createChannel3Client({ apiKey: '' }),
      query,
      limit,
      filters,
      db,
      workspaceId,
      userId: user.id,
      agentId,
      allowFixtureFallback: !channel3Client?.isConfigured?.(),
    });

    sendJson(res, 200, {
      ok: true,
      query: result.query,
      count: result.count,
      filters,
      products: result.products,
      isLive: result.isLive,
      source: result.source,
      notice: result.notice || null,
      runId: result.runId || null,
    });
    return true;
  } catch (err) {
    if (err instanceof Channel3Error) {
      sendJson(res, err.status, { error: err.code, message: err.message });
      return true;
    }
    console.error('Product discovery error:', err?.message || err);
    sendJson(res, 500, { error: 'product_discovery_failed' });
    return true;
  }
}

async function handleCommerceRequest(req, res, url, {
  config,
  authService,
  workspaceService,
  channel3Client = null,
  db,
}) {
  if (!url.pathname.startsWith('/api/commerce/')) return false;

  if (!authService) {
    sendJson(res, 503, { error: 'auth_storage_not_configured' });
    return true;
  }

  const sessionToken = cookieValue(req, sessionCookieName(config));
  let user = null;
  try {
    user = sessionToken ? await authService.getSession({ token: sessionToken }) : null;
  } catch {
    user = null;
  }
  if (!user) {
    sendJson(res, 401, { error: 'authentication_required' });
    return true;
  }

  const bootstrap = await workspaceService?.getBootstrap?.({ userId: user.id });
  const workspaceId = bootstrap?.workspace?.id;
  if (!workspaceId || !db) {
    sendJson(res, 503, { error: 'workspace_database_unavailable' });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/mandates') {
    let body;
    try { body = await readJsonBody(req, 16384); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    const agentId = body.agentId ? String(body.agentId).trim() : null;
    try {
      const mandateResult = await createPurchaseMandate({
        db,
        workspaceId,
        userId: user.id,
        agentId,
        offerId: body.offerId,
        product: body.product,
        items: body.items,
      });
      sendJson(res, mandateResult.allowed ? 201 : 403, { ok: mandateResult.allowed, mandate: mandateResult });
      return true;
    } catch (err) {
      if (err instanceof MandatePolicyError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'mandate_creation_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/commerce/mandates/') && !url.pathname.includes('/passkey-challenge')) {
    const mandateId = url.pathname.slice('/api/commerce/mandates/'.length).trim();
    if (!mandateId) {
      sendJson(res, 400, { error: 'mandate_id_required' });
      return true;
    }
    const mandate = await getMandateDetails({ db, workspaceId, mandateId });
    if (!mandate) {
      sendJson(res, 404, { error: 'mandate_not_found' });
      return true;
    }
    sendJson(res, 200, { ok: true, mandate });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/evaluate') {
    let body;
    try { body = await readJsonBody(req, 4096); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    const amountMinor = Number(body.amountMinor);
    const merchantDomain = String(body.merchantDomain || '').trim();
    const agentId = body.agentId ? String(body.agentId).trim() : null;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !merchantDomain) {
      sendJson(res, 400, { error: 'amount_and_domain_required' });
      return true;
    }

    try {
      const evaluation = await evaluateSpendPolicy({
        db,
        workspaceId,
        agentId,
        amountMinor,
        merchantDomain,
        currency: body.currency || 'USD',
      });
      sendJson(res, 200, { ok: true, evaluation });
      return true;
    } catch (err) {
      sendJson(res, 400, { error: 'policy_evaluation_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/paypal/authorize') {
    let body;
    try { body = await readJsonBody(req, 4096); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    const mandateId = body.mandateId ? String(body.mandateId).trim() : null;
    if (!mandateId) {
      sendJson(res, 400, { error: 'mandate_id_required' });
      return true;
    }

    try {
      const transaction = await createSandboxPaymentAuthorization({
        db,
        workspaceId,
        userId: user.id,
        mandateId,
        testPayeeEmail: body.testPayeeEmail || null,
        vaultId: body.vaultId || null,
        simulate: Boolean(body.simulate),
      });
      sendJson(res, 201, { ok: true, transaction });
      return true;
    } catch (err) {
      if (err instanceof PayPalSandboxError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'paypal_authorization_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/paypal/void') {
    let body;
    try { body = await readJsonBody(req, 4096); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    const mandateId = body.mandateId ? String(body.mandateId).trim() : null;
    const transactionId = body.transactionId ? String(body.transactionId).trim() : null;
    const authorizationId = body.authorizationId ? String(body.authorizationId).trim() : null;
    if (!mandateId && !transactionId && !authorizationId) {
      sendJson(res, 400, { error: 'mandate_or_transaction_id_required' });
      return true;
    }

    try {
      let result;
      if (mandateId) {
        result = await voidCheckoutMandate({
          db,
          workspaceId,
          userId: user.id,
          mandateId,
          reason: body.reason,
        });
      } else {
        result = await voidSandboxPaymentAuthorization({
          db,
          workspaceId,
          userId: user.id,
          mandateId,
          transactionId,
          authorizationId,
          reason: body.reason,
          simulate: Boolean(body.simulate),
        });
      }
      sendJson(res, 200, { ok: true, transaction: result });
      return true;
    } catch (err) {
      if (err instanceof PayPalSandboxError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'paypal_void_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/commerce/checkout/executions/')) {
    const mandateId = url.pathname.replace('/api/commerce/checkout/executions/', '').trim();
    if (!mandateId) {
      sendJson(res, 400, { error: 'mandate_id_required' });
      return true;
    }
    const execution = await getCheckoutExecution({ db, workspaceId, mandateId });
    if (!execution) {
      sendJson(res, 404, { error: 'checkout_execution_not_found' });
      return true;
    }
    sendJson(res, 200, { ok: true, execution });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/paypal/capture') {
    let body;
    try { body = await readJsonBody(req, 4096); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    const mandateId = body.mandateId ? String(body.mandateId).trim() : null;
    const transactionId = body.transactionId ? String(body.transactionId).trim() : null;
    if (!mandateId && !transactionId) {
      sendJson(res, 400, { error: 'mandate_or_transaction_id_required' });
      return true;
    }

    try {
      const result = await captureSandboxPaymentAuthorization({
        db,
        workspaceId,
        userId: user.id,
        mandateId,
        transactionId,
        note: body.note,
        simulate: Boolean(body.simulate),
      });
      sendJson(res, 200, { ok: true, transaction: result });
      return true;
    } catch (err) {
      if (err instanceof PayPalSandboxError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'paypal_capture_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/paypal/refund') {
    let body;
    try { body = await readJsonBody(req, 4096); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    const mandateId = body.mandateId ? String(body.mandateId).trim() : null;
    const transactionId = body.transactionId ? String(body.transactionId).trim() : null;
    const captureId = body.captureId ? String(body.captureId).trim() : null;
    if (!mandateId && !transactionId && !captureId) {
      sendJson(res, 400, { error: 'mandate_transaction_or_capture_id_required' });
      return true;
    }

    try {
      const result = await refundSandboxPaymentCapture({
        db,
        workspaceId,
        mandateId,
        transactionId,
        captureId,
        amountValue: body.amountValue ? String(body.amountValue) : null,
        currencyCode: body.currencyCode ? String(body.currencyCode).toUpperCase() : null,
        note: body.note ? String(body.note) : undefined,
        simulate: Boolean(body.simulate),
      });
      sendJson(res, 200, { ok: true, refund: result });
      return true;
    } catch (err) {
      if (err instanceof PayPalSandboxError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'paypal_refund_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/commerce/receipts/')) {
    const identifier = url.pathname.slice('/api/commerce/receipts/'.length).trim();
    if (!identifier) {
      sendJson(res, 400, { error: 'receipt_identifier_required' });
      return true;
    }

    const receiptRow = await withReadTransaction(db, async (tx) => {
      const res = await tx.execute({
        sql: `SELECT id, workspace_id, run_id, mandate_id, status, receipt_hash, receipt_json, created_at
              FROM receipts
              WHERE workspace_id = ? AND (id = ? OR run_id = ? OR mandate_id = ?)`,
        args: [workspaceId, identifier, identifier, identifier],
      });
      return res.rows[0] || null;
    });

    if (!receiptRow) {
      sendJson(res, 404, { error: 'receipt_not_found' });
      return true;
    }

    let payload = null;
    try { payload = JSON.parse(receiptRow.receipt_json); } catch {}

    sendJson(res, 200, {
      ok: true,
      receipt: {
        id: receiptRow.id,
        workspaceId: receiptRow.workspace_id,
        runId: receiptRow.run_id,
        mandateId: receiptRow.mandate_id,
        status: receiptRow.status,
        receiptHash: receiptRow.receipt_hash,
        createdAt: receiptRow.created_at,
        data: payload,
      },
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/skills/export') {
    let body;
    try { body = await readJsonBody(req, 16384); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    try {
      const compiled = compileRunToSkill({
        skillName: body.skillName || 'Kues Autonomous Procurement',
        description: body.description || 'Verified spending policy with transaction-bound WebAuthn passkey approval and PayPal Sandbox holds',
        maxPerOrderCents: Number.isSafeInteger(body.maxPerOrderCents) ? body.maxPerOrderCents : 15000,
        currency: body.currency || 'USD',
        allowedDomains: Array.isArray(body.allowedDomains) && body.allowedDomains.length ? body.allowedDomains : ['channel3.example.com', 'bestbuy.com'],
        steps: Array.isArray(body.steps) && body.steps.length ? body.steps : [
          { surface: 'Channel3 Search', instruction: 'Discover verified merchant offers matching user constraints' },
          { surface: 'Spend Policy', instruction: 'Validate order price against per-order and daily budget ceilings' },
          { surface: 'PayPal Sandbox', instruction: 'Stage AUTHORIZE intent hold without automated capture' },
          { surface: 'WebAuthn Passkey', instruction: 'Prompt user for cryptographic biometric assertion over mandate challenge hash' },
          { surface: 'Flight Recorder', instruction: 'Record immutable audit receipt hash and allow safe void or refund' },
        ],
      });
      sendJson(res, 200, { ok: true, skill: compiled });
      return true;
    } catch (err) {
      sendJson(res, 400, { error: 'skill_compilation_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/commerce/paypal/transactions/')) {
    const mandateId = url.pathname.slice('/api/commerce/paypal/transactions/'.length).trim();
    if (!mandateId) {
      sendJson(res, 400, { error: 'mandate_id_required' });
      return true;
    }
    const txInfo = await getSandboxPaymentTransaction({ db, workspaceId, mandateId });
    if (!txInfo) {
      sendJson(res, 404, { error: 'transaction_not_found' });
      return true;
    }
    sendJson(res, 200, { ok: true, transaction: txInfo });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/commerce/paypal/wallet') {
    const wallet = await getWorkspaceWallet({ db, workspaceId });
    if (!wallet) {
      sendJson(res, 200, { ok: true, linked: false, wallet: null });
      return true;
    }
    sendJson(res, 200, { ok: true, linked: true, wallet });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/paypal/wallet/setup-token') {
    let body = {};
    try { body = await readJsonBody(req, 4096); } catch {}
    try {
      const result = await createWalletSetupToken({
        workspaceId,
        userId: user.id,
        returnUrl: body.returnUrl,
        cancelUrl: body.cancelUrl,
        simulate: Boolean(body.simulate),
      });
      sendJson(res, 201, { ok: true, ...result });
      return true;
    } catch (err) {
      if (err instanceof PayPalSandboxError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'setup_token_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/paypal/wallet/link') {
    let body;
    try { body = await readJsonBody(req, 4096); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    try {
      const wallet = await linkWorkspaceWallet({
        db,
        workspaceId,
        userId: user.id,
        setupTokenId: body.setupTokenId,
        vaultTokenId: body.vaultTokenId,
        payerEmail: body.payerEmail,
        payerId: body.payerId,
        simulate: Boolean(body.simulate),
      });
      sendJson(res, 200, { ok: true, wallet });
      return true;
    } catch (err) {
      if (err instanceof PayPalSandboxError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'wallet_link_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/paypal/wallet/unlink') {
    try {
      const result = await unlinkWorkspaceWallet({ db, workspaceId, userId: user.id });
      sendJson(res, 200, { ok: true, ...result });
      return true;
    } catch (err) {
      if (err instanceof PayPalSandboxError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'wallet_unlink_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/commerce/passkeys') {
    const passkeys = await listUserPasskeys({ db, userId: user.id });
    sendJson(res, 200, { ok: true, passkeys });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/passkeys/register/options') {
    try {
      const options = await createPasskeyRegistrationOptions({
        db,
        userId: user.id,
        userEmail: user.email_normalized,
        rpId: req.headers.host ? req.headers.host.split(':')[0] : 'localhost',
        rpName: 'Keus Desktop',
      });
      sendJson(res, 200, { ok: true, options });
      return true;
    } catch (err) {
      sendJson(res, 500, { error: 'passkey_options_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/commerce/passkeys/register/verify') {
    let body;
    try { body = await readJsonBody(req, 8192); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    try {
      const result = await verifyAndSavePasskeyRegistration({
        db,
        userId: user.id,
        credential: body.credential,
        rpId: req.headers.host ? req.headers.host.split(':')[0] : 'localhost',
      });
      sendJson(res, 201, { ok: true, ...result });
      return true;
    } catch (err) {
      if (err instanceof PasskeyError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'passkey_registration_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/commerce/passkeys/')) {
    const credentialId = url.pathname.replace('/api/commerce/passkeys/', '').trim();
    if (!credentialId) {
      sendJson(res, 400, { error: 'credential_id_required' });
      return true;
    }
    try {
      const result = await revokePasskey({ db, userId: user.id, credentialId });
      sendJson(res, 200, { ok: true, ...result });
      return true;
    } catch (err) {
      if (err instanceof PasskeyError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'passkey_revocation_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname.includes('/passkey-challenge')) {
    const parts = url.pathname.split('/');
    const mandateId = parts[parts.indexOf('mandates') + 1];
    if (!mandateId) {
      sendJson(res, 400, { error: 'mandate_id_required' });
      return true;
    }
    try {
      const challenge = await getMandatePasskeyChallenge({
        db,
        workspaceId,
        mandateId,
        userId: user.id,
      });
      sendJson(res, 200, { ok: true, ...challenge });
      return true;
    } catch (err) {
      if (err instanceof PasskeyError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'passkey_challenge_failed', message: err.message });
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname.includes('/passkey-approve')) {
    const parts = url.pathname.split('/');
    const mandateId = parts[parts.indexOf('mandates') + 1];
    if (!mandateId) {
      sendJson(res, 400, { error: 'mandate_id_required' });
      return true;
    }
    let body;
    try { body = await readJsonBody(req, 8192); }
    catch { sendJson(res, 400, { error: 'invalid_json_body' }); return true; }

    try {
      const passkeyResult = await verifyMandatePasskeyApproval({
        db,
        workspaceId,
        mandateId,
        userId: user.id,
        credentialId: body.credentialId,
        signature: body.signature,
        authenticatorData: body.authenticatorData,
        clientDataJSON: body.clientDataJSON,
        simulate: Boolean(body.simulate),
      });

      const checkoutExecution = await executeCheckoutMandate({
        db,
        workspaceId,
        userId: user.id,
        mandateId,
        channel3Client,
      });

      sendJson(res, 200, {
        ok: true,
        verified: true,
        passkey: passkeyResult,
        execution: checkoutExecution,
        paymentHold: checkoutExecution.paypalHold,
      });
      return true;
    } catch (err) {
      if (err instanceof PasskeyError) {
        sendJson(res, err.statusCode, { error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'passkey_approval_failed', message: err.message });
      return true;
    }
  }

  sendJson(res, 404, { error: 'commerce_route_not_found' });
  return true;
}

export function createServer({
  config = loadServerConfig(),
  authService = null,
  workspaceService = null,
  workosAuth = null,
  apiHubService = null,
  aiProviderService = null,
  aiChatService = null,
  aiChatHistoryService = null,
  audioTranscriptionService = null,
  webResearchService = null,
  fileToolsService = null,
  workspaceLibraryService = null,
  executionJobsService = null,
  usageService = null,
  channel3Client = null,
  db = null,
  signInOnlyPreview = false,
} = {}) {
  const activeChannel3Client = channel3Client || (config.channel3Configured
    ? createChannel3Client({ apiKey: process.env.CHANNEL3_API_KEY })
    : createChannel3Client({ apiKey: '' }));
  const runtime = {
    config,
    workosAuth,
  };
  const filesService = fileToolsService || createFileTools();
  const getFileScope = async (req, agentId) => {
      const token = cookieValue(req, sessionCookieName(runtime.config));
      const user = token && authService ? await authService.getSession({ token }) : null;
      if (!user) throw new FileToolError('authentication_required', 401);
      if (runtime.config.aiProviderChatTestEnabled !== true || !aiProviderAdminAllowed(runtime.config, user)) throw new FileToolError('file_admin_required', 403);
      if (!workspaceService) throw new FileToolError('file_service_unavailable', 503);
      const bootstrap = await workspaceService.getBootstrap({ userId: user.id });
      const agent = bootstrap.agents?.find(item => item.id === agentId && item.status !== 'archived');
      if (!agent || bootstrap.workspace?.status !== 'active') throw new FileToolError('file_agent_unavailable', 404);
      return { userId: user.id, workspaceId: bootstrap.workspace.id, agent };
    };
  const fileOrigin = req => { const origin = requestOrigin(req); return origin.present && origin.valid && origin.sameOrigin; };
  const fileRoutes = createFileRoutes({service: filesService, sameOrigin: fileOrigin, getScope: getFileScope});
  let libraryService = workspaceLibraryService;
  if (!libraryService) { try { libraryService = workspaceLibraryFromEnv(); } catch { console.error('Workspace storage configuration invalid; library disabled.'); libraryService = workspaceLibraryFromEnv({}); } }
  const workspaceFileRoutes = createWorkspaceFileRoutes({library: libraryService, files: filesService, sameOrigin: fileOrigin, getScope: getFileScope, executionReady:()=>jobsService?.configured===true});
  let jobsService=executionJobsService;
  if(!jobsService && process.env.WORKSPACE_EXECUTION_ENABLED==='1' && process.env.FREESTYLE_FREE_PLAN_CONFIRMED==='1' && process.env.EXECUTION_IMAGE_VERIFIED==='1' && process.env.FREESTYLE_SNAPSHOT_ID && process.env.FREESTYLE_API_KEY && db && libraryService.configured) {
    try { jobsService=createExecutionJobs({db,library:libraryService,client:new Freestyle({apiKey:process.env.FREESTYLE_API_KEY,fetch:(url,init={})=>fetch(url,{...init,signal:AbortSignal.any([AbortSignal.timeout(30000),...(init.signal?[init.signal]:[])])})}),apiKey:process.env.FREESTYLE_API_KEY,snapshotId:process.env.FREESTYLE_SNAPSHOT_ID,encryptionKey:process.env.EXECUTION_ENCRYPTION_KEY,
      resolveScope:async scope=>{const b=await workspaceService.getBootstrap({userId:scope.userId});const agent=b.agents?.find(a=>a.id===scope.agent.id&&a.status!=='archived');if(!agent||b.workspace?.status!=='active'||b.workspace.id!==scope.workspaceId||!aiProviderAdminAllowed(config,b.user||{}))return null;return{...scope,agent}}
    }); } catch { console.error('Execution configuration invalid; code jobs disabled.'); }
  }
  const executionRoutes=createExecutionRoutes({service:jobsService,getScope:getFileScope,sameOrigin:fileOrigin});
  const researchService = config.webResearchEnabled ? (webResearchService || createWebResearch({ enabled: true, apiKey: process.env.TAVILY_API_KEY || '' })) : createWebResearch();
  const audioRoutes = createAudioRoutes({
    getUser: async req => {
      const token = cookieValue(req, sessionCookieName(runtime.config));
      return token && authService ? authService.getSession({ token }) : null;
    },
    isAllowed: user => runtime.config.aiProviderChatTestEnabled === true && aiProviderAdminAllowed(runtime.config, user),
    sameOrigin: req => { const origin = requestOrigin(req); return origin.present && origin.valid && origin.sameOrigin; },
    service: config.groqTranscriptionEnabled ? (audioTranscriptionService || createGroqTranscription({ apiKey: process.env.GROQ_TRANSCRIPTION_API_KEY || '', model: config.groqTranscriptionModel })) : null,
  });
  const aiChatRateWindows = new Map();
  const aiChatPendingToolApprovals = new Map();

  const server = http.createServer((req, res) => {
    void (async () => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

      let url;
      try {
        url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      } catch {
        sendJson(res, 400, { error: 'invalid_request_url' });
        return;
      }

      const legacyBrandTarget = LEGACY_BRAND_REDIRECTS.get(url.pathname);
      if (legacyBrandTarget && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(308, { Location: legacyBrandTarget, 'Cache-Control': 'public, max-age=86400' });
        res.end();
        return;
      }

      const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      const activeConfig = runtime.config;
      const activeWorkosAuth = runtime.workosAuth;
      if (req.method === 'OPTIONS') {
        if (!applyAllowedCors(req, res, activeConfig)) {
          sendJson(res, 403, { error: 'origin_not_allowed' });
          return;
        }
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (isApi && !applyAllowedCors(req, res, activeConfig)) {
        sendJson(res, 403, { error: 'origin_not_allowed' });
        return;
      }

      if (url.pathname === '/auth/start' && req.method === 'GET') {
        if (!activeConfig.workosConfigured || !activeWorkosAuth) {
          redirect(res, '/login?auth_error=not_configured');
          return;
        }
        const provider = url.searchParams.get('provider') || '';
        const intent = url.searchParams.get('intent') || 'sign-in';
        if (!['sign-in', 'sign-up'].includes(intent)) {
          redirect(res, '/login?auth_error=invalid_request');
          return;
        }
        const socialProviderEnabled = provider === 'GoogleOAuth'
          ? activeConfig.workosGoogleOAuthEnabled === true && !signInOnlyPreview
          : provider === 'GitHubOAuth'
            ? activeConfig.workosGithubOAuthEnabled === true && !signInOnlyPreview
            : false;
        if (!socialProviderEnabled) {
          redirect(res, '/login?auth_error=provider_disabled');
          return;
        }
        const state = crypto.randomBytes(32).toString('base64url');
        try {
          const authorizationUrl = await activeWorkosAuth.getAuthorizationUrl({ state, provider });
          redirect(res, authorizationUrl, setWorkOSStateCookie(activeConfig, state));
        } catch (error) {
          console.error('WorkOS sign-in start failed:', error?.name || 'Error');
          redirect(res, '/login?auth_error=unavailable');
        }
        return;
      }

      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        const stateCookie = cookieValue(req, WORKOS_STATE_COOKIE);
        const returnedState = url.searchParams.get('state');
        if (!sameState(stateCookie, returnedState)) {
          redirect(res, '/login?auth_error=state', clearWorkOSStateCookie(activeConfig));
          return;
        }
        if (!activeConfig.workosConfigured || !activeWorkosAuth || url.searchParams.has('error')) {
          redirect(res, '/login?auth_error=provider', clearWorkOSStateCookie(activeConfig));
          return;
        }
        try {
          const result = await activeWorkosAuth.completeLogin({
            code: url.searchParams.get('code'),
            ipAddress: req.socket.remoteAddress,
            userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
          });
          res.writeHead(302, {
            Location: result.needsOnboarding === true || result.isNewUser === true ? '/onboarding' : '/app',
            'Cache-Control': 'no-store',
            'Set-Cookie': [clearWorkOSStateCookie(activeConfig), clearPendingAuthCookie(activeConfig), setSessionCookie(activeConfig, result.sessionToken)],
          });
          res.end();
        } catch (error) {
          console.error('WorkOS sign-in callback failed:', error?.name || 'Error');
          redirect(res, '/login?auth_error=signin_failed', clearWorkOSStateCookie(activeConfig));
        }
        return;
      }

      if (url.pathname === '/api/health') {
        if (!['GET', 'HEAD'].includes(req.method)) {
          res.setHeader('Allow', 'GET, HEAD, OPTIONS');
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const payload = {
          ok: true,
          service: 'keus-web',
          version: '2.4.0',
          surfaces: ['marketing:/', 'dashboard:/app', 'desktop-preview:/desktop-preview', 'onboarding:/onboarding'],
        };
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end();
        } else sendJson(res, 200, payload);
        return;
      }

      if (url.pathname.startsWith('/api/settings/')) {
        const handled = await handleSettingsRequest(req, res, url, {
          config: activeConfig,
          authService,
          workspaceService,
          workosAuth: activeWorkosAuth,
        });
        if (handled) return;
      }

      if (url.pathname.startsWith('/api/execution/')) { await executionRoutes(req,res,url); return; }
      if (url.pathname.startsWith('/api/workspace-files/')) { await workspaceFileRoutes(req, res, url); return; }
      if (url.pathname.startsWith('/api/files/')) { await fileRoutes(req, res, url); return; }
      if (url.pathname.startsWith('/api/audio/')) { await audioRoutes(req, res, url); return; }

      if (url.pathname.startsWith('/api/workspace/') || url.pathname.startsWith('/api/onboarding/')) {
        const handled = await handleWorkspaceRequest(req, res, url, {
          config: activeConfig,
          authService,
          workspaceService,
        });
        if (handled) return;
      }

      if (url.pathname.startsWith('/api/products/')) {
        const handled = await handleProductDiscoveryRequest(req, res, url, {
          config: activeConfig,
          authService,
          workspaceService,
          channel3Client: activeChannel3Client,
          db,
        });
        if (handled) return;
      }

      if (url.pathname.startsWith('/api/commerce/')) {
        const handled = await handleCommerceRequest(req, res, url, {
          config: activeConfig,
          authService,
          workspaceService,
          channel3Client: activeChannel3Client,
          db,
        });
        if (handled) return;
      }

      if (url.pathname === '/api/chat' || url.pathname === '/api/chat/status' || url.pathname === '/api/chat/history' || url.pathname === '/api/chat/models' || url.pathname === '/api/chat/tool-approval') {
        await handleDesktopAiChatRequest(req, res, url, {
          config: activeConfig,
          authService,
          workspaceService,
          aiChatService,
          aiChatHistoryService,
          aiProviderService,
          usageService,
          rateWindows: aiChatRateWindows,
          pendingToolApprovals: aiChatPendingToolApprovals,
          researchService,
          filesService,
          channel3Client: activeChannel3Client,
          db,
        });
        return;
      }

      if (url.pathname === '/api/admin/ai-providers' || url.pathname.startsWith('/api/admin/ai-providers/')) {
        await handleAiProviderAdminRequest(req, res, url, {
          config: activeConfig,
          authService,
          aiProviderService,
        });
        return;
      }

      if (url.pathname.startsWith('/api/hub/')) {
        await handleApiHubRequest(req, res, url, {
          config: activeConfig,
          authService,
          apiHubService,
        });
        return;
      }

      if (url.pathname.startsWith('/api/auth/')) {
        try {
          const handled = await handleAuthRequest(req, res, url, activeConfig, authService, activeWorkosAuth, {
            googleEnabled: activeConfig.workosConfigured && activeConfig.workosGoogleOAuthEnabled === true && !signInOnlyPreview,
            githubEnabled: activeConfig.workosConfigured && activeConfig.workosGithubOAuthEnabled === true && !signInOnlyPreview,
          }, workspaceService, db);
          if (handled) return;
        } catch (error) {
          const status = error instanceof AuthError || error instanceof RequestError ? error.status : 500;
          const code = error instanceof AuthError || error instanceof RequestError ? error.code : 'auth_request_failed';
          if (status >= 500 && !(error instanceof AuthError)) console.error('Auth request failed:', error.message);
          sendJson(res, status, { error: code });
          return;
        }
      }

      if (isApi) {
        sendJson(res, 404, { error: 'api_route_not_found' });
        return;
      }

      if (url.pathname === '/auth/verify' && activeConfig.authProvider === 'workos') {
        redirect(res, '/login');
        return;
      }

      if (signInOnlyPreview && !['/', '/login', '/app', '/dashboard', '/desktop-preview', '/desktop', '/desktop.html', '/onboarding', '/keus-icon.svg', '/keus-logo.svg'].includes(url.pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Not found in sign-in preview');
        return;
      }

      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD, OPTIONS');
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed');
        return;
      }

      if (url.pathname === '/api-hub') {
        if (!['GET', 'HEAD'].includes(req.method)) {
          res.setHeader('Allow', 'GET, HEAD');
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('Method not allowed');
          return;
        }
        if (!activeConfig.apiHubEnabled || !apiHubService) {
          sendJson(res, 404, { error: 'api_hub_not_configured' });
          return;
        }
        if (!authService) {
          sendJson(res, 503, { error: 'auth_storage_not_configured' });
          return;
        }
        let adminUser = null;
        try {
          const token = cookieValue(req, sessionCookieName(activeConfig));
          adminUser = token ? await authService.getSession({ token }) : null;
        } catch {
          adminUser = null;
        }
        if (!adminUser) {
          redirect(res, '/login?auth_error=session');
          return;
        }
        const allowedAdmins = Array.isArray(activeConfig.apiHubAdminEmails) ? activeConfig.apiHubAdminEmails : [];
        if (!allowedAdmins.includes(String(adminUser.email || '').trim().normalize('NFKC').toLowerCase())) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('API Hub administrator access required');
          return;
        }
        try {
          const html = readHtml(apiHubHtmlPath);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Pragma': 'no-cache',
            'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 
          });
          res.end(req.method === 'HEAD' ? undefined : html);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('API Hub page unavailable');
        }
        return;
      }

      if (url.pathname === '/admin/ai-providers') {
        if (!activeConfig.aiProvidersEnabled || !aiProviderService) {
          res.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
          });
          res.end('AI provider administration is not configured');
          return;
        }
        if (!authService) {
          sendJson(res, 503, { error: 'auth_storage_not_configured' });
          return;
        }
        let adminUser = null;
        try {
          const token = cookieValue(req, sessionCookieName(activeConfig));
          adminUser = token ? await authService.getSession({ token }) : null;
        } catch {
          adminUser = null;
        }
        if (!adminUser) {
          redirect(res, '/login?auth_error=session');
          return;
        }
        const allowedAdmins = Array.isArray(activeConfig.aiProviderAdminEmails)
          ? activeConfig.aiProviderAdminEmails : [];
        if (!allowedAdmins.includes(String(adminUser.email || '').trim().normalize('NFKC').toLowerCase())) {
          res.writeHead(403, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
          });
          res.end('AI provider administrator access required');
          return;
        }
        try {
          const html = readHtml(aiProviderAdminHtmlPath);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Pragma': 'no-cache',
            'X-Robots-Tag': 'noindex, nofollow',
            'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          });
          res.end(req.method === 'HEAD' ? undefined : html);
        } catch {
          res.writeHead(500, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end('AI provider admin page unavailable');
        }
        return;
      }

      if (activeConfig.nodeEnv === 'production' && PROTECTED_AUTH_PATHS.has(url.pathname)) {
        if (!authService) {
          sendJson(res, 503, { error: 'auth_storage_not_configured' });
          return;
        }
        const token = cookieValue(req, sessionCookieName(activeConfig));
        let user = null;
        try { user = token ? await authService.getSession({ token }) : null; }
        catch { user = null; }
        if (!user) {
          redirect(res, '/login?auth_error=session');
          return;
        }
      }

      if (url.pathname === '/desktop' || url.pathname === '/desktop.html') {
        redirect(res, '/app');
        return;
      }

      const staticAsset = STATIC_ASSETS.get(url.pathname);
      if (staticAsset) {
        try {
          const body = fs.readFileSync(path.join(publicDir, staticAsset[0]));
          res.writeHead(200, { 'Content-Type': staticAsset[1], 'Content-Length': body.length, 'Cache-Control': url.pathname.endsWith('.mjs') ? 'no-cache' : 'public, max-age=3600' });
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('Not found');
        }
        return;
      }

      const pageRoutes = new Map([
        ['/', landingHtmlPath], ['/app', dashboardHtmlPath], ['/dashboard', dashboardHtmlPath], ['/desktop-preview', desktopPreviewHtmlPath],
        ['/onboarding', onboardingHtmlPath], ['/onboarding.html', onboardingHtmlPath], ['/login', loginHtmlPath],
        ['/auth/verify', authVerifyHtmlPath], ['/pocket', pocketHtmlPath], ['/phone', pocketHtmlPath], ['/pocket.html', pocketHtmlPath],
      ]);
      const htmlPath = pageRoutes.get(url.pathname);
      if (!htmlPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Not found');
        return;
      }

      try {
        let html = readHtml(htmlPath);
        if (url.pathname === '/') {
          let signedIn = false;
          const token = cookieValue(req, sessionCookieName(activeConfig));
          if (token && authService) {
            try { signedIn = Boolean(await authService.getSession({ token })); }
            catch { signedIn = false; }
          }
          if (signedIn) {
            html = html
              .replace('id="headerAccountLink" href="/login">Sign in', 'id="headerAccountLink" href="/app">Dashboard')
              .replace('id="footerAccountLink" href="/login">Sign in', 'id="footerAccountLink" href="/app">Dashboard');
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : html);
      } catch (error) {
        console.error('Static page read failed:', error.message);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Page unavailable');
      }
    })().catch((error) => {
      console.error('Unhandled request failure:', error.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_server_error' });
      else res.destroy();
    });
  });
  let recoveryTimer;
  if(jobsService?.configured&&typeof jobsService.recover==='function'){const recover=()=>void jobsService.recover().catch(()=>console.error('Execution recovery deferred.'));server.once('listening',()=>{recover();recoveryTimer=setInterval(recover,30000);recoveryTimer.unref()});server.once('close',()=>clearInterval(recoveryTimer))}
  return server;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const signInOnlyPreview = (process.env.KEUS_SIGNIN_ONLY_PREVIEW === '1' || process.env.KUES_SIGNIN_ONLY_PREVIEW === '1')
    && String(process.env.NODE_ENV || 'development') !== 'production';
  let config;
  try {
    config = loadServerConfig();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }

  if (config) {
    const port = Number(process.env.PORT || 3000);
    let db = null;
    let authService = null;
    let workspaceService = null;
    let workosAuth = null;
    let apiHubService = null;
    let aiProviderService = null;
    let aiChatService = null;
    let aiChatHistoryService = null;
    let usageService = null;
    try {
      if (config.databaseConfigured) {
        db = createDatabaseClient();
        await applyMigrations(db);
        const emailDelivery = config.emailDeliveryConfigured
          ? createBrevoEmailDelivery({
            apiKey: process.env.BREVO_API_KEY,
            senderEmail: process.env.EMAIL_FROM,
            senderName: process.env.EMAIL_FROM_NAME || 'Keus',
            appBaseUrl: process.env.APP_BASE_URL,
          })
          : null;
        authService = createAuthService({ db, emailDelivery, competition: config.competition });
        workspaceService = createWorkspaceService({ db, competition: config.competition });
        if (config.apiHubEnabled) {
          apiHubService = createApiHubService({ db, encryptionKey: process.env.API_HUB_ENCRYPTION_KEY });
        }
        if (config.aiProvidersEnabled) {
          aiProviderService = createAiProviderService({ db, encryptionKey: process.env.AI_PROVIDER_ENCRYPTION_KEY });
        }
        if (config.aiProviderChatTestEnabled && aiProviderService) {
          aiChatService = createAiChatService({ aiProviderService });
          aiChatHistoryService = createAiChatHistoryService({ db, encryptionKey: process.env.AI_PROVIDER_ENCRYPTION_KEY });
          usageService = {
            reserveTokens: (input) => reserveTokens(db, input),
            settleTokenReservation: (input) => settleTokenReservation(db, input),
            releaseTokenReservation: (input) => releaseTokenReservation(db, input),
          };
        }
        if (config.workosConfigured) {
          const workos = new WorkOS({
            apiKey: process.env.WORKOS_API_KEY,
            clientId: process.env.WORKOS_CLIENT_ID,
          });
          workosAuth = createWorkOSAuth({
            workos,
            clientId: process.env.WORKOS_CLIENT_ID,
            redirectUri: config.workosRedirectUri,
            authService,
            apiKey: process.env.WORKOS_API_KEY,
          });
        }
      }
      const channel3Client = config.channel3Configured
        ? createChannel3Client({ apiKey: process.env.CHANNEL3_API_KEY })
        : createChannel3Client({ apiKey: '' });
      const server = createServer({
        config,
        authService,
        workspaceService,
        workosAuth,
        apiHubService,
        aiProviderService,
        aiChatService,
        aiChatHistoryService,
        usageService,
        channel3Client,
        db,
        signInOnlyPreview,
      });
      server.on('close', () => { void db?.close(); });
      server.listen(port, '0.0.0.0', () => {
        console.log(`Keus web server listening on http://0.0.0.0:${port}`);
        if (config.databaseConfigured) {
          console.log('Database schema ready.');
          console.log(config.workosConfigured
            ? 'WorkOS email/password authentication is configured.'
            : config.emailDeliveryConfigured
              ? 'Brevo email delivery adapter configured.'
              : 'No external sign-in provider is configured; sign-in is disabled.');
        }
      });
    } catch (error) {
      console.error(`Keus startup failed: ${error.message}`);
      await db?.close().catch(() => {});
      process.exitCode = 1;
    }
  }
}
