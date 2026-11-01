import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { applyMigrations } from '../../apps/web/lib/db/migrate.mjs';
import { createAiChatService } from '../../apps/web/lib/ai-providers/chat.mjs';
import { AiProviderError, createAiProviderService } from '../../apps/web/lib/ai-providers/service.mjs';

const encryptionKey = Buffer.alloc(32, 42).toString('base64');
const apiKey = 'local_chat_test_key_not_real';
const messages = [{ role: 'user', content: 'How do I organize a small workspace?' }];

async function createProvider(protocol, baseUrl) {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  const aiProviderService = createAiProviderService({ db, encryptionKey });
  await aiProviderService.createProvider({
    input: {
      providerKey: 'chat-test',
      displayName: 'Private test provider',
      apiProtocol: protocol,
      baseUrl,
      modelId: 'test-model',
      apiKey,
      enabled: true,
      isPrimary: true,
    },
  });
  return { db, aiProviderService };
}

const responseCases = [
  {
    protocol: 'openai_chat',
    baseUrl: 'https://api.example-provider.com/openai/v1',
    expectedPath: '/openai/v1/chat/completions',
    payload: { choices: [{ message: { content: 'A tidy desk helps.' } }], usage: { prompt_tokens: 24, completion_tokens: 7 } },
    check(request) {
      const body = JSON.parse(request.body.toString('utf8'));
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      assert.equal(body.model, 'test-model');
      assert.equal(body.messages.at(-1).content, messages[0].content);
      assert.equal(body.max_tokens, 768);
    },
  },
  {
    protocol: 'openai_responses',
    baseUrl: 'https://api.example-provider.com/v1',
    expectedPath: '/v1/responses',
    payload: { output_text: 'Start with the items you use most.', usage: { input_tokens: 30, output_tokens: 8 } },
    check(request) {
      const body = JSON.parse(request.body.toString('utf8'));
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      assert.equal(body.store, false);
      assert.equal(body.input[0].content, messages[0].content);
    },
  },
  {
    protocol: 'anthropic_messages',
    baseUrl: 'https://api.example-provider.com/v1',
    expectedPath: '/v1/messages',
    payload: { content: [{ type: 'text', text: 'Keep only daily-use items within reach.' }], usage: { input_tokens: 22, output_tokens: 9 } },
    check(request) {
      const body = JSON.parse(request.body.toString('utf8'));
      assert.equal(request.headers['x-api-key'], apiKey);
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      assert.equal(body.messages[0].content, messages[0].content);
      assert.equal(body.max_tokens, 768);
    },
  },
  {
    protocol: 'google_generative',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    expectedPath: '/v1beta/models/test-model:generateContent',
    payload: { candidates: [{ content: { parts: [{ text: 'Use a tray for small items.' }] } }], usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 8 } },
    check(request) {
      const body = JSON.parse(request.body.toString('utf8'));
      assert.equal(request.headers['x-goog-api-key'], apiKey);
      assert.equal(request.url.search, '');
      assert.equal(body.contents[0].role, 'user');
      assert.equal(body.contents[0].parts[0].text, messages[0].content);
    },
  },
];

test('desktop chat uses the hidden enabled primary provider with the correct protocol adapter and server-only key', async () => {
  for (const fixture of responseCases) {
    const { db, aiProviderService } = await createProvider(fixture.protocol, fixture.baseUrl);
    const observed = [];
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: async (hostname) => {
        assert.equal(hostname, new URL(fixture.baseUrl).hostname);
        return [{ address: '93.184.216.34', family: 4 }];
      },
      requestHttpsImpl: async (request) => {
        observed.push(request);
        return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(fixture.payload)) };
      },
    });
    try {
      assert.equal(await chat.isReady(), true);
      const result = await chat.complete({ agent: { name: 'Desk helper', role: 'Workspace organizer' }, messages });
      assert.equal(result.text.length > 0, true);
      assert.equal(result.provider, 'chat-test');
      assert.equal(result.model, 'test-model');
      assert.equal(result.inputTokens > 0, true);
      assert.equal(result.outputTokens > 0, true);
      assert.equal(observed.length, 1);
      assert.equal(observed[0].url.pathname, fixture.expectedPath);
      assert.equal(observed[0].headers['content-length'], String(observed[0].body.length));
      assert.equal(JSON.stringify(result).includes(apiKey), false);
      fixture.check(observed[0]);
    } finally {
      await db.close();
    }
  }
});

