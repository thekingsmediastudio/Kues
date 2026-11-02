import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ConfigError, loadServerConfig } from '../../apps/web/lib/config.mjs';
import { createServer } from '../../apps/web/server.mjs';
import { createDatabaseClient, DatabaseConfigurationError } from '../../apps/web/lib/db/client.mjs';

async function withServer(config, run, authService = null) {
  const server = createServer({ config, authService });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('server config defaults to sandbox and does not expose secrets', () => {
  const config = loadServerConfig({
    PAYPAL_CLIENT_ID: 'not-returned',
    PAYPAL_CLIENT_SECRET: 'also-not-returned',
    CHANNEL3_API_KEY: 'secret-c3-key',
  });
  assert.equal(config.paypalMode, 'sandbox');
  assert.equal(config.paypalConfigured, true);
  assert.equal(config.channel3Configured, true);
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(JSON.stringify(config).includes('not-returned'), false);
  assert.equal(JSON.stringify(config).includes('secret-c3-key'), false);
});

test('competition configuration requires a complete timezone-explicit window and positive daily token cap', () => {
  assert.equal(loadServerConfig({}).competition, null);
  const configured = loadServerConfig({
    KEUS_COMPETITION_START_AT: '2026-11-01T00:00:00-04:00',
    KEUS_COMPETITION_END_AT: '2026-11-30T23:59:59Z',
    KEUS_COMPETITION_DAILY_TOKEN_LIMIT: '25000',
  });
  assert.deepEqual(configured.competition, {
    startAt: '2026-11-01T04:00:00.000Z',
    endAt: '2026-11-30T23:59:59.000Z',
    dailyTokenLimit: 25000,
  });
  assert.throws(() => loadServerConfig({ KEUS_COMPETITION_START_AT: '2026-11-01T00:00:00Z' }), ConfigError);
  assert.throws(() => loadServerConfig({
    KEUS_COMPETITION_START_AT: '2026-11-01T00:00:00',
    KEUS_COMPETITION_END_AT: '2026-11-30T00:00:00Z',
    KEUS_COMPETITION_DAILY_TOKEN_LIMIT: '1000',
  }), ConfigError);
  assert.throws(() => loadServerConfig({
    KEUS_COMPETITION_START_AT: '2026-12-01T00:00:00Z',
    KEUS_COMPETITION_END_AT: '2026-11-30T00:00:00Z',
    KEUS_COMPETITION_DAILY_TOKEN_LIMIT: '1000',
  }), ConfigError);
  assert.throws(() => loadServerConfig({
    KEUS_COMPETITION_START_AT: '2026-11-01T00:00:00Z',
    KEUS_COMPETITION_END_AT: '2026-11-30T00:00:00Z',
    KEUS_COMPETITION_DAILY_TOKEN_LIMIT: '0',
  }), ConfigError);
});

test('WorkOS config is explicit, complete, callback-bound, database-backed, and secret-free', () => {
  const config = loadServerConfig({
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_server_only',
    WORKOS_CLIENT_ID: 'client_server_only',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    WORKOS_GOOGLE_OAUTH_ENABLED: '1',
    WORKOS_GITHUB_OAUTH_ENABLED: '0',
    TURSO_DATABASE_URL: 'file:./local.db',
  });
  assert.equal(config.authProvider, 'workos');
  assert.equal(config.workosConfigured, true);
  assert.equal(config.workosGoogleOAuthEnabled, true);
  assert.equal(config.workosGithubOAuthEnabled, false);
  assert.equal(config.workosRedirectUri, 'http://localhost:3100/auth/callback');
  assert.equal(JSON.stringify(config).includes('sk_server_only'), false);
  assert.equal(JSON.stringify(config).includes('client_server_only'), false);
  assert.throws(() => loadServerConfig({ AUTH_PROVIDER: 'workos' }), ConfigError);
  assert.throws(() => loadServerConfig({
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_x',
    WORKOS_CLIENT_ID: 'client_x',
    WORKOS_REDIRECT_URI: 'https://app.example.test/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  }), ConfigError);

  const renderConfig = loadServerConfig({
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_render_test',
    WORKOS_CLIENT_ID: 'client_render_test',
    RENDER_EXTERNAL_URL: 'https://keus-staging.onrender.com',
    TURSO_DATABASE_URL: 'libsql://kues-staging.example.turso.io',
    TURSO_AUTH_TOKEN: 'render-db-token',
  });
  assert.equal(renderConfig.workosRedirectUri, 'https://keus-staging.onrender.com/auth/callback');
});

test('API Hub requires a WorkOS admin allowlist, Turso, and a 32-byte encryption key without exposing it', () => {
  const encryptionKey = Buffer.alloc(32, 9).toString('base64');
  const config = loadServerConfig({
    API_HUB_ADMIN_EMAILS: ' Owner@Example.test, admin@example.test ',
    API_HUB_ENCRYPTION_KEY: encryptionKey,
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_key',
    WORKOS_CLIENT_ID: 'client_1234',
    RENDER_EXTERNAL_URL: 'https://keus-staging.onrender.com',
    TURSO_DATABASE_URL: 'libsql://keus.example.turso.io',
    TURSO_AUTH_TOKEN: 'db-token',
  });
  assert.equal(config.apiHubEnabled, true);
  assert.deepEqual(config.apiHubAdminEmails, ['owner@example.test', 'admin@example.test']);
  assert.equal(JSON.stringify(config).includes(encryptionKey), false);
  assert.throws(() => loadServerConfig({ API_HUB_ADMIN_EMAILS: 'owner@example.test' }), ConfigError);
  assert.throws(() => loadServerConfig({
    API_HUB_ADMIN_EMAILS: 'owner@example.test', API_HUB_ENCRYPTION_KEY: 'bad',
    AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test_key', WORKOS_CLIENT_ID: 'client_1234',
    WORKOS_REDIRECT_URI: 'https://keus.example.test/auth/callback', TURSO_DATABASE_URL: 'file:./local.db',
  }), ConfigError);
  assert.throws(() => loadServerConfig({
    API_HUB_ADMIN_EMAILS: 'not-an-email', API_HUB_ENCRYPTION_KEY: encryptionKey,
    AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test_key', WORKOS_CLIENT_ID: 'client_1234',
    WORKOS_REDIRECT_URI: 'https://keus.example.test/auth/callback', TURSO_DATABASE_URL: 'file:./local.db',
  }), ConfigError);
});

test('AI provider admin config requires WorkOS, Turso, and a separate 32-byte encryption key without exposing it', () => {
  const encryptionKey = Buffer.alloc(32, 19).toString('base64');
  const config = loadServerConfig({
    AI_PROVIDER_ADMIN_EMAILS: ' Owner@Example.test ',
    AI_PROVIDER_ENCRYPTION_KEY: encryptionKey,
    AI_PROVIDER_CHAT_TEST_ENABLED: '1',
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_key',
    WORKOS_CLIENT_ID: 'client_1234',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  });
  assert.equal(config.aiProvidersEnabled, true);
  assert.deepEqual(config.aiProviderAdminEmails, ['owner@example.test']);
  assert.equal(config.aiProviderChatTestEnabled, true);
  assert.equal(JSON.stringify(config).includes(encryptionKey), false);
  assert.throws(() => loadServerConfig({ AI_PROVIDER_ADMIN_EMAILS: 'owner@example.test' }), ConfigError);
  assert.throws(() => loadServerConfig({
    AI_PROVIDER_ADMIN_EMAILS: 'owner@example.test', AI_PROVIDER_ENCRYPTION_KEY: 'bad',
    AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test_key', WORKOS_CLIENT_ID: 'client_1234',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback', TURSO_DATABASE_URL: 'file:./local.db',
  }), ConfigError);
  assert.throws(() => loadServerConfig({
    AI_PROVIDER_ADMIN_EMAILS: 'not-an-email', AI_PROVIDER_ENCRYPTION_KEY: encryptionKey,
    AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test_key', WORKOS_CLIENT_ID: 'client_1234',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback', TURSO_DATABASE_URL: 'file:./local.db',
  }), ConfigError);
  assert.throws(() => loadServerConfig({
    AI_PROVIDER_ADMIN_EMAILS: 'owner@example.test', AI_PROVIDER_ENCRYPTION_KEY: encryptionKey,
    AUTH_PROVIDER: 'brevo', TURSO_DATABASE_URL: 'file:./local.db',
  }), ConfigError);
  assert.equal(loadServerConfig({}).aiProviderChatTestEnabled, false);
  assert.throws(() => loadServerConfig({ AI_PROVIDER_CHAT_TEST_ENABLED: 'yes' }), ConfigError);
  assert.throws(() => loadServerConfig({ AI_PROVIDER_CHAT_TEST_ENABLED: '1' }), ConfigError);
});

test('the staging Render blueprint enables admin-only desktop chat testing without changing other environments', () => {
  const render = readFileSync(new URL('../../render.yaml', import.meta.url), 'utf8');
  assert.match(render, /name: keus-staging/);
  assert.match(render, /key: AI_PROVIDER_CHAT_TEST_ENABLED\s+value: "1"/);
  assert.equal(loadServerConfig({}).aiProviderChatTestEnabled, false);
});

test('server config rejects live PayPal, partial credentials, and wildcard CORS', () => {
  assert.throws(() => loadServerConfig({ PAYPAL_ENV: 'live' }), ConfigError);
  assert.throws(() => loadServerConfig({ PAYPAL_CLIENT_ID: 'id-only' }), ConfigError);
  assert.throws(() => loadServerConfig({ CORS_ALLOWED_ORIGINS: '*' }), ConfigError);
  assert.throws(() => loadServerConfig({ CORS_ALLOWED_ORIGINS: 'https://example.com/path' }), ConfigError);
  assert.throws(() => loadServerConfig({ WORKOS_GOOGLE_OAUTH_ENABLED: '1' }), ConfigError);
  assert.throws(() => loadServerConfig({ WORKOS_GITHUB_OAUTH_ENABLED: 'yes' }), ConfigError);
  assert.throws(() => loadServerConfig({ TURSO_DATABASE_URL: 'libsql://db.example.turso.io' }), ConfigError);
  assert.throws(() => loadServerConfig({ TURSO_AUTH_TOKEN: 'orphan-token' }), ConfigError);
  assert.equal(loadServerConfig({ TURSO_DATABASE_URL: 'libsql://db.example.turso.io', TURSO_AUTH_TOKEN: 'secret' }).databaseConfigured, true);
  assert.throws(() => loadServerConfig({ EMAIL_PROVIDER: 'brevo' }), ConfigError);
  const emailReady = loadServerConfig({
    TURSO_DATABASE_URL: 'file:./local.db',
    AUTH_PROVIDER: 'brevo',
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: 'server-only-secret',
    EMAIL_FROM: 'login@example.test',
    APP_BASE_URL: 'https://keus.example.test',
  });
  assert.equal(emailReady.emailDeliveryConfigured, true);
  assert.equal(emailReady.emailProvider, 'brevo');
  assert.equal(JSON.stringify(emailReady).includes('server-only-secret'), false);
  assert.throws(() => loadServerConfig({
    TURSO_DATABASE_URL: 'file:./local.db', EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'key',
    EMAIL_FROM: 'login@example.test', APP_BASE_URL: 'https://keus.example.test/path',
  }), ConfigError);
});

test('server allows only explicit cross-origin API access and returns JSON API misses', async () => {
  const config = loadServerConfig({ CORS_ALLOWED_ORIGINS: 'https://preview.example' });
  await withServer(config, async (base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.service, 'keus-web');
    assert.equal(body.version, '2.4.0');
    assert.deepEqual(body.surfaces, ['marketing:/', 'dashboard:/app', 'desktop-preview:/desktop-preview', 'onboarding:/onboarding']);
    assert.equal(health.headers.get('access-control-allow-origin'), null);

    const allowed = await fetch(`${base}/api/health`, { headers: { Origin: 'https://preview.example' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://preview.example');

    const denied = await fetch(`${base}/api/health`, { headers: { Origin: 'https://other.example' } });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'origin_not_allowed' });

    const missing = await fetch(`${base}/api/not-implemented`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'api_route_not_found' });
  });
});

test('user-facing Keus pages avoid em dashes and emoji glyphs', () => {
  const files = ['landing.html', 'dashboard.html', 'desktop-preview.html', 'login.html', 'onboarding.html', 'pocket.html', 'api-hub.html', 'ai-providers-admin.html', 'auth-verify.html'];
  const forbiddenGlyphs = [0x2713, 0x2726, 0x2315, 0x2667, 0x2197, 0x2022].map((codePoint) => String.fromCodePoint(codePoint));
  for (const file of files) {
    const html = readFileSync(new URL(`../../apps/web/public/${file}`, import.meta.url), 'utf8');
    // Source comments are intentionally left untouched; enforce the cleanup on rendered markup and UI strings.
    const userFacingSource = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
    assert.equal(userFacingSource.includes(String.fromCodePoint(0x2014)), false, `${file} contains an em dash`);
    assert.doesNotMatch(userFacingSource, /&mdash;|&#(?:8212|x2014);/i, file);
    for (const character of userFacingSource) {
      const codePoint = character.codePointAt(0);
      assert.ok(!(codePoint >= 0x1f000 && codePoint <= 0x1faff) && !(codePoint >= 0x2600 && codePoint <= 0x27bf), `${file} contains a pictographic symbol`);
    }
    for (const glyph of forbiddenGlyphs) assert.equal(userFacingSource.includes(glyph), false, `${file} contains a decorative text glyph`);
  }
});

test('public landing and authenticated dashboard have separate page routes', async () => {
  await withServer(loadServerConfig({}), async (base) => {
    for (const route of ['/', '/app', '/dashboard', '/desktop-preview', '/onboarding', '/login', '/auth/verify']) {
      const res = await fetch(`${base}${route}`);
      assert.equal(res.status, 200, route);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
    }
    const landing = await (await fetch(`${base}/`)).text();
    assert.match(landing, /Your AI workspace/);
    assert.match(landing, /href="\/app"/);
    assert.doesNotMatch(landing, /href="\/desktop(?:\.html)?"/);
    assert.match(landing, /rel="icon"[^>]+href="\/keus-icon\.svg"/);
    assert.match(landing, /id="themeToggle"/);
    assert.match(landing, /<div class="topbar-left">[\s\S]*?<a class="brand"[\s\S]*?<nav class="nav"/);
    assert.match(landing, /api\/auth\/session/);
    assert.match(landing, /api\/settings\/theme/);
    assert.match(landing, /class="button button-dark" id="headerAccountLink" href="\/login">Sign in/);
    assert.doesNotMatch(landing, /class="button button-dark" href="\/app">Open dashboard/);
    assert.match(landing, /headerAccountLink/);
    assert.match(landing, /footerAccountLink/);
    assert.match(landing, /localStorage\.getItem\('keusTheme'\)/);
    assert.match(landing, /--font:Inter,ui-sans-serif,system-ui/);
    const dashboard = await (await fetch(`${base}/app`)).text();
    assert.match(dashboard, /api\/workspace\/bootstrap/);
    const loadingMark = dashboard.match(/<div class="loading-mark"[\s\S]*?<\/svg>/)?.[0] || '';
    const dashboardBrandMark = dashboard.match(/<span class="dashboard-home-mark"[\s\S]*?<\/svg>/)?.[0] || '';
    for (const mark of [loadingMark, dashboardBrandMark]) {
      assert.match(mark, /fill="#32d583"/);
      assert.match(mark, /<ellipse cx="15\.2"/);
      assert.match(mark, /<ellipse cx="25"/);
      assert.match(mark, /M16\.7 23\.35/);
      assert.match(mark, /<circle cx="11\.2"/);
    }
    assert.match(dashboard, /rel="icon"[^>]+href="\/keus-icon\.svg"/);
    assert.match(dashboard, /id="themeToggle"/);
    assert.match(dashboard, /api\/settings\/theme/);
    assert.match(dashboard, /localStorage\.getItem\('keusTheme'\)/);
    assert.match(dashboard, /--font:Inter,ui-sans-serif,system-ui/);
    assert.doesNotMatch(dashboard, /<aside\b|class="sidebar"|id="setupNav"|>Setup<\/a>/);
    assert.match(dashboard, /class="dashboard-home" href="\/"/);
    assert.match(dashboard, /class="home-external-icon"/);
    assert.match(dashboard, /aria-controls="accountMenu"/);
    const accountMenu = dashboard.indexOf('id="accountMenu"');
    const accountEmail = dashboard.indexOf('id="accountEmail"', accountMenu);
    const themeToggle = dashboard.indexOf('id="themeToggle"', accountMenu);
    const signOutButton = dashboard.indexOf('id="signOutButton"', accountMenu);
    assert.ok(accountMenu >= 0 && accountEmail < themeToggle && themeToggle < signOutButton, 'theme and sign-out actions belong inside the account dropdown');
    assert.doesNotMatch(dashboard, /Run a demo|Simulate purchase/i);
    const desktopPreview = await (await fetch(`${base}/desktop-preview`)).text();
    assert.match(desktopPreview, /<aside class="sidebar" id="workspaceSidebar">/);
    assert.match(desktopPreview, /id="agentList"/);
    assert.match(desktopPreview, /api\/workspace\/bootstrap/);
    assert.match(desktopPreview, /credentials:\s*'same-origin'/);
    assert.match(desktopPreview, /id="newAgentButton" onclick="openNewAgentModal\(\)"/);
    assert.match(desktopPreview, /id="newAgentButtonLabel">New Agent<\/span>/);
    assert.match(desktopPreview, /id="appSettingsButton"[^>]*onclick="openGeneralOverlay\('workspace'\)"/);
    assert.match(desktopPreview, /aria-label="Open Settings"/);
    assert.match(desktopPreview, /id="agentSearchInput"/);
    assert.match(desktopPreview, /id="savedAgentRow"[^>]*role="button"[^>]*tabindex="-1"[^>]*hidden/);
    assert.match(desktopPreview, /row\.setAttribute\('role', 'button'\)/);
    assert.match(desktopPreview, /row\.setAttribute\('aria-pressed', String\(isActive\)\)/);
    assert.match(desktopPreview, /selectDesktopAgent\(agent\.id\)/);
    assert.match(desktopPreview, /function renderSavedAgentRows\(agents, activeAgent\)/);
    assert.match(desktopPreview, /row\.hidden = false/);
    assert.match(desktopPreview, /row\.classList\.toggle\('active', isActive\)/);
    assert.match(desktopPreview, /border:0;border-radius:0;background:transparent/);
    assert.match(desktopPreview, /pointer-events:none/);
    assert.doesNotMatch(desktopPreview, /workspace-context-card|savedAgentRoster|Example teammates, not live agents/);
    const desktopSearch = desktopPreview.indexOf('id="agentSearchInput"');
    const desktopAgentList = desktopPreview.indexOf('id="agentList"');
    const savedAgentRow = desktopPreview.indexOf('id="savedAgentRow"');
    assert.ok(desktopSearch >= 0 && desktopAgentList > desktopSearch && savedAgentRow > desktopAgentList, 'saved agent row belongs in the searchable agent list below the search box');
    assert.equal((desktopPreview.match(/class="agent-row\b/g) || []).length, 1, 'only the authenticated saved-agent row is present in the list');
    assert.doesNotMatch(desktopPreview, /data-agent-id=|id="workspaceName"|id="savedSetupName"|id="savedPaymentState"/);
    assert.match(desktopPreview, /id="appSettingsTitle">Settings/);
    assert.match(desktopPreview, /id="settingsPreviewNotice"[^>]*role="status"/);
    assert.match(desktopPreview, /Settings load from your authenticated account/);
    assert.match(desktopPreview, /Local review data cannot save account or workspace changes/);
    assert.match(desktopPreview, /Saved to the signed-in account's shared workspace/);
    assert.match(desktopPreview, /Changes are saved to this signed-in workspace/);
    assert.match(desktopPreview, /id="profileSettingsForm"/);
    assert.match(desktopPreview, /id="workspaceSettingsForm"/);
    assert.match(desktopPreview, /id="settingsAgentForm"/);
    assert.match(desktopPreview, /id="emailChangeStartForm"/);
    assert.match(desktopPreview, /id="emailChangeConfirmForm"/);
    assert.match(desktopPreview, /id="passwordChangeForm"/);
    assert.match(desktopPreview, /api\/settings\/email-change\/start/);
    assert.match(desktopPreview, /api\/settings\/email-change\/confirm/);
    for (const pane of ['Workspace', 'Agents', 'Apps', 'Usage', 'Account', 'Appearance']) {
      assert.match(desktopPreview, new RegExp(`id="settingsPane${pane}"`));
    }
    assert.match(desktopPreview, /New agents start Active for chat/);
    assert.match(desktopPreview, /7,000,000 AI tokens/);
    for (const app of ['PayPal Sandbox', 'Channel3', 'KERNEL', 'WhatsApp', 'Inbox', 'Instagram Shops']) {
      assert.ok(desktopPreview.includes(app), `settings include preview app label ${app}`);
    }
    assert.match(desktopPreview, /data-preview-theme="dark"/);
    assert.doesNotMatch(desktopPreview, /Settings are not connected to this preview/);
    assert.match(desktopPreview, /id="accountEmail"/);
    assert.match(desktopPreview, /aria-controls="accountMenu"/);
    const desktopMenu = desktopPreview.indexOf('id="accountMenu"');
    const desktopEmail = desktopPreview.indexOf('id="accountMenuEmail"', desktopMenu);
    const desktopTheme = desktopPreview.indexOf('id="themeToggle"', desktopMenu);
    const desktopSignout = desktopPreview.indexOf('id="signOutButton"', desktopMenu);
    assert.ok(desktopMenu >= 0 && desktopEmail < desktopTheme && desktopTheme < desktopSignout, 'desktop account controls belong in the account dropdown');
    assert.match(desktopPreview, /id="streamInner"[^>]*role="log"/);
    assert.match(desktopPreview, /id="chatPlusButton"[^>]*disabled/);
    assert.match(desktopPreview, /id="chatInput"[^>]*aria-describedby="chatPreviewNote chatInputHelp"/);
    assert.match(desktopPreview, /id="chatMicButton"[^>]*disabled/);
    assert.match(desktopPreview, /id="chatSendButton"[^>]*disabled/);
    assert.match(desktopPreview, /id="voiceCallButton"[^>]*disabled/);
    assert.match(desktopPreview, /id="desktopButton"[^>]*disabled/);
    assert.match(desktopPreview, /Checking chat availability/);
    assert.match(desktopPreview, /fetchUiRead\('\/api\/chat\/status'/);
    assert.match(desktopPreview, /fetch\('\/api\/chat'/);
    assert.match(desktopPreview, /fetchUiRead\(`\/api\/chat\/history\?agentId=/);
    assert.match(desktopPreview, /encrypted and saved to this Keus workspace/);
    assert.match(desktopPreview, /message: content/);
    assert.doesNotMatch(desktopPreview, /Qwen|GPT-OSS|model ID/i);
    assert.match(desktopPreview, /bubble\.textContent = content/);
    assert.match(desktopPreview, /renderChatMarkdown\(answerText, content\)/);
    assert.match(desktopPreview, /id="newAgentForm"/);
    assert.match(desktopPreview, /id="newAgentName"/);
    assert.match(desktopPreview, /id="newAgentRole"/);
    assert.match(desktopPreview, /id="newAgentPreviewAvatar"/);
    assert.match(desktopPreview, /id="newAgentPreviewName"/);
    assert.match(desktopPreview, /id="newAgentPreviewRole"/);
    assert.match(desktopPreview, /id="newAgentColorOptions"[\s\S]*data-color="#32d583"/);
    assert.match(desktopPreview, /class="new-agent-color-choice[^"]*"[^>]*style="--swatch-color:#32d583"/);
    assert.match(desktopPreview, /id="newAgentAvatarOptions"[\s\S]*data-avatar="bulb"/);
    assert.doesNotMatch(desktopPreview, /id="newAgentApprovalOptions"|id="settingsAgentApprovalOptions"|id="agentTabAccounts"|id="agentPanelAccounts"/);
    assert.match(desktopPreview, /function renderNewAgentPreview\(\)/);
    const newAgentFormMarkup = desktopPreview.slice(desktopPreview.indexOf('<form class="new-agent-form"'), desktopPreview.indexOf('</form>', desktopPreview.indexOf('<form class="new-agent-form"')));
    assert.doesNotMatch(newAgentFormMarkup, /<select\b/, 'the new-agent form uses visual choices instead of dropdowns');
    assert.match(desktopPreview, /id="newAgentOrderCap"/);
    assert.match(desktopPreview, /id="newAgentDailyCap"/);
    assert.doesNotMatch(newAgentFormMarkup, /Apps|Accounts|App labels|data-approval-path/);
    assert.match(desktopPreview, /approvalPath: 'desktop'/);
    assert.match(desktopPreview, /id="newAgentMemoryPills"/);
    assert.ok(desktopPreview.includes("String(value('newAgentMemoryPills')).split(/\\r?\\n/)") , 'memory preferences split on line boundaries');
    assert.match(desktopPreview, /id="createNewAgentButton"/);
    assert.match(desktopPreview, /fetch\('\/api\/workspace\/agents'/);
    assert.match(desktopPreview, /function objectAvatarSvg\(kind, color\)/);
    assert.match(desktopPreview, /replaceAll\('stroke="#111113"','stroke="var\(--agent-avatar-outline\)"'\)/);
    assert.match(desktopPreview, /:root\{--agent-avatar-outline:#fff\}/);
    assert.match(desktopPreview, /:root\[data-theme="light"\]\{--agent-avatar-outline:#111113\}/);
    assert.match(desktopPreview, /\.cueclaw-brand-name \{ color:#fff;font:800 14px/);
    assert.match(desktopPreview, /:root\[data-theme="light"\] \.cueclaw-brand-name \{ color:#111113; \}/);
    assert.match(desktopPreview, /\.account-menu-user span\{color:var\(--text-dim\);font-size:12px\}/);
    assert.match(desktopPreview, /\.account-menu-user strong\{margin-top:3px;color:var\(--text-main\);font-size:14px/);
    assert.match(desktopPreview, /\.account-menu-user small\{margin-top:3px;color:var\(--text-sec\);font-size:12px\}/);
    assert.match(desktopPreview, /\.account-menu-item\{[^}]*font:500 13px var\(--font\)/);
    assert.match(desktopPreview, /\.account-trigger-copy strong\{[^}]*font-size:12px/);
    assert.match(desktopPreview, /\.account-trigger-copy small\{[^}]*font-size:11px/);
    assert.match(desktopPreview, /New agents start Active for chat/);
    assert.match(desktopPreview, /This sample review account is not authenticated and cannot save agents/);
    const desktopMarkup = desktopPreview.replace(/<script>[\s\S]*?<\/script>/g, '');
    assert.doesNotMatch(desktopMarkup, /Shopping Crew|Nova|Atlas|Aegis|preview apps|Example prompt|Example receipt|computer preview|Sentinel test unavailable/i);
    assert.match(desktopMarkup, /id="sampleReviewBadge"[^>]*hidden><span class="review-badge-full">Sample review data/);
    assert.doesNotMatch(desktopMarkup, /id="agentParticular(?:Button|Label|Glyph)"|id="takeOverBtn"|id="approveBtn"|preview-status-banner/);
    assert.match(desktopPreview, /function renderAuthenticatedWorkspace/);
    assert.match(desktopPreview, /function isLocalReviewHost/);
    assert.match(desktopPreview, /hostname\.endsWith\('\.e2b\.app'\)/);
    assert.match(desktopPreview, /data\.error === 'auth_storage_not_configured'/);
    assert.match(desktopPreview, /name: 'Route Scout'/);
    assert.match(desktopPreview, /displayName: 'Review Account'/);
    assert.match(desktopPreview, /statusLabel = \(\{ active: 'Active', paused: 'Paused', archived: 'Archived' \}\)/);
    assert.match(desktopPreview, /\.sidebar \.sidebar-bottom-tile/);
    assert.match(desktopPreview, /:root\[data-theme="light"\] \.sidebar \.sidebar-bottom-tile/);
    assert.doesNotMatch(desktopPreview, /class="dashboard-home" href="\/"/);
    const login = await (await fetch(`${base}/login`)).text();
    assert.match(login, /rel="icon"[^>]+href="\/keus-icon\.svg"/);
    assert.match(login, /id="themeToggle"/);
    assert.match(login, /api\/settings\/theme/);
    assert.match(login, /localStorage\.getItem\('keusTheme'\)/);
    assert.match(login, /auth-theme-toggle/);
    const onboarding = await (await fetch(`${base}/onboarding`)).text();
    assert.match(onboarding, /window\.location\.href='\/app'/);
    assert.match(onboarding, /window\.location\.replace\('\/app'\)/);
    assert.match(onboarding, /data\.user\.theme/);
    assert.doesNotMatch(onboarding, /window\.location\.(?:href|replace)='\/desktop'/);
    for (const legacy of ['/desktop', '/desktop.html']) {
      const response = await fetch(`${base}${legacy}`, { redirect: 'manual' });
      assert.equal(response.status, 302, legacy);
      assert.equal(response.headers.get('location'), '/app');
    }
  });
});

test('landing renders the signed-in dashboard links before returning HTML', async () => {
  const sessions = {
    async getSession({ token }) {
      return token === 'valid-session' ? { id: 'user-1', email: 'person@example.test' } : null;
    },
  };
  await withServer(loadServerConfig({}), async (base) => {
    const signedIn = await fetch(`${base}/`, { headers: { Cookie: 'kues_session=valid-session' } });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.headers.get('cache-control'), 'no-store');
    const signedInHtml = await signedIn.text();
    assert.match(signedInHtml, /id="headerAccountLink" href="\/app">Dashboard/);
    assert.match(signedInHtml, /id="footerAccountLink" href="\/app">Dashboard/);
    assert.match(signedInHtml, /api\/auth\/session/);
    assert.match(signedInHtml, /api\/settings\/theme/);

    const signedOut = await fetch(`${base}/`);
    const signedOutHtml = await signedOut.text();
    assert.match(signedOutHtml, /id="headerAccountLink" href="\/login">Sign in/);
    assert.match(signedOutHtml, /id="footerAccountLink" href="\/login">Sign in/);
  }, sessions);
});

test('unknown page and static paths return 404; approved assets are explicit', async () => {
  await withServer(loadServerConfig({}), async (base) => {
    for (const route of ['/does-not-exist', '/robots.txt', '/desktop.css', '/..%2fserver.mjs']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 404, route);
      assert.doesNotMatch(await response.text(), /<!doctype html/i, route);
    }
    for (const name of ['local-audio.mjs', 'local-audio-capture.mjs', 'local-dictation-worker.mjs']) {
      const script = await fetch(`${base}/${name}`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);
      assert.equal(script.headers.get('cache-control'), 'no-cache');
    }
    const asset = await fetch(`${base}/keus-icon.svg`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') || '', /image\/svg\+xml/);
    assert.match(await asset.text(), /Keus icon/);
    for (const [legacy, current] of [['/cueclaw-icon.png', '/keus-logo.svg'], ['/cueclaw-logo.png', '/keus-icon.svg']]) {
      const redirect = await fetch(`${base}${legacy}`, { redirect: 'manual' });
      assert.equal(redirect.status, 308, legacy);
      assert.equal(redirect.headers.get('location'), current);
    }
  });
});

test('public landing stays open while dashboard and onboarding require a valid local session', async () => {
  const production = loadServerConfig({ NODE_ENV: 'production' });
  await withServer(production, async (base) => {
    const landing = await fetch(`${base}/`);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Your AI workspace/);
    for (const route of ['/app', '/dashboard', '/desktop-preview', '/desktop', '/desktop.html', '/onboarding']) {
      const noStorage = await fetch(`${base}${route}`, { redirect: 'manual' });
      assert.equal(noStorage.status, 503, route);
      assert.deepEqual(await noStorage.json(), { error: 'auth_storage_not_configured' });
    }
  });
  const sessions = { async getSession({ token }) { return token === 'valid-session' ? { id: 'user-1' } : null; } };
  await withServer(production, async (base) => {
    assert.equal((await fetch(`${base}/`, { headers: { Cookie: '__Host-kues_session=invalid' } })).status, 200);
    for (const route of ['/app', '/dashboard', '/desktop-preview', '/desktop', '/desktop.html', '/onboarding']) {
      const response = await fetch(`${base}${route}`, { redirect: 'manual' });
      assert.equal(response.status, 302, route);
      assert.equal(response.headers.get('location'), '/login?auth_error=session');
      assert.equal((await fetch(`${base}${route}`, { headers: { Cookie: '__Host-kues_session=invalid' }, redirect: 'manual' })).status, 302);
    }
    const login = await fetch(`${base}/login`);
    assert.equal(login.status, 200);
  }, sessions);
  await withServer(production, async (base) => {
    for (const route of ['/app', '/dashboard', '/desktop-preview', '/onboarding']) {
      const response = await fetch(`${base}${route}`, { headers: { Cookie: '__Host-kues_session=valid-session' }, redirect: 'manual' });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Keus/i);
    }
    for (const route of ['/desktop', '/desktop.html']) {
      const response = await fetch(`${base}${route}`, { headers: { Cookie: '__Host-kues_session=valid-session' }, redirect: 'manual' });
      assert.equal(response.status, 302, route);
      assert.equal(response.headers.get('location'), '/app');
    }
  }, sessions);
});

test('Origin validation does not trust a matching Referer or Sec-Fetch-Site header', async () => {
  const config = loadServerConfig({});
  await withServer(config, async (base) => {
    const spoofed = await fetch(`${base}/api/health`, { headers: {
      Origin: 'https://attacker.example', Referer: 'https://attacker.example/page', 'Sec-Fetch-Site': 'same-origin',
    } });
    assert.equal(spoofed.status, 403);
    assert.deepEqual(await spoofed.json(), { error: 'origin_not_allowed' });
    for (const origin of ['null', 'https://user@127.0.0.1', 'https://127.0.0.1/path']) {
      const response = await fetch(`${base}/api/health`, { headers: { Origin: origin } });
      assert.equal(response.status, 403, origin);
    }
    const spoofedProxyHost = await fetch(`${base}/api/health`, { headers: {
      Origin: 'https://attacker.example', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https',
    } });
    assert.equal(spoofedProxyHost.status, 403);
    const sameProxyOrigin = `https://${new URL(base).host}`;
    const forwardedProxy = await fetch(`${base}/api/health`, { headers: {
      Origin: sameProxyOrigin, 'X-Forwarded-Proto': 'https',
    } });
    assert.equal(forwardedProxy.status, 200);
    assert.equal((await forwardedProxy.json()).service, 'keus-web');
  });
});

test('PayPal helper refuses live mode even when imported outside the server', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./apps/web/lib/paypal/endpoints.mjs')"],
    {
      cwd: new URL('../..', import.meta.url),
      env: { ...process.env, PAYPAL_ENV: 'live' },
      encoding: 'utf8',
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIVE_PAYMENTS_DISABLED/);
});

test('database client keeps secrets server-side and requires a token for remote Turso', () => {
  assert.throws(() => createDatabaseClient({ url: 'libsql://db.example.turso.io' }), DatabaseConfigurationError);
  let captured;
  const remote = createDatabaseClient({
    url: 'libsql://db.example.turso.io',
    authToken: 'server-secret',
    clientFactory: (config) => { captured = config; return { marker: true }; },
  });
  assert.equal(remote.marker, true);
  assert.equal(captured.authToken, 'server-secret');
  const local = createDatabaseClient({
    url: 'file:./local.db',
    authToken: 'must-not-be-forwarded',
    clientFactory: (config) => { captured = config; return { marker: true }; },
  });
  assert.equal(local.marker, true);
  assert.equal('authToken' in captured, false);
});
