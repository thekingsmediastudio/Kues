import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroqTranscription, validateWav, AUDIO_LIMIT } from '../../apps/web/lib/audio/groq-transcription.mjs';
import { encodeWav } from '../../apps/web/public/local-audio.mjs';
import { createServer } from '../../apps/web/server.mjs';
import { loadServerConfig } from '../../apps/web/lib/config.mjs';
const wav = () => Buffer.from(encodeWav(new Float32Array(16000).fill(0.1)));
test('Groq accepts only bounded, mono 16 kHz PCM WAV from the client encoder', () => {
  assert.equal(validateWav(wav()), 1);
  assert.throws(() => validateWav(Buffer.alloc(AUDIO_LIMIT + 1)));
  const bad = wav(); bad.writeUInt32LE(48000, 24); assert.throws(() => validateWav(bad));
  assert.throws(() => validateWav(Buffer.from('not audio')));
  assert.throws(() => encodeWav(new Float32Array(16000 * 61)));
});
test('Groq service fixes destination/model, protects credentials and performs no retry', async () => {
  let calls = 0;
  const service = createGroqTranscription({ apiKey: 'test-secret-not-real', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer test-secret-not-real');
    assert.equal(options.body.get('model'), 'whisper-large-v3'); assert.equal(options.body.get('file').type, 'audio/wav');
    return new Response(JSON.stringify({ text: ' hello ' }));
  } });
  assert.deepEqual(await service.transcribe(wav()), { text: 'hello', model: 'whisper-large-v3' }); assert.equal(calls, 1);
  const limited = createGroqTranscription({ apiKey: 'test', fetchImpl: async () => { calls++; return new Response('secret error content', { status: 429, headers: { 'retry-after': '12' } }); } });
  await assert.rejects(limited.transcribe(wav()), e => e.code === 'transcription_rate_limited' && e.retryAfter === 12);
  assert.equal(calls, 2);
  const denied = createGroqTranscription({ apiKey: 'test', fetchImpl: async () => new Response('secret upstream body', { status: 401 }) });
  await assert.rejects(denied.transcribe(wav()), e => e.code === 'transcription_credentials_rejected' && !e.message.includes('secret'));
});
test('Groq timeout and external cancellation stop the upstream request', async () => {
  const fetchImpl = async (url, { signal }) => {
    if (signal.aborted) throw new Error('aborted');
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  await assert.rejects(createGroqTranscription({ apiKey: 'test', fetchImpl, timeoutMs: 10 }).transcribe(wav()), e => e.status === 504);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createGroqTranscription({ apiKey: 'test', fetchImpl }).transcribe(wav(), controller.signal), e => e.status === 504);
});
async function serverTest(run, enabled = true) {
  let calls = 0;
  const config = loadServerConfig({ AI_PROVIDER_ADMIN_EMAILS: 'owner@example.test', AI_PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 51).toString('base64'), AI_PROVIDER_CHAT_TEST_ENABLED: '1', AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client', WORKOS_REDIRECT_URI: 'http://localhost:3000/auth/callback', TURSO_DATABASE_URL: 'file:./test.db', GROQ_TRANSCRIPTION_ENABLED: enabled ? '1' : '0' });
  const server = createServer({ config,
    authService: { async getSession({ token }) { return token === 'admin' ? { id: 'admin', email: 'owner@example.test' } : token === 'member' ? { id: 'member', email: 'member@example.test' } : null; } },
    audioTranscriptionService: { configured: true, model: 'whisper-large-v3', async transcribe(bytes) { calls++; validateWav(bytes); return { text: 'recognized test', model: 'whisper-large-v3' }; } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base, () => calls); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('audio route authenticates admins, checks Origin and consent, and rejects malformed uploads', async () => {
  await serverTest(async (base, calls) => {
    const send = (extra = {}, body = wav()) => fetch(base + '/api/audio/transcribe', { method: 'POST', headers: { Origin: base, Cookie: 'kues_session=admin', 'Content-Type': 'audio/wav', 'X-Audio-Consent': 'groq-audio-v1', ...extra }, body });
    assert.equal((await fetch(base + '/api/audio/status')).status, 401);
    assert.equal((await send({ Cookie: 'kues_session=member' })).status, 403);
    assert.equal((await send({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await send({ 'X-Audio-Consent': '' })).status, 400);
    assert.equal((await send({ 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await send({}, Buffer.from('bad'))).status, 400);
    assert.equal(calls(), 0);
    const ready = await fetch(base + '/api/audio/status', { headers: { Cookie: 'kues_session=admin' } });
    assert.equal((await ready.json()).available, true);
    const response = await send(); assert.equal(response.status, 200); assert.equal((await response.json()).text, 'recognized test'); assert.equal(calls(), 1);
  });
});
test('audio disabled configuration fails closed even with a service injected', async () => {
  await serverTest(async (base, calls) => {
    const response = await fetch(base + '/api/audio/status', { headers: { Cookie: 'kues_session=admin' } });
    assert.equal((await response.json()).available, false); assert.equal(calls(), 0);
  }, false);
});
test('audio route enforces upload size and a per-admin request limit', async () => {
  await serverTest(async (base, calls) => {
    const headers = { Origin: base, Cookie: 'kues_session=admin', 'Content-Type': 'audio/wav', 'X-Audio-Consent': 'groq-audio-v1' };
    const oversized = await fetch(base + '/api/audio/transcribe', { method: 'POST', headers, body: Buffer.alloc(AUDIO_LIMIT + 1) });
    assert.equal(oversized.status, 413); assert.equal(calls(), 0);
    for (let i = 0; i < 10; i++) {
      const response = await fetch(base + '/api/audio/transcribe', { method: 'POST', headers, body: wav() });
      assert.equal(response.status, 200); await response.text();
    }
    const limited = await fetch(base + '/api/audio/transcribe', { method: 'POST', headers, body: wav() });
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60'); assert.equal(calls(), 10);
  });
});