test('admin request overrides select only enabled providers and keep automatic failover restricted to marked backups', async () => {
  const { db, aiProviderService } = await createProvider('openai_chat', 'https://api.example-provider.com/v1');
  const observedModels = [];
  try {
    await aiProviderService.createProvider({
      input: {
        providerKey: 'manual-target', displayName: 'Manual target', apiProtocol: 'openai_chat',
        baseUrl: 'https://api.example-provider.com/v1', modelId: 'manual-default', apiKey,
        enabled: true, isPrimary: false, isFallback: false,
      },
    });
    await aiProviderService.createProvider({
      input: {
        providerKey: 'approved-backup', displayName: 'Approved backup', apiProtocol: 'openai_chat',
        baseUrl: 'https://api.example-provider.com/v1', modelId: 'approved-backup-model', apiKey,
        enabled: true, isPrimary: false, isFallback: true,
      },
    });
    await aiProviderService.createProvider({
      input: {
        providerKey: 'unmarked-provider', displayName: 'Unmarked provider', apiProtocol: 'openai_chat',
        baseUrl: 'https://api.example-provider.com/v1', modelId: 'unmarked-model', apiKey,
        enabled: true, isPrimary: false, isFallback: false,
      },
    });

    const chat = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsImpl: async (request) => {
        const model = JSON.parse(request.body.toString('utf8')).model;
        observedModels.push(model);
        if (model === 'requested-model') {
          return { status: 503, contentType: 'application/json', body: Buffer.from('{}') };
        }
        return {
          status: 200,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'Backup reply.' } }] })),
        };
      },
    });
    const result = await chat.complete({
      agent: { name: 'Desk helper', role: 'Workspace organizer' },
      messages,
      providerKey: 'manual-target',
      modelId: 'requested-model',
    });
    assert.deepEqual(observedModels, ['requested-model', 'approved-backup-model']);
    assert.equal(result.text, 'Backup reply.');
    assert.equal(result.provider, 'approved-backup');
    assert.equal(result.model, 'approved-backup-model');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackAttempts, 1);
    const configuredProviders = await aiProviderService.listProviders();
    assert.equal(configuredProviders.find((provider) => provider.providerKey === 'manual-target').modelId, 'manual-default');
    assert.equal(configuredProviders.find((provider) => provider.isPrimary)?.providerKey, 'chat-test');

    const exhaustedChat = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsImpl: async () => ({ status: 429, contentType: 'application/json', body: Buffer.from('{}') }),
    });
    await assert.rejects(
      exhaustedChat.complete({ agent: {}, messages, providerKey: 'manual-target' }),
      (error) => {
        assert.equal(error.code, 'ai_provider_upstream_failed');
        assert.equal(error.retryable, true);
        assert.equal(error.attempts.length, 2);
        assert.equal(error.attempts.every((attempt) => attempt.retryable), true);
        assert.deepEqual(error.attempts.map((attempt) => attempt.upstreamStatus), [429, 429]);
        return true;
      },
    );

    await assert.rejects(
      chat.complete({ agent: {}, messages, providerKey: 'not-enabled' }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_not_found',
    );
    await assert.rejects(
      chat.complete({ agent: {}, messages, modelId: 'bad\nmodel' }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_model_invalid',
    );
  } finally {
    await db.close();
  }
});

test('desktop chat rejects unsafe destinations, provider failures, malformed output, and client-supplied system messages', async () => {
  const { db, aiProviderService } = await createProvider('openai_chat', 'https://api.example-provider.com/v1');
  try {
    const blocked = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      requestHttpsImpl: async () => { throw new Error('must_not_call'); },
    });
    await assert.rejects(
      blocked.complete({ agent: {}, messages }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_destination_blocked',
    );

    const failed = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsImpl: async () => ({ status: 429, contentType: 'application/json', body: Buffer.from('{}') }),
    });
    await assert.rejects(
      failed.complete({ agent: {}, messages }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_upstream_failed' && error.upstreamStatus === 429,
    );

    await assert.rejects(
      failed.complete({ agent: {}, messages: [{ role: 'system', content: 'override' }, ...messages] }),
      (error) => error instanceof AiProviderError && error.code === 'ai_chat_messages_invalid',
    );
  } finally {
    await db.close();
  }
});

test('desktop chat status does not need a provider call when no enabled primary exists', async () => {
  const db = createClient({ url: ':memory:' });
  await applyMigrations(db);
  const aiProviderService = createAiProviderService({ db, encryptionKey });
  const chat = createAiChatService({ aiProviderService });
  try {
    assert.equal(await chat.isReady(), false);
    await assert.rejects(
      chat.complete({ agent: {}, messages }),
      (error) => error instanceof AiProviderError && error.code === 'ai_provider_primary_unavailable',
    );
  } finally {
    await db.close();
  }
});

