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
  });
  assert.equal(config.paypalMode, 'sandbox');
  assert.equal(config.paypalConfigured, true);
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(JSON.stringify(config).includes('not-returned'), false);
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
    assert.equal(body.version, '2.3.5');
    assert.deepEqual(body.surfaces, ['marketing:/', 'dashboard:/app', 'onboarding:/onboarding']);
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
  const files = ['landing.html', 'dashboard.html', 'login.html', 'onboarding.html', 'pocket.html', 'api-hub.html', 'auth-verify.html'];
  const forbiddenGlyphs = [0x2713, 0x2726, 0x2315, 0x2667, 0x2197, 0x2022].map((codePoint) => String.fromCodePoint(codePoint));
  for (const file of files) {
    const html = readFileSync(new URL(`../../apps/web/public/${file}`, import.meta.url), 'utf8');
    assert.equal(html.includes(String.fromCodePoint(0x2014)), false, `${file} contains an em dash`);
    assert.doesNotMatch(html, /&mdash;|&#(?:8212|x2014);/i, file);
    for (const character of html) {
      const codePoint = character.codePointAt(0);
      assert.ok(!(codePoint >= 0x1f000 && codePoint <= 0x1faff) && !(codePoint >= 0x2600 && codePoint <= 0x27bf), `${file} contains a pictographic symbol`);
    }
    for (const glyph of forbiddenGlyphs) assert.equal(html.includes(glyph), false, `${file} contains a decorative text glyph`);
  }
});

test('public landing and authenticated dashboard have separate page routes', async () => {
  await withServer(loadServerConfig({}), async (base) => {
    for (const route of ['/', '/app', '/dashboard', '/onboarding', '/login', '/auth/verify']) {
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
    assert.doesNotMatch(landing, /api\/auth\/session/);
    assert.match(landing, /id="headerAccountLink" href="\/login">Sign in/);
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
    const login = await (await fetch(`${base}/login`)).text();
    assert.match(login, /rel="icon"[^>]+href="\/keus-icon\.svg"/);
    assert.match(login, /id="themeToggle"/);
    assert.match(login, /localStorage\.getItem\('keusTheme'\)/);
    assert.match(login, /auth-theme-toggle/);
    const onboarding = await (await fetch(`${base}/onboarding`)).text();
    assert.match(onboarding, /window\.location\.href='\/app'/);
    assert.match(onboarding, /window\.location\.replace\('\/app'\)/);
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
    assert.doesNotMatch(signedInHtml, /api\/auth\/session/);

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
    for (const route of ['/app', '/dashboard', '/desktop', '/desktop.html', '/onboarding']) {
      const noStorage = await fetch(`${base}${route}`, { redirect: 'manual' });
      assert.equal(noStorage.status, 503, route);
      assert.deepEqual(await noStorage.json(), { error: 'auth_storage_not_configured' });
    }
  });
  const sessions = { async getSession({ token }) { return token === 'valid-session' ? { id: 'user-1' } : null; } };
  await withServer(production, async (base) => {
    assert.equal((await fetch(`${base}/`, { headers: { Cookie: '__Host-kues_session=invalid' } })).status, 200);
    for (const route of ['/app', '/dashboard', '/desktop', '/desktop.html', '/onboarding']) {
      const response = await fetch(`${base}${route}`, { redirect: 'manual' });
      assert.equal(response.status, 302, route);
      assert.equal(response.headers.get('location'), '/login?auth_error=session');
      assert.equal((await fetch(`${base}${route}`, { headers: { Cookie: '__Host-kues_session=invalid' }, redirect: 'manual' })).status, 302);
    }
    const login = await fetch(`${base}/login`);
    assert.equal(login.status, 200);
  }, sessions);
  await withServer(production, async (base) => {
    for (const route of ['/app', '/dashboard', '/onboarding']) {
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
