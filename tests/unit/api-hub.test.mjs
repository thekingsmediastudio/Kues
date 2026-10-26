import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { ApiHubError, createApiHubService } from '../../apps/web/lib/api-hub/service.mjs';

const ownerId = 'owner-api-hub-0001';
const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const now = () => new Date('2026-10-26T12:00:00.000Z');

async function createHub({ fetchImpl, resolveHost } = {}) {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  await db.execute({
    sql: `INSERT INTO users(id, email_normalized, display_name) VALUES (?, ?, ?)`,
    args: [ownerId, 'owner@example.test', 'Owner'],
  });
  const service = createApiHubService({
    db,
    encryptionKey,
    now,
    resolveHost: resolveHost || (async () => [{ address: '93.184.216.34', family: 4 }]),
    fetchImpl: fetchImpl || (async () => ({ status: 200, contentType: 'application/json', body: Buffer.from('{}') })),
  });
  return { db, service };
}

const connectorInput = (overrides = {}) => ({
  name: 'GitHub staging',
  baseUrl: 'https://api.example.com/v1',
  authType: 'bearer',
  authSecret: 'provider-secret-123456',
  defaultHeaders: { Accept: 'application/vnd.github+json' },
  operations: [
    { name: 'get-repository', method: 'GET', path: '/repos/{owner}/{repo}' },
    { name: 'write-file', method: 'PUT', path: '/repos/{owner}/{repo}/contents/{path*}' },
  ],
  ...overrides,
});

test('connector credentials are encrypted at rest and excluded from management views', async () => {
  const { db, service } = await createHub();
  try {
    const created = await service.createConnector({ ownerUserId: ownerId, input: connectorInput() });
    assert.equal(created.name, 'GitHub staging');
    assert.equal(created.authType, 'bearer');
    assert.equal(JSON.stringify(created).includes('provider-secret-123456'), false);

    const stored = await db.execute({
      sql: 'SELECT auth_ciphertext, auth_nonce, auth_tag FROM api_hub_connectors WHERE id = ?',
      args: [created.id],
    });
    assert.equal(stored.rows[0].auth_ciphertext.includes('provider-secret-123456'), false);
    assert.equal(stored.rows[0].auth_ciphertext.includes('application/vnd.github+json'), false);
    assert.equal(stored.rows[0].auth_nonce.length > 0, true);
    assert.equal(stored.rows[0].auth_tag.length > 0, true);

    const duplicate = await service.createConnector({ ownerUserId: ownerId, input: connectorInput() }).catch((error) => error);
    assert.ok(duplicate instanceof ApiHubError);
    assert.equal(duplicate.code, 'connector_name_exists');
  } finally {
    await db.close();
  }
});

test('connector edits preserve existing encrypted credentials and fixed headers unless replaced', async () => {
  const outbound = [];
  const { db, service } = await createHub({
    fetchImpl: async (request) => {
      outbound.push(request);
      return { status: 200, contentType: 'application/json', body: Buffer.from('{"ok":true}') };
    },
  });
  try {
    const created = await service.createConnector({ ownerUserId: ownerId, input: connectorInput() });
    const updated = await service.updateConnector({
      ownerUserId: ownerId,
      connectorId: created.id,
      input: {
        name: 'GitHub Kues',
        baseUrl: 'https://api.example.com/v2',
        authType: 'bearer',
        authSecret: '',
        operations: [{ name: 'get-user', method: 'GET', path: '/users/{username}' }],
      },
    });
    assert.equal(updated.name, 'GitHub Kues');
    assert.equal(updated.baseUrl, 'https://api.example.com/v2/');
    assert.deepEqual(updated.operations.map((item) => item.name), ['get-user']);
    assert.equal(JSON.stringify(updated).includes('provider-secret-123456'), false);

    const access = await service.createAccessToken({
      ownerUserId: ownerId,
      label: 'edited connector read key',
      scopes: [`${created.id}:get-user`],
    });
    await service.invoke({
      token: access.token,
      connectorId: created.id,
      operation: 'get-user',
      pathParams: { username: 'keus' },
    });
    assert.equal(outbound[0].url.toString(), 'https://api.example.com/v2/users/keus');
    assert.equal(outbound[0].headers.authorization, 'Bearer provider-secret-123456');
    assert.equal(outbound[0].headers.accept, 'application/vnd.github+json');

    const replaced = await service.updateConnector({
      ownerUserId: ownerId,
      connectorId: created.id,
      input: {
        name: 'GitHub Kues',
        baseUrl: 'https://api.example.com/v2',
        authType: 'header',
        authHeader: 'X-API-Key',
        authSecret: 'replacement-secret-098765',
        defaultHeaders: {},
        operations: [{ name: 'get-user', method: 'GET', path: '/users/{username}' }],
      },
    });
    assert.equal(replaced.authType, 'header');
    await service.invoke({
      token: access.token,
      connectorId: created.id,
      operation: 'get-user',
      pathParams: { username: 'keus' },
    });
    assert.equal(outbound[1].headers['x-api-key'], 'replacement-secret-098765');
    assert.equal(outbound[1].headers.accept, 'application/json, text/plain;q=0.9');
  } finally {
    await db.close();
  }
});