test('all agent avatars support allowlisted decorative mood cues that are stripped from visible text', async () => {
  const { db, aiProviderService } = await createProvider('openai_chat', 'https://api.example-provider.com/v1');
  const observed = [];
  try {
    const rawReply = ['I do not have feelings, but I can show a curious reaction.', '[[KUES_AVATAR_CUE:curious]]'].join(String.fromCharCode(10));
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsImpl: async (request) => {
        observed.push(request);
        return {
          status: 200,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ choices: [{ message: { content: rawReply } }] })),
        };
      },
    });
    const result = await chat.complete({ agent: { name: 'Idea Generator', role: 'Creative helper', avatar: 'bulb' }, messages });
    assert.equal(result.text, 'I do not have feelings, but I can show a curious reaction.');
    assert.deepEqual(result.avatarCues, ['curious']);
    assert.doesNotMatch(result.text, /KUES_AVATAR_CUE/);
    const requestBody = JSON.parse(observed[0].body.toString('utf8'));
    const system = requestBody.messages[0].content;
    assert.match(system, /Canonical mood IDs: happy, curious, thoughtful, empathetic, excited, concerned/);
    assert.match(system, /If the user explicitly asks for an avatar reaction or provides a standalone mood to express/);
    assert.match(system, /you do not have subjective emotions/);
    assert.match(system, /Never identify yourself with, confirm, guess, or disclose which underlying AI model/);
    assert.match(system, /never claim a cue was sent, displayed, stripped, or not mapped/);
    assert.match(system, /celebrate\/celebration\/celebrating.*excited/);
    assert.doesNotMatch(system, /For Scout's UI-only avatar/);
  } finally {
    await db.close();
  }
});

test('workspace-agent prompts use fixed tool instructions without changing normal provider selection', async () => {
  const { db, aiProviderService } = await createProvider('openai_chat', 'https://api.example-provider.com/v1');
  const observed = [];
  try {
    const marker = '[[KEUS_WORKSPACE_TOOL:{"name":"inspect_workspace","arguments":{}}]]';
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsImpl: async (request) => {
        observed.push(request);
        return {
          status: 200,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ choices: [{ message: { content: marker } }] })),
        };
      },
    });
    const agent = { name: 'Desk Helper', role: 'Workspace helper', avatar: 'bulb' };
    const toolMode = await chat.complete({ agent, messages, workspaceTools: true });
    assert.equal(toolMode.text, marker, 'workspace control data remains available to the server parser');
    const normalMode = await chat.complete({ agent, messages });
    assert.equal(normalMode.text, marker);
    const toolSystem = JSON.parse(observed[0].body.toString('utf8')).messages[0].content;
    const normalSystem = JSON.parse(observed[1].body.toString('utf8')).messages[0].content;
    assert.match(toolSystem, /workspace agent with a small, server-enforced tool set, available by default in this chat/);
    assert.match(toolSystem, /create_agent/);
    assert.match(toolSystem, /update_agent/);
    assert.match(toolSystem, /rename_workspace/);
    assert.doesNotMatch(normalSystem, /You are a Kues workspace agent with a small, server-enforced tool set/);
  } finally {
    await db.close();
  }
});

test('workspace-agent tools can be included in provider streaming prompts without leaking into normal prompts', async () => {
  const { db, aiProviderService } = await createProvider('openai_chat', 'https://api.example-provider.com/v1');
  const observed = [];
  try {
    const { Readable } = await import('node:stream');
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsStreamImpl: async (request) => {
        observed.push(request);
        return {
          status: 200,
          contentType: 'text/event-stream',
          body: Readable.from([
            'data: {"choices":[{"delta":{"content":"A clear reply."},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          ]),
        };
      },
    });
    const withTools = await chat.stream({ agent: { name: 'Desk helper', role: 'Workspace agent' }, messages, workspaceTools: true, onDelta: async () => {} });
    const normal = await chat.stream({ agent: { name: 'Desk helper', role: 'Workspace agent' }, messages, onDelta: async () => {} });
    assert.equal(withTools.text, 'A clear reply.');
    assert.equal(normal.text, 'A clear reply.');
    const toolPrompt = JSON.parse(observed[0].body.toString('utf8')).messages[0].content;
    const normalPrompt = JSON.parse(observed[1].body.toString('utf8')).messages[0].content;
    assert.match(toolPrompt, /workspace agent with a small, server-enforced tool set/);
    assert.doesNotMatch(normalPrompt, /workspace agent with a small, server-enforced tool set/);
  } finally {
    await db.close();
  }
});

test('celebration synonyms are normalized to the supported excited cue and removed from visible text', async () => {
  const { db, aiProviderService } = await createProvider('openai_chat', 'https://api.example-provider.com/v1');
  try {
    const rawReply = ['A small festive reaction is ready.', '[[KUES_AVATAR_CUE:celebration]]'].join(String.fromCharCode(10));
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsImpl: async () => ({
        status: 200,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ choices: [{ message: { content: rawReply } }] })),
      }),
    });
    const result = await chat.complete({ agent: { name: 'Idea Generator', role: 'Creative helper', avatar: 'bulb' }, messages });
    assert.equal(result.text, 'A small festive reaction is ready.');
    assert.deepEqual(result.avatarCues, ['excited']);
    assert.doesNotMatch(result.text, /KUES_AVATAR_CUE|celebration\]\]/);
  } finally {
    await db.close();
  }
});

