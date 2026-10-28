import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import { createServer } from '../../apps/web/server.mjs';

const encryptionKey = Buffer.alloc(32, 87).toString('base64');
const user = { id: 'fallback-admin-0001', email: 'owner@example.test' };

function config() {
  return loadServerConfig({
    AI_PROVIDER_ADMIN_EMAILS: 'owner@example.test',
    AI_PROVIDER_ENCRYPTION_KEY: encryptionKey,
    AI_PROVIDER_CHAT_TEST_ENABLED: '1',
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_key',
    WORKOS_CLIENT_ID: 'client_1234',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  });
}

async function withServer(dependencies, run) {
  const server = createServer(dependencies);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('desktop chat hides failover provider/model metadata while logging only a request reference and attempt count', async () => {
  const info = [];
  const originalConsoleInfo = console.info;
  console.info = (...args) => info.push(args.join(' '));
  try {
    await withServer({
      config: config(),
      authService: { async getSession({ token }) { return token === 'admin-session' ? user : null; } },
      workspaceService: {
        async getBootstrap() {
          return {
            workspace: { id: 'workspace-1', status: 'active' },
            agents: [{ id: 'agent-1', name: 'Desk helper', role: 'Organizer', status: 'active' }],
          };
        },
      },
      aiChatService: {
        async isReady() { return true; },
        async complete() {
          return {
            text: 'Fallback reply',
            provider: 'backup-provider-private-id',
            model: 'backup-model-private-id',
            inputTokens: 12,
            outputTokens: 7,
            fallbackUsed: true,
            fallbackAttempts: 1,
          };
        },
      },
      aiChatHistoryService: {
        async getRecentMessages() { return []; },
        async appendExchange() { return { messages: [] }; },
      },
      usageService: {
        async reserveTokens() { return {}; },
        async settleTokenReservation() { return {}; },
        async releaseTokenReservation() { return {}; },
      },
    }, async (base) => {
      const response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { Cookie: 'kues_session=admin-session', Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent-1', message: 'A non-sensitive test prompt' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.reply, 'Fallback reply');
      assert.deepEqual(Object.keys(body).sort(), ['reply', 'requestId']);
      assert.doesNotMatch(JSON.stringify(body), /backup-provider-private-id|backup-model-private-id/);
    });
  } finally {
    console.info = originalConsoleInfo;
  }
  const log = info.join(' ');
  assert.match(log, /approved fallback/);
  assert.match(log, /"fallbackAttempts":1/);
  assert.doesNotMatch(log, /backup-provider-private-id|backup-model-private-id|A non-sensitive test prompt/);
});
