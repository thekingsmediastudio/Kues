import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from './lib/config.mjs';
import { createDatabaseClient } from './lib/db/client.mjs';
import { applyMigrations } from './lib/db/migrate.mjs';
import { AuthError, createAuthService } from './lib/auth/service.mjs';
import { createBrevoEmailDelivery } from './lib/auth/brevo-delivery.mjs';
import { createWorkOSAuth } from './lib/auth/workos-auth.mjs';
import { ApiHubError, createApiHubService } from './lib/api-hub/service.mjs';
import { AiProviderError, createAiProviderService } from './lib/ai-providers/service.mjs';
import { AiChatHistoryError, createAiChatHistoryService } from './lib/ai-providers/history.mjs';
import { AI_CHAT_MAX_OUTPUT_TOKENS, createAiChatService, normalizeAiChatMessages } from './lib/ai-providers/chat.mjs';
import { UsageLimitError, UsageReservationError, reserveTokens, releaseTokenReservation, settleTokenReservation } from './lib/db/usage.mjs';
import { WorkspaceError, createWorkspaceService } from './lib/workspaces/service.mjs';
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
} = {}) {
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

async function handleDesktopAiChatRequest(req, res, url, {
  config,
  authService,
  workspaceService,
  aiChatService,
  aiChatHistoryService,
  usageService,
  rateWindows,
}) {
  const statusRoute = url.pathname === '/api/chat/status';
  const historyRoute = url.pathname === '/api/chat/history';
  const chatRoute = url.pathname === '/api/chat';
  if (!statusRoute && !historyRoute && !chatRoute) return false;

  const expectedMethod = statusRoute || historyRoute ? 'GET' : 'POST';
  if (req.method !== expectedMethod) {
    res.setHeader('Allow', `${expectedMethod}, OPTIONS`);
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  if (chatRoute || (historyRoute && requestOrigin(req).present)) {
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
  if (statusRoute) {
    let available = false;
    if (enabledForAdmin) {
      try { available = await aiChatService.isReady(); } catch { available = false; }
    }
    sendJson(res, 200, { available: available === true });
    return true;
  }

  if (!enabledForAdmin || !workspaceService || !aiChatHistoryService) {
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
      sendJson(res, 200, { messages: history.messages });
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

  if (!usageService
      || typeof usageService.reserveTokens !== 'function'
      || typeof usageService.settleTokenReservation !== 'function'
      || typeof usageService.releaseTokenReservation !== 'function') {
    sendJson(res, 503, { error: 'ai_chat_unavailable' });
    return true;
  }

  const requestId = crypto.randomUUID();
  try {
    consumeAiChatRateLimit(rateWindows, String(user.id || ''));
    const input = await readJsonBody(req, 16 * 1024);
    if (Object.keys(input).some((key) => !['agentId', 'message'].includes(key))) {
      throw new RequestError('ai_chat_request_invalid', 400);
    }
    const agentId = String(input.agentId || '').trim();
    if (!agentId || agentId.length > 255 || /[\r\n\0]/.test(agentId)) {
      throw new RequestError('ai_chat_request_invalid', 400);
    }
    const newUserMessage = normalizeAiChatMessages([{ role: 'user', content: input.message }])[0];
    if (!await aiChatService.isReady()) throw new AiProviderError('ai_provider_primary_unavailable', 503);

    const { workspace, agent } = await loadOwnedAgent(agentId);
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
    const profileCharacters = String(agent.name || '').length + String(agent.role || '').length + 600;
    const estimatedTokens = Math.ceil((messageCharacters + profileCharacters) / 2) + AI_CHAT_MAX_OUTPUT_TOKENS;
    const idempotencyKey = `ai-chat:${crypto.randomUUID()}`;
    await usageService.reserveTokens({
      workspaceId: workspace.id,
      userId: user.id,
      idempotencyKey,
      estimatedTokens,
    });

    let completion;
    try {
      completion = await aiChatService.complete({ agent, messages });
    } catch (error) {
      try { await usageService.releaseTokenReservation({ workspaceId: workspace.id, idempotencyKey }); } catch {}
      throw error;
    }

    try {
      await usageService.settleTokenReservation({
        workspaceId: workspace.id,
        idempotencyKey,
        provider: completion.provider,
        model: completion.model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      });
    } catch (error) {
      console.error('AI chat usage settlement failed:', JSON.stringify({ requestId, error: error?.name || 'Error' }));
      sendJson(res, 503, { error: 'ai_chat_unavailable', requestId });
      return true;
    }

    if (completion.fallbackUsed === true) {
      const fallbackAttempts = Number.isSafeInteger(completion.fallbackAttempts) ? completion.fallbackAttempts : 0;
      console.info('Desktop AI chat used an approved fallback:', JSON.stringify({ requestId, fallbackAttempts }));
    }
    await aiChatHistoryService.appendExchange({
      workspaceId: workspace.id,
      userId: user.id,
      agentId,
      userMessage: newUserMessage.content,
      assistantMessage: completion.text,
    });
    sendJson(res, 200, { reply: completion.text, requestId });
  } catch (error) {
    const safeCode = error instanceof UsageLimitError || error instanceof UsageReservationError
      || error instanceof RequestError || error instanceof AiProviderError || error instanceof AiChatHistoryError
      ? String(error.code || 'request_failed').slice(0, 80)
      : 'internal_error';
    const upstreamStatus = Number.isInteger(error?.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599
      ? error.upstreamStatus
      : undefined;
    const fallbackAttempts = Number.isSafeInteger(error?.fallbackAttempts) && error.fallbackAttempts >= 0
      ? error.fallbackAttempts
      : undefined;
    console.error('Desktop AI chat failed:', JSON.stringify({
      requestId,
      error: error?.name || 'Error',
      code: safeCode,
      ...(upstreamStatus ? { upstreamStatus } : {}),
      ...(fallbackAttempts !== undefined ? { fallbackAttempts } : {}),
    }));

    if (error instanceof UsageLimitError) {
      sendJson(res, 429, { error: 'token_usage_limit_exceeded' });
    } else if (error instanceof UsageReservationError) {
      sendJson(res, error.code === 'active_entitlement_required' ? 403 : 409, {
        error: error.code === 'active_entitlement_required' ? 'active_entitlement_required' : 'ai_chat_unavailable',
        requestId,
      });
    } else if (error instanceof RequestError) {
      sendJson(res, error.status, { error: error.code, requestId });
    } else if (error instanceof AiChatHistoryError) {
      sendJson(res, error.status, { error: 'ai_chat_history_unavailable', requestId });
    } else if (error instanceof AiProviderError) {
      if (error.code === 'ai_chat_messages_invalid') {
        sendJson(res, error.status, { error: error.code, requestId });
      } else {
        sendJson(res, 502, { error: 'ai_chat_unavailable', requestId });
      }
    } else if (error instanceof WorkspaceError) {
      sendJson(res, error.status, { error: 'ai_chat_agent_unavailable', requestId });
    } else {
      sendJson(res, 500, { error: 'ai_chat_unavailable', requestId });
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

export function createServer({
  config = loadServerConfig(),
  authService = null,
  workspaceService = null,
  workosAuth = null,
  apiHubService = null,
  aiProviderService = null,
  aiChatService = null,
  aiChatHistoryService = null,
  usageService = null,
  signInOnlyPreview = false,
} = {}) {
  const runtime = {
    config,
    workosAuth,
  };
  const aiChatRateWindows = new Map();

  return http.createServer((req, res) => {
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

      if (url.pathname.startsWith('/api/workspace/') || url.pathname.startsWith('/api/onboarding/')) {
        const handled = await handleWorkspaceRequest(req, res, url, {
          config: activeConfig,
          authService,
          workspaceService,
        });
        if (handled) return;
      }

      if (url.pathname === '/api/chat' || url.pathname === '/api/chat/status' || url.pathname === '/api/chat/history') {
        await handleDesktopAiChatRequest(req, res, url, {
          config: activeConfig,
          authService,
          workspaceService,
          aiChatService,
          aiChatHistoryService,
          usageService,
          rateWindows: aiChatRateWindows,
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
          });
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
          res.writeHead(200, { 'Content-Type': staticAsset[1], 'Content-Length': body.length, 'Cache-Control': 'public, max-age=3600' });
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
