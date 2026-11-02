import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAuthService } from '../../apps/web/lib/auth/service.mjs';
import { createWorkspaceService } from '../../apps/web/lib/workspaces/service.mjs';
import { createServer } from '../../apps/web/server.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
import {
  createPurchaseMandate,
} from '../../apps/web/lib/channel3/mandate-service.mjs';
import {
  createPasskeyRegistrationOptions,
  verifyAndSavePasskeyRegistration,
  listUserPasskeys,
  revokePasskey,
  getMandatePasskeyChallenge,
  verifyMandatePasskeyApproval,
} from '../../apps/web/lib/auth/passkey-service.mjs';
import { linkWorkspaceWallet } from '../../apps/web/lib/paypal/service.mjs';

async function setupPasskeyTestEnvironment() {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);

  const authService = createAuthService({ db });
  const workspaceService = createWorkspaceService({ db });

  const session = await authService.createWorkOSSession({
    providerSubject: 'sub_passkey_tester',
    email: 'passkey-tester@example.com',
    emailVerified: true,
    displayName: 'Passkey Tester',
  });

  const bootstrap = await workspaceService.getBootstrap({ userId: session.user.id });
  const wsId = bootstrap.workspace.id;
  const userId = session.user.id;

  let agentId = bootstrap.agents[0]?.id;
  if (!agentId) {
    const created = await workspaceService.createAgent({
      userId,
      input: {
        name: 'Procure Scout',
        role: 'Autonomous buyer',
        avatar: 'cart',
        color: '#4c8dff',
        approvalPath: 'desktop',
        orderCap: 150,
        dailyCap: 500,
        apps: ['channel3', 'paypal'],
        memoryPills: [],
      },
    });
    agentId = created.createdAgentId || created.agents?.[0]?.id;
  }

  await linkWorkspaceWallet({
    db,
    workspaceId: wsId,
    userId,
    setupTokenId: 'ST-PASSKEY-TEST-WALLET',
    payerEmail: 'passkey-buyer@personal.example.com',
    simulate: true,
  });

  return { db, authService, workspaceService, session, wsId, userId, agentId };
}

async function withServer(fn) {
  const { db, authService, workspaceService, session, wsId, userId, agentId } = await setupPasskeyTestEnvironment();
  const server = createServer({
    config: {
      isProduction: false,
      isStaging: false,
      secureCookies: false,
      serverPort: 0,
      host: '127.0.0.1',
    },
    authService,
    workspaceService,
    db,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    await fn({ origin, sessionToken: session.sessionToken, wsId, userId, agentId, db });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Passkey Registration: Generates challenge and stores public key in passkey_credentials', async () => {
  const { db, userId } = await setupPasskeyTestEnvironment();

  const options = await createPasskeyRegistrationOptions({
    db,
    userId,
    userEmail: 'passkey-tester@example.com',
    rpId: 'localhost',
  });

  assert.ok(options.challenge);
  assert.equal(options.rp.id, 'localhost');
  assert.equal(options.rp.name, 'Keus Desktop');

  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const credResult = await verifyAndSavePasskeyRegistration({
    db,
    userId,
    credential: {
      id: 'cred_touchid_macbook_01',
      publicKey: spkiDer,
      label: 'MacBook Touch ID',
      transports: ['internal'],
      challenge: options.challenge,
    },
    rpId: 'localhost',
  });

  assert.equal(credResult.success, true);
  assert.equal(credResult.credentialId, 'cred_touchid_macbook_01');
  assert.equal(credResult.label, 'MacBook Touch ID');

  const list = await listUserPasskeys({ db, userId });
  assert.equal(list.length, 1);
  assert.equal(list[0].credentialId, 'cred_touchid_macbook_01');
  assert.equal(list[0].label, 'MacBook Touch ID');
});

test('Mandate Challenge: Retrieves cryptographic challenge_hash for WebAuthn assertion', async () => {
  const { db, wsId, userId, agentId } = await setupPasskeyTestEnvironment();

  await verifyAndSavePasskeyRegistration({
    db,
    userId,
    credential: {
      id: 'cred_windows_hello_01',
      label: 'Windows Hello Biometrics',
      transports: ['internal'],
    },
  });

  const mandate = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Ergonomic Desk Mat',
      merchantDomain: 'target.com',
      amountMinor: 3500,
      currency: 'USD',
      evidenceHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    },
  });

  const chalResult = await getMandatePasskeyChallenge({
    db,
    workspaceId: wsId,
    mandateId: mandate.mandateId,
    userId,
  });

  assert.equal(chalResult.mandateId, mandate.mandateId);
  assert.equal(chalResult.challenge, mandate.challengeHash);
  assert.equal(chalResult.allowCredentials.length, 1);
  assert.equal(chalResult.allowCredentials[0].id, 'cred_windows_hello_01');
});