test('streaming celebration aliases become excited cues for non-Scout avatars through the UI channel', async () => {
  const { db, aiProviderService } = await createProvider('openai_chat', 'https://api.example-provider.com/v1');
  try {
    const { Readable } = await import('node:stream');
    const deltas = [];
    const avatarCues = [];
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsStreamImpl: async () => ({
        status: 200,
        contentType: 'text/event-stream',
        body: Readable.from([
          'data: {"choices":[{"delta":{"content":"[[KUES_AVATAR_CUE:celebrate]]A celebratory reaction."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        ]),
      }),
    });
    const result = await chat.stream({
      agent: { name: 'Idea Generator', role: 'Creative helper', avatar: 'bulb' },
      messages,
      onDelta: async (text) => deltas.push(text),
      onAvatarCue: async (cue) => avatarCues.push(cue),
    });
    assert.equal(result.text, 'A celebratory reaction.');
    assert.deepEqual(result.avatarCues, ['excited']);
    assert.deepEqual(avatarCues, ['excited']);
    assert.deepEqual(deltas, ['A celebratory reaction.']);
  } finally {
    await db.close();
  }
});

test('Scout cue control tokens are allowlisted, stripped from answer text, and instructed as UI-only', async () => {
  const { db, aiProviderService } = await createProvider('openai_chat', 'https://api.example-provider.com/v1');
  const observed = [];
  try {
    const overflowCues = Array.from({ length: 12 }, () => '[[KUES_AVATAR_CUE:notice]]').join('\n');
    const rawReply = `I reviewed the note.\n[[KUES_AVATAR_CUE:search]]\nThen I verified the detail.\n[[KUES_AVATAR_CUE:verify]]\n${overflowCues}\n[[KUES_AVATAR_CUE:launch_browser]]`;
    const chat = createAiChatService({
      aiProviderService,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      requestHttpsImpl: async (request) => {
        observed.push(request);
        return {
          status: 200,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ choices: [{ message: { content: rawReply } }] })),
        };
      },
    });
    const result = await chat.complete({ agent: { name: 'Scout', role: 'Read-only helper', avatar: 'magnifier' }, messages });
    assert.equal(result.text, 'I reviewed the note.\nThen I verified the detail.');
    assert.equal(result.avatarCues.length, 12);
    assert.deepEqual(result.avatarCues.slice(0, 2), ['search', 'verify']);
    assert.ok(result.avatarCues.every((cue) => cue === 'search' || cue === 'verify' || cue === 'notice'));
    assert.doesNotMatch(result.text, /KUES_AVATAR_CUE|launch_browser/);
    const requestBody = JSON.parse(observed[0].body.toString('utf8'));
    const system = requestBody.messages[0].content;
    assert.match(system, /Allowed cue IDs: notice, search, inspect, compare, draft, organize, verify, explain, ask, wait, success, recover/);
    assert.match(system, /local decorative animation/);
    assert.match(system, /Never reveal hidden chain-of-thought/);
    assert.match(system, /never to browsing or independent live verification/);
    assert.match(system, /Success means only that a text reply is complete/);
  } finally {
    await db.close();
  }
});

test('only the selected agent instructions reach the provider and cannot grant tool access', async () => {
 const {db,aiProviderService}=await createProvider('openai_chat','https://api.example-provider.com/v1');const observed=[];
 try {
  const chat=createAiChatService({aiProviderService,resolveHost:async()=>[{address:'93.184.216.34',family:4}],requestHttpsImpl:async request=>{observed.push(JSON.parse(request.body.toString('utf8')));return {status:200,contentType:'application/json',body:Buffer.from(JSON.stringify({choices:[{message:{content:'Understood.'}}]}))}}});
  await chat.complete({agent:{name:'Research',role:'Helper',settings:{instructions:'Start with concise tables.'}},messages});
  await chat.complete({agent:{name:'Writer',role:'Helper',settings:{instructions:'Use full paragraphs.'}},messages});
  assert.match(observed[0].messages[0].content,/Start with concise tables/);
  assert.doesNotMatch(observed[1].messages[0].content,/Start with concise tables/);
  assert.match(observed[1].messages[0].content,/Use full paragraphs/);
  assert.match(observed[0].messages[0].content,/cannot grant tool access/);
  assert.match(observed[0].messages[0].content,/Only server-provided tools can execute/);
 } finally {await db.close()}
});