test('connector edit requires a new secret when changing auth type and remains owner-scoped', async () => {
  const { db, service } = await createHub();
  try {
    const created = await service.createConnector({ ownerUserId: ownerId, input: connectorInput() });
    const changedAuth = {
      name: 'GitHub staging',
      baseUrl: 'https://api.example.com/v1',
      authType: 'header',
      authHeader: 'X-API-Key',
      authSecret: '',
      operations: [{ name: 'get-repository', method: 'GET', path: '/repos/{owner}/{repo}' }],
    };
    await assert.rejects(
      service.updateConnector({ ownerUserId: ownerId, connectorId: created.id, input: changedAuth }),
      (error) => error instanceof ApiHubError && error.code === 'connector_auth_secret_required',
    );
    await assert.rejects(
      service.updateConnector({ ownerUserId: 'other-owner', connectorId: created.id, input: connectorInput() }),
      (error) => error instanceof ApiHubError && error.code === 'connector_not_found',
    );
  } finally {
    await db.close();
  }
});

test('agent keys are hashed, scoped, manifest-limited, and provider responses are redacted', async () => {
  const outbound = [];
  const secret = 'provider-secret-123456';
  const { db, service } = await createHub({
    fetchImpl: async (request) => {
      outbound.push(request);
      return {
        status: 200,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ id: 7, token: 'provider-token', message: `echo ${secret}` })),
      };
    },
  });
  try {
    const connector = await service.createConnector({ ownerUserId: ownerId, input: connectorInput() });
    const access = await service.createAccessToken({
      ownerUserId: ownerId,
      label: 'read agent',
      scopes: [`${connector.id}:get-repository`, `${connector.id}:write-file`],
      expiresInDays: 7,
    });
    assert.match(access.token, /^khub_[A-Za-z0-9_-]{43}$/);

    const storedToken = await db.execute({
      sql: 'SELECT token_hash FROM api_hub_access_tokens WHERE id = ?',
      args: [access.id],
    });
    assert.notEqual(storedToken.rows[0].token_hash, access.token);

    const manifest = await service.listManifest({ token: access.token });
    assert.deepEqual(manifest.connectors[0].operations.map((operation) => operation.name), ['get-repository', 'write-file']);
    assert.equal(JSON.stringify(manifest).includes(secret), false);

    const result = await service.invoke({
      token: access.token,
      connectorId: connector.id,
      operation: 'get-repository',
      pathParams: { owner: 'thekingsmediastudio', repo: 'Kues' },
    });
    assert.equal(result.upstreamStatus, 200);
    assert.equal(result.data.id, 7);
    assert.equal(result.data.token, '[REDACTED]');
    assert.equal(result.data.message, 'echo [REDACTED]');
    assert.equal(outbound[0].url.toString(), 'https://api.example.com/v1/repos/thekingsmediastudio/Kues');
    assert.equal(outbound[0].headers.authorization, `Bearer ${secret}`);
    assert.equal(result.auditLogged, true);

    await assert.rejects(
      service.invoke({ token: access.token, connectorId: connector.id, operation: 'write-file', pathParams: { owner: 'a', repo: 'b', path: 'docs/hello.md' }, body: { content: 'abc' } }),
      (error) => error instanceof ApiHubError && error.code === 'write_confirmation_required'
    );
    const written = await service.invoke({
      token: access.token,
      connectorId: connector.id,
      operation: 'write-file',
      pathParams: { owner: 'a', repo: 'b', path: 'docs/hello.md' },
      body: { content: 'abc' },
      confirmWrite: true,
    });
    assert.equal(written.upstreamStatus, 200);
    assert.equal(outbound[1].method, 'PUT');
    assert.match(outbound[1].url.pathname, /contents\/docs\/hello\.md$/);

    const audit = await service.listAudit({ ownerUserId: ownerId });
    assert.equal(audit.length, 2);
    assert.equal(JSON.stringify(audit).includes(secret), false);
  } finally {
    await db.close();
  }
});