test('Mandate Passkey Approval: Verifies real ECDSA signature against mandate challenge', async () => {
  const { db, wsId, userId, agentId } = await setupPasskeyTestEnvironment();

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  await verifyAndSavePasskeyRegistration({
    db,
    userId,
    credential: {
      id: 'cred_yubikey_hardware_01',
      publicKey: spkiDer,
      label: 'YubiKey 5C NFC',
      transports: ['usb', 'nfc'],
    },
  });

  const mandate = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Mechanical Keychron Keyboard',
      merchantDomain: 'target.com',
      amountMinor: 8900,
      currency: 'USD',
      evidenceHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    },
  });

  const challengeBuf = Buffer.from(mandate.challengeHash, 'utf8');
  const signature = crypto.sign('sha256', challengeBuf, privateKey);
  const signatureB64Url = signature.toString('base64url');

  const verified = await verifyMandatePasskeyApproval({
    db,
    workspaceId: wsId,
    mandateId: mandate.mandateId,
    userId,
    credentialId: 'cred_yubikey_hardware_01',
    signature: signatureB64Url,
  });

  assert.equal(verified.verified, true);
  assert.equal(verified.status, 'authorized');
  assert.equal(verified.credentialId, 'cred_yubikey_hardware_01');

  const creds = await listUserPasskeys({ db, userId });
  assert.ok(creds[0].lastUsedAt);

  await assert.rejects(
    async () => {
      await verifyMandatePasskeyApproval({
        db,
        workspaceId: wsId,
        mandateId: mandate.mandateId,
        userId,
        credentialId: 'cred_yubikey_hardware_01',
        signature: signatureB64Url,
      });
    },
    { name: 'PasskeyError', code: 'mandate_already_processed' }
  );
});

test('Revocation: Revoking a passkey prevents subsequent signature verification', async () => {
  const { db, wsId, userId, agentId } = await setupPasskeyTestEnvironment();

  await verifyAndSavePasskeyRegistration({
    db,
    userId,
    credential: {
      id: 'cred_old_device_01',
      label: 'Old Device',
    },
  });

  const revokeRes = await revokePasskey({
    db,
    userId,
    credentialId: 'cred_old_device_01',
  });
  assert.equal(revokeRes.revoked, true);

  const active = await listUserPasskeys({ db, userId });
  assert.equal(active.length, 0);

  const mandate = await createPurchaseMandate({
    db,
    workspaceId: wsId,
    userId,
    agentId,
    product: {
      title: 'Desk Lamp',
      merchantDomain: 'target.com',
      amountMinor: 2500,
      currency: 'USD',
      evidenceHash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    },
  });

  await assert.rejects(
    async () => {
      await verifyMandatePasskeyApproval({
        db,
        workspaceId: wsId,
        mandateId: mandate.mandateId,
        userId,
        credentialId: 'cred_old_device_01',
        simulate: true,
      });
    },
    { name: 'PasskeyError', code: 'passkey_credential_invalid' }
  );
});

test('HTTP passkey registration remains available but legacy payment execution is disabled', async () => {
  await withServer(async ({ origin, sessionToken, wsId, userId, agentId, db }) => {
    const authHeaders = {
      Cookie: `kues_session=${sessionToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Get registration options
    const optRes = await fetch(`${origin}/api/commerce/passkeys/register/options`, {
      method: 'POST',
      headers: authHeaders,
    });
    assert.equal(optRes.status, 200);
    const optData = await optRes.json();
    assert.ok(optData.ok);
    assert.ok(optData.options.challenge);

    // 2. Register passkey
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
    const regRes = await fetch(`${origin}/api/commerce/passkeys/register/verify`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        credential: {
          id: 'cred_http_biometric_01',
          publicKey: spkiDer.toString('base64url'),
          label: 'Touch ID Pro',
          challenge: optData.options.challenge,
        },
      }),
    });
    assert.equal(regRes.status, 201);
    const regData = await regRes.json();
    assert.ok(regData.ok);
    assert.equal(regData.credentialId, 'cred_http_biometric_01');

    // 3. List passkeys
    const listRes = await fetch(`${origin}/api/commerce/passkeys`, {
      headers: authHeaders,
    });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.passkeys.length, 1);
    assert.equal(listData.passkeys[0].credentialId, 'cred_http_biometric_01');

    // 4. Create mandate within agent order cap ($150.00)
    const mandate = await createPurchaseMandate({
      db,
      workspaceId: wsId,
      userId,
      agentId,
      product: {
        title: 'Dell 27-inch Monitor',
        merchantDomain: 'dell.com',
        amountMinor: 8900,
        currency: 'USD',
        evidenceHash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      },
    });
    assert.ok(mandate.allowed);
    assert.ok(mandate.mandateId);

    // 5. Get passkey challenge for mandate
    const chalRes = await fetch(`${origin}/api/commerce/mandates/${mandate.mandateId}/passkey-challenge`, {
      headers: authHeaders,
    });
    assert.equal(chalRes.status, 200);
    const chalData = await chalRes.json();
    assert.equal(chalData.challenge, mandate.challengeHash);
    assert.equal(chalData.allowCredentials[0].id, 'cred_http_biometric_01');

    // 6. Sign mandate challenge and approve via passkey-approve endpoint
    const sig = crypto.sign('sha256', Buffer.from(mandate.challengeHash, 'utf8'), privateKey);
    const appRes = await fetch(`${origin}/api/commerce/mandates/${mandate.mandateId}/passkey-approve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        credentialId: 'cred_http_biometric_01',
        signature: sig.toString('base64url'),
      }),
    });
    assert.equal(appRes.status,403);
    assert.equal((await appRes.json()).error,'standard_checkout_required');
  });
});

