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
import { WorkOS } from '@workos-inc/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const desktopHtmlPath = path.join(publicDir, 'desktop.html');
const onboardingHtmlPath = path.join(publicDir, 'onboarding.html');
const loginHtmlPath = path.join(publicDir, 'login.html');
const devWorkOSTestSetupHtmlPath = path.join(publicDir, 'dev-workos-test-setup.html');
const authVerifyHtmlPath = path.join(publicDir, 'auth-verify.html');
const pocketHtmlPath = path.join(publicDir, 'pocket.html');
const apiHubHtmlPath = path.join(publicDir, 'api-hub.html');
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const STATIC_ASSETS = new Map([
  ['/keus-icon.svg', ['keus-icon.svg', 'image/svg+xml']],
  ['/keus-logo.svg', ['keus-logo.svg', 'image/svg+xml']],
]);
const LEGACY_BRAND_REDIRECTS = new Map([
  ['/cueclaw-icon.png', '/keus-logo.svg'],
  ['/cueclaw-logo.png', '/keus-icon.svg'],
]);
const PROTECTED_AUTH_PATHS = new Set(['/', '/app', '/desktop', '/desktop.html', '/onboarding']);

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

function applyAllowedCors(req, res, config) {
  const origin = requestOrigin(req);
  if (!origin.valid) return false;
  if (!origin.present || origin.sameOrigin) return true;
  if (!config.allowedOrigins.includes(origin.value)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin.value);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-Keus-Setup-Token, X-Kues-Setup-Token');
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

function sameSetupToken(left, right) {
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
  testSetupAvailable = false,
} = {}) {
  if (url.pathname === '/api/auth/config' && req.method === 'GET') {
    sendJson(res, 200, {
      provider: config.authProvider,
      enabled: config.workosConfigured,
      emailEnabled: config.workosConfigured,
      googleEnabled,
      githubEnabled,
      otherMethodsEnabled: googleEnabled || githubEnabled,
      testSetupAvailable,
    });
    return true;
  }

  if (config.authProvider === 'workos' && url.pathname === '/api/auth/email/start' && req.method === 'POST') {
    if (!authService || !workosAuth) {
      sendJson(res, 503, { error: 'auth_provider_not_configured' });
      return true;
    }
    const body = await readJsonBody(req);
    await workosAuth.requestEmailCode({
      email: body.email,
      ipAddress: req.socket.remoteAddress,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    });
    sendJson(res, 202, {
      accepted: true,
      message: 'If email sign-in is available, a six-digit code will be sent.',
    });
    return true;
  }

  if (config.authProvider === 'workos' && url.pathname === '/api/auth/email/verify' && req.method === 'POST') {
    if (!authService || !workosAuth) {
      sendJson(res, 503, { error: 'auth_provider_not_configured' });
      return true;
    }
    const body = await readJsonBody(req);
    const result = await workosAuth.verifyEmailCode({
      email: body.email,
      code: body.code,
      ipAddress: req.socket.remoteAddress,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    });
    sendJson(res, 200, { authenticated: true, isNewUser: result.isNewUser === true, user: result.user }, {
      'Set-Cookie': setSessionCookie(config, result.sessionToken),
    });
    return true;
  }

  if (config.authProvider === 'workos' && url.pathname === '/api/auth/email/consume') {
    sendJson(res, 410, { error: 'workos_authkit_required' });
    return true;
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
    sendJson(res, 200, { authenticated: true, user: result.user }, {
      'Set-Cookie': setSessionCookie(config, result.sessionToken),
    });
    return true;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = cookieValue(req, sessionCookieName(config));
    if (token) await authService.revokeSession({ token });
    sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': clearSessionCookie(config) });
    return true;
  }

  return false;
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

export function createServer({
  config = loadServerConfig(),
  authService = null,
  workosAuth = null,
  apiHubService = null,
  allowEphemeralWorkOSTestSetup = false,
  signInOnlyPreview = false,
  workosClientFactory = ({ apiKey, clientId }) => new WorkOS({ apiKey, clientId }),
} = {}) {
  const runtime = {
    config,
    workosAuth,
    ephemeralTestMode: false,
    setupToken: null,
  };

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

      if (allowEphemeralWorkOSTestSetup && activeConfig.nodeEnv !== 'production'
          && (url.pathname === '/__dev/workos-setup' || (signInOnlyPreview && url.pathname === '/'))
          && req.method === 'GET') {
        try {
          const setupToken = crypto.randomBytes(32).toString('base64url');
          runtime.setupToken = setupToken;
          const html = readHtml(devWorkOSTestSetupHtmlPath)
            .replace('%%WORKOS_SETUP_TOKEN%%', setupToken)
            .replace('%%WORKOS_READY%%', String(runtime.ephemeralTestMode));
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, max-age=0',
            'Pragma': 'no-cache',
          });
          res.end(html);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('Test setup page unavailable');
        }
        return;
      }

      if (allowEphemeralWorkOSTestSetup && url.pathname === '/api/dev/workos-setup' && req.method === 'POST') {
        const setupToken = req.headers['x-keus-setup-token'] || req.headers['x-kues-setup-token'];
        if (activeConfig.nodeEnv === 'production'
            || !runtime.setupToken || !sameSetupToken(setupToken, runtime.setupToken)) {
          sendJson(res, 403, { error: 'test_setup_token_invalid' });
          return;
        }
        if (!authService) {
          sendJson(res, 503, { error: 'local_auth_storage_not_ready' });
          return;
        }
        try {
          const body = await readJsonBody(req, 4096);
          const apiKey = String(body.apiKey || '').trim();
          const clientId = String(body.clientId || '').trim();
          if (!apiKey.startsWith('sk_test_') || apiKey.length > 512) {
            sendJson(res, 400, { error: 'test_api_key_required' });
            return;
          }
          if (!/^client_[A-Za-z0-9_-]{4,120}$/.test(clientId)) {
            sendJson(res, 400, { error: 'invalid_workos_client_id' });
            return;
          }
          runtime.setupToken = null;
          const workos = workosClientFactory({ apiKey, clientId });
          const redirectUri = 'http://localhost:3100/auth/callback';
          const adapter = createWorkOSAuth({ workos, clientId, redirectUri, authService });
          runtime.workosAuth = adapter;
          runtime.config = Object.freeze({
            ...activeConfig,
            authProvider: 'workos',
            workosConfigured: true,
            workosRedirectUri: redirectUri,
          });
          runtime.ephemeralTestMode = true;
          runtime.setupToken = crypto.randomBytes(32).toString('base64url');
          sendJson(res, 200, {
            configured: true,
            scope: 'memory_only',
            setupToken: runtime.setupToken,
          });
        } catch (error) {
          const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0);
          const code = status === 401 ? 'workos_key_rejected'
            : status === 403 ? 'workos_access_denied'
              : status === 429 ? 'workos_rate_limited'
                : status >= 500 || status === 0 ? 'workos_unreachable'
                  : 'test_setup_invalid';
          sendJson(res, status === 429 ? 429 : status === 401 || status === 403 ? 400 : 400, { error: code });
        }
        return;
      }

      if (url.pathname === '/auth/start' && req.method === 'GET') {
        if (!activeConfig.workosConfigured || !activeWorkosAuth || runtime.ephemeralTestMode) {
          redirect(res, '/login?auth_error=not_configured');
          return;
        }
        const provider = url.searchParams.get('provider') || 'authkit';
        const intent = url.searchParams.get('intent') || 'sign-in';
        if (!['sign-in', 'sign-up'].includes(intent)) {
          redirect(res, '/login?auth_error=invalid_request');
          return;
        }
        const socialProviderEnabled = provider === 'GoogleOAuth'
          ? activeConfig.workosGoogleOAuthEnabled === true && !signInOnlyPreview
          : provider === 'GitHubOAuth'
            ? activeConfig.workosGithubOAuthEnabled === true && !signInOnlyPreview
            : provider === 'authkit';
        if (!socialProviderEnabled) {
          redirect(res, '/login?auth_error=provider_disabled');
          return;
        }
        const state = crypto.randomBytes(32).toString('base64url');
        try {
          const authorizationUrl = await activeWorkosAuth.getAuthorizationUrl({
            state, provider, ...(provider === 'authkit' ? { screenHint: intent } : {}),
          });
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
        if (!activeConfig.workosConfigured || !activeWorkosAuth || runtime.ephemeralTestMode || url.searchParams.has('error')) {
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
            Location: result.isNewUser === true ? '/onboarding' : '/app',
            'Cache-Control': 'no-store',
            'Set-Cookie': [clearWorkOSStateCookie(activeConfig), setSessionCookie(activeConfig, result.sessionToken)],
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
          service: 'keus-desktop',
          version: '2.2.0',
          surfaces: ['desktop:/app', 'onboarding:/onboarding'],
        };
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end();
        } else sendJson(res, 200, payload);
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
            googleEnabled: activeConfig.workosConfigured && activeConfig.workosGoogleOAuthEnabled === true && !runtime.ephemeralTestMode && !signInOnlyPreview,
            githubEnabled: activeConfig.workosConfigured && activeConfig.workosGithubOAuthEnabled === true && !runtime.ephemeralTestMode && !signInOnlyPreview,
            testSetupAvailable: allowEphemeralWorkOSTestSetup && activeConfig.nodeEnv !== 'production',
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

      if (signInOnlyPreview && !['/', '/login', '/__dev/workos-setup', '/app', '/onboarding', '/keus-icon.svg', '/keus-logo.svg'].includes(url.pathname)) {
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
        ['/', desktopHtmlPath], ['/app', desktopHtmlPath], ['/desktop', desktopHtmlPath], ['/desktop.html', desktopHtmlPath],
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
        const html = readHtml(htmlPath);
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
  const ephemeralWorkOSTestSetup = process.env.ENABLE_WORKOS_TEST_SETUP === '1'
    && String(process.env.NODE_ENV || 'development') !== 'production';
  const signInOnlyPreview = (process.env.KEUS_SIGNIN_ONLY_PREVIEW === '1' || process.env.KUES_SIGNIN_ONLY_PREVIEW === '1')
    && String(process.env.NODE_ENV || 'development') !== 'production';
  if (ephemeralWorkOSTestSetup && !process.env.TURSO_DATABASE_URL) {
    const legacyDb = path.resolve(process.cwd(), 'cueclaw.local.db');
    const keusDb = path.resolve(process.cwd(), 'keus.local.db');
    // Preserve an existing local database; new installs default to the Keus filename.
    process.env.TURSO_DATABASE_URL = fs.existsSync(legacyDb) && !fs.existsSync(keusDb)
      ? 'file:./cueclaw.local.db' : 'file:./keus.local.db';
  }
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
    let workosAuth = null;
    let apiHubService = null;
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
        authService = createAuthService({ db, emailDelivery });
        if (config.apiHubEnabled) {
          apiHubService = createApiHubService({ db, encryptionKey: process.env.API_HUB_ENCRYPTION_KEY });
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
          });
        }
      }
      const server = createServer({
        config,
        authService,
        workosAuth,
        apiHubService,
        allowEphemeralWorkOSTestSetup: ephemeralWorkOSTestSetup,
        signInOnlyPreview,
      });
      server.on('close', () => { void db?.close(); });
      server.listen(port, '0.0.0.0', () => {
        console.log(`Keus desktop server listening on http://0.0.0.0:${port}`);
        if (config.databaseConfigured) {
          console.log('Database schema ready.');
          console.log(config.workosConfigured
            ? 'WorkOS AuthKit sign-in is configured.'
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