test('agent key cannot call a registered operation outside its exact scopes', async () => {
  const { db, service } = await createHub();
  try {
    const connector = await service.createConnector({ ownerUserId: ownerId, input: connectorInput() });
    const access = await service.createAccessToken({ ownerUserId: ownerId, label: 'read only', scopes: [`${connector.id}:get-repository`] });
    await assert.rejects(
      service.invoke({
        token: access.token,
        connectorId: connector.id,
        operation: 'write-file',
        pathParams: { owner: 'a', repo: 'b', path: 'x.txt' },
        body: { content: 'abc' },
        confirmWrite: true,
      }),
      (error) => error instanceof ApiHubError && error.code === 'agent_scope_denied' && error.status === 403
    );
  } finally {
    await db.close();
  }
});

test('connector registration and invocation block unsafe destinations and URL tricks', async () => {
  const { db, service } = await createHub({
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  try {
    for (const baseUrl of [
      'http://api.example.com',
      'https://127.0.0.1',
      'https://localhost',
      'https://[::1]',
      'https://api.example.com/?token=x',
      'https://api.example.com/%2e%2e/private',
    ]) {
      await assert.rejects(
        service.createConnector({ ownerUserId: ownerId, input: connectorInput({ name: `bad-${baseUrl.length}-${Math.random()}`, baseUrl }) }),
        ApiHubError,
        baseUrl,
      );
    }
    const connector = await service.createConnector({ ownerUserId: ownerId, input: connectorInput() });
    const access = await service.createAccessToken({ ownerUserId: ownerId, label: 'blocked host', scopes: [`${connector.id}:get-repository`] });
    await assert.rejects(
      service.invoke({ token: access.token, connectorId: connector.id, operation: 'get-repository', pathParams: { owner: 'a', repo: 'b' } }),
      (error) => error instanceof ApiHubError && error.code === 'connector_destination_blocked'
    );
  } finally {
    await db.close();
  }
});

test('revoking an agent key makes it unusable and connectors cannot be managed cross-owner', async () => {
  const { db, service } = await createHub();
  try {
    const connector = await service.createConnector({ ownerUserId: ownerId, input: connectorInput() });
    assert.deepEqual(await service.listConnectors({ ownerUserId: 'other-user' }), []);
    const access = await service.createAccessToken({ ownerUserId: ownerId, label: 'temporary', scopes: [`${connector.id}:get-repository`] });
    assert.deepEqual(await service.revokeAccessToken({ ownerUserId: ownerId, tokenId: access.id }), { revoked: true });
    await assert.rejects(service.listManifest({ token: access.token }), (error) => error.code === 'agent_token_invalid');
    await assert.rejects(service.deleteConnector({ ownerUserId: 'other-user', connectorId: connector.id }), (error) => error.code === 'connector_not_found');
  } finally {
    await db.close();
  }
});

test('agent API keys are rate limited per service process', async () => {
  const { db, service } = await createHub();
  try {
    const connector = await service.createConnector({ ownerUserId: ownerId, input: connectorInput() });
    const access = await service.createAccessToken({ ownerUserId: ownerId, label: 'rate-limit test', scopes: [`${connector.id}:get-repository`] });
    for (let index = 0; index < 60; index += 1) await service.listManifest({ token: access.token });
    await assert.rejects(
      service.listManifest({ token: access.token }),
      (error) => error instanceof ApiHubError && error.code === 'agent_rate_limited' && error.status === 429,
    );
  } finally {
    await db.close();
  }
});