test('Chat purchase review rejects legacy passkey payment bypass', async () => {
  const { db, authService, workspaceService, session, wsId, userId, agentId } = await setupPasskeyTestEnvironment();

  // 1. Register passkey
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  await verifyAndSavePasskeyRegistration({
    db,
    userId,
    credential: {
      id: 'cred_chat_biometric_01',
      publicKey: spkiDer,
      label: 'Chat Hardware Passkey',
    },
  });

  const productEvidence = {
    title: 'Anker USB-C Docking Station',
    merchantDomain: 'amazon.com',
    amountMinor: 6500,
    currency: 'USD',
    evidenceHash: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
  };

  const aiChatService = {
    isReady: async () => true,
    complete: async () => {
      const toolMarker = `[[KEUS_WORKSPACE_TOOL:{"name":"purchase_product","arguments":{"productTitle":"${productEvidence.title}","merchantDomain":"${productEvidence.merchantDomain}","amountMinor":${productEvidence.amountMinor},"currency":"USD","evidenceHash":"${productEvidence.evidenceHash}"}}]]`;
      return {
        text: toolMarker,
        provider: 'mock-provider',
        model: 'mock-model',
        inputTokens: 30,
        outputTokens: 50,
      };
    },
  };

  const usageService = {
    reserveTokens: async () => ({ allowed: true }),
    settleTokenReservation: async () => ({ settled: true }),
    releaseTokenReservation: async () => {},
  };

  const aiChatHistoryService = {
    appendExchange: async () => {},
    getRecentMessages: async () => [],
    recordPendingToolAction: async () => {},
  };

  const aiProviderService = {
    getActiveChatProvider: async () => ({
      providerKey: 'mock-provider',
      modelId: 'mock-model',
    }),
  };

  const config = loadServerConfig({
    AI_PROVIDER_CHAT_TEST_ENABLED: '1',
    AI_PROVIDER_ADMIN_EMAILS: 'passkey-tester@example.com',
    AI_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk_test_wos',
    WORKOS_CLIENT_ID: 'client_wos',
    WORKOS_REDIRECT_URI: 'http://localhost:3100/auth/callback',
    TURSO_DATABASE_URL: 'file:./local.db',
  });

  const server = createServer({
    config,
    authService,
    workspaceService,
    aiChatService,
    usageService,
    aiChatHistoryService,
    aiProviderService,
    db,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    // 2. Send chat request triggering purchase_product proposal
    const chatRes = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId,
        message: 'Buy the Anker USB-C dock',
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.ok(chatData.pendingAction);
    const actionId = chatData.pendingAction.actionId;
    const mandateField = chatData.pendingAction.action.fields.find((f) => f.label === 'Mandate ID');
    assert.ok(mandateField);
    const mandateId = mandateField.value;
    assert.ok(mandateId);

    // 3. Get mandate challenge and sign it
    const chalRes = await fetch(`${base}/api/commerce/mandates/${mandateId}/passkey-challenge`, {
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
      },
    });
    assert.equal(chalRes.status, 200);
    const chalData = await chalRes.json();
    const sig = crypto.sign('sha256', Buffer.from(chalData.challenge, 'utf8'), privateKey);

    // 4. Submit tool approval with passkey signature
    const approvalRes = await fetch(`${base}/api/chat/tool-approval`, {
      method: 'POST',
      headers: {
        Cookie: `kues_session=${session.sessionToken}`,
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        actionId,
        decision: 'approve',
        passkey: {
          credentialId: 'cred_chat_biometric_01',
          signature: sig.toString('base64url'),
        },
      }),
    });
    assert.equal(approvalRes.status, 200);
    const approvalData = await approvalRes.json();
    assert.equal(approvalData.status,'failed');
    assert.equal(approvalData.paymentHold,undefined);
    const record=await db.execute({sql:'SELECT status,credential_id FROM mandate_approvals WHERE mandate_id=?',args:[mandateId]});
    assert.equal(record.rows[0].status,'pending');
    assert.equal(record.rows[0].credential_id,null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
