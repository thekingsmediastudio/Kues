const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const AUDIO_LIMIT = 44 + 16000 * 2 * 60;
export const CONSENT_VERSION = 'groq-audio-v1';
export class AudioError extends Error {
  constructor(code, status = 400, retryAfter = null) { super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}
export function validateWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > AUDIO_LIMIT) throw new AudioError('invalid_audio');
  const tag = offset => bytes.toString('ascii', offset, offset + 4);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data'
      || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1
      || bytes.readUInt32LE(24) !== 16000 || bytes.readUInt32LE(28) !== 32000
      || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16
      || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.readUInt32LE(40) !== bytes.length - 44
      || (bytes.length - 44) % 2 || bytes.length < 44 + 8000) throw new AudioError('invalid_audio');
  return (bytes.length - 44) / 32000;
}
export function createGroqTranscription({ apiKey = '', model = 'whisper-large-v3', fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  if (!['whisper-large-v3', 'whisper-large-v3-turbo'].includes(model)) throw new Error('invalid_transcription_model');
  return {
    configured: Boolean(apiKey.trim()), model,
    async transcribe(bytes, signal) {
      validateWav(bytes);
      if (!apiKey.trim()) throw new AudioError('transcription_not_configured', 503);
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        const form = new FormData();
        form.append('model', model);
        form.append('response_format', 'json');
        form.append('temperature', '0');
        form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'dictation.wav');
        const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: controller.signal, redirect: 'error' });
        if (response.status === 429) {
          const delay = Number(response.headers.get('retry-after'));
          throw new AudioError('transcription_rate_limited', 429, Number.isFinite(delay) && delay > 0 ? Math.min(Math.ceil(delay), 3600) : 60);
        }
        if (!response.ok) throw new AudioError(response.status === 401 || response.status === 403 ? 'transcription_credentials_rejected' : 'transcription_provider_unavailable', 503);
        const data = await response.json();
        if (typeof data.text !== 'string' || data.text.length > 10000) throw new AudioError('transcription_invalid_response', 502);
        return { text: data.text.trim(), model };
      } catch (error) {
        if (error instanceof AudioError) throw error;
        throw new AudioError(controller.signal.aborted ? 'transcription_timeout_or_canceled' : 'transcription_provider_unavailable', controller.signal.aborted ? 504 : 503);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  };
}
function readAudio(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks = [];
    const timer = setTimeout(() => done(new AudioError('audio_upload_timeout', 408)), 15000);
    function done(error) {
      clearTimeout(timer); req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onAbort);
      if (error) { req.resume(); reject(error); } else resolve(Buffer.concat(chunks));
    }
    function onData(chunk) { bytes += chunk.length; if (bytes > AUDIO_LIMIT) done(new AudioError('audio_too_large', 413)); else chunks.push(chunk); }
    function onEnd() { done(); }
    function onAbort() { done(new AudioError('audio_upload_canceled', 400)); }
    req.on('data', onData); req.on('end', onEnd); req.on('aborted', onAbort); req.on('error', onAbort);
  });
}
export function createAudioRoutes({ getUser, isAllowed, sameOrigin, service }) {
  const windows = new Map(); let inFlight = 0;
  function send(res, status, data, retryAfter) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) });
    res.end(JSON.stringify(data));
  }
  return async (req, res, url) => {
    if (!['/api/audio/status', '/api/audio/transcribe'].includes(url.pathname)) { send(res, 404, { error: 'audio_route_not_found' }); return; }
    const statusRoute = url.pathname === '/api/audio/status';
    if (req.method !== (statusRoute ? 'GET' : 'POST')) { send(res, 405, { error: 'method_not_allowed' }); return; }
    if (!statusRoute && !sameOrigin(req)) { send(res, 403, { error: 'same_origin_required' }); return; }
    let user;
    try { user = await getUser(req); } catch {}
    if (!user) { send(res, 401, { error: 'authentication_required' }); return; }
    if (!isAllowed(user)) { send(res, 403, { error: 'audio_admin_required' }); return; }
    if (statusRoute) {
      send(res, 200, { available: service?.configured === true, provider: 'Groq', model: service?.model || null, maxSeconds: 60, consentVersion: CONSENT_VERSION }); return;
    }
    if (!service?.configured) { send(res, 503, { error: 'transcription_not_configured' }); return; }
    if (req.headers['x-audio-consent'] !== CONSENT_VERSION) { send(res, 400, { error: 'audio_consent_required' }); return; }
    if (String(req.headers['content-type'] || '').split(';')[0] !== 'audio/wav') { send(res, 415, { error: 'audio_wav_required' }); return; }
    if (Number(req.headers['content-length'] || 0) > AUDIO_LIMIT) { res.setHeader('Connection', 'close'); send(res, 413, { error: 'audio_too_large' }); return; }
    const now = Date.now();
    for (const [id, window] of windows) if (now - window.start >= 60000) windows.delete(id);
    const bucket = windows.get(user.id) || { start: now, count: 0 };
    if (bucket.count >= 10 || inFlight >= 2) { send(res, 429, { error: 'transcription_rate_limited' }, 60); return; }
    bucket.count++; windows.set(user.id, bucket); inFlight++;
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      const bytes = await readAudio(req); validateWav(bytes);
      const result = await service.transcribe(bytes, controller.signal);
      if (!res.destroyed) send(res, 200, result);
    } catch (error) {
      if (!res.destroyed) {
        const safe = error instanceof AudioError ? error : new AudioError('transcription_unavailable', 503);
        if ([408, 413].includes(safe.status)) res.setHeader('Connection', 'close');
        send(res, safe.status, { error: safe.code }, safe.retryAfter);
      }
    } finally { inFlight--; res.off('close', disconnected); }
  };
}
