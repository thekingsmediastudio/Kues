// Device preference stays in this browser. Consented audio uploads use the authenticated Groq proxy only.
export function microphoneConstraints(deviceId) {
  if (!deviceId || ['default', 'communications'].includes(deviceId)) throw new Error('Choose a specific microphone in Settings > Audio.');
  return { audio: { deviceId: { exact: deviceId }, channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false };
}
export function microphoneError(error) {
  return ({ NotAllowedError: 'Microphone permission denied. Allow access in browser settings and retry.',
    NotFoundError: 'The selected microphone is unavailable. Choose another in Audio settings.',
    OverconstrainedError: 'The saved microphone is unavailable. No other microphone was selected.',
    NotReadableError: 'The microphone is busy or could not be opened. Check other apps and retry.' })[error?.name] || error?.message || 'Microphone could not be opened.';
}
export function encodeWav(audio) {
  if (!(audio instanceof Float32Array) || audio.length > 16000 * 60) throw new Error('Invalid recording length.');
  const bytes = new ArrayBuffer(44 + audio.length * 2); const view = new DataView(bytes);
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, audio.length * 2, true);
  audio.forEach((v, i) => { const sample = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0; view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); });
  return bytes;
}
export function createAudioInput(adapter) {
  const el = id => document.getElementById(id);
  const key = 'keus.audio.device.v1';
  let preferred = '', savedLabel = '', devices = [], serviceReady = false, checking = false, checkedAt = 0, uploadController = null, consentGranted = false, consentPending = null, serviceProblem = '';
  let session = null, test = null, deviceVersion = 0, preparing = false;
  const supported = Boolean(isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode);
  try { const saved = JSON.parse(localStorage.getItem(key) || '{}'); preferred = saved.id || ''; savedLabel = saved.label || ''; } catch {}
  const status = message => { el('audioStatus').textContent = message; };
  function render() {
    const active = Boolean(session);
    const ctx = adapter.context();
    const mic = el('chatMicButton');
    mic.disabled = !supported || (!active && !ctx.canDictate);
    mic.classList.toggle('is-listening', session?.phase === 'recording');
    mic.setAttribute('aria-pressed', String(active));
    mic.title = mic.ariaLabel = session?.phase === 'recording' ? 'Stop recording and turn speech into text' : active ? 'Cancel transcription' : 'Dictate using your selected microphone';
    el('chatInput').readOnly = active;
    el('audioDeviceSelect').disabled = Boolean(session || test);
    el('audioPermission').disabled = !supported || Boolean(session || test);
    el('audioTest').disabled = !supported || Boolean(session || (!test && !devices.some(d => d.deviceId === preferred)));
    el('audioTest').textContent = test ? 'Stop microphone test' : 'Test selected microphone';
    for (const id of ['chatPlusButton', 'chatEmojiButton']) el(id).disabled = active;
    if (!supported) adapter.status('Voice typing is unavailable in this browser. You can still type.');
  }
  async function refreshDevices() {
    if (!supported) { status('Microphone capture requires a supported browser and HTTPS.'); render(); return; }
    const version = ++deviceVersion;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      if (version !== deviceVersion) return;
      devices = list.filter(d => d.kind === 'audioinput' && d.deviceId && !['default', 'communications'].includes(d.deviceId));
      const select = el('audioDeviceSelect'); select.replaceChildren(new Option('Choose a microphone', ''));
      devices.forEach((d, i) => select.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
      if (preferred && !devices.some(d => d.deviceId === preferred)) {
        select.add(new Option(`${savedLabel || 'Saved microphone'} (unavailable)`, preferred));
        status('Your saved microphone is unavailable or permission needs renewing. No fallback device will be used.');
        if (session) cancel('Selected microphone disconnected. Draft preserved.');
        stopTest();
      }
      select.value = preferred;
      render();
    } catch (e) { status(microphoneError(e)); }
  }
  async function permit() {
    status('Requesting permission to list microphone names. This does not record or transcribe.');
    try {
      // Explicit permission action only; the temporary default stream is immediately closed.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach(t => t.stop());
      status('Choose a specific microphone, then test it.'); await refreshDevices();
    } catch (e) { status(microphoneError(e)); }
  }
  function selectDevice() {
    preferred = el('audioDeviceSelect').value;
    savedLabel = devices.find(d => d.deviceId === preferred)?.label || '';
    try { localStorage.setItem(key, JSON.stringify({ id: preferred, label: savedLabel })); status('Microphone preference saved in this browser.'); }
    catch { status('Microphone selected for this tab only; browser storage is unavailable.'); }
    render();
  }
  async function exactStream() {
    if (!devices.some(d => d.deviceId === preferred)) throw new Error('Choose an available microphone in Settings > Audio.');
    const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(preferred));
    const track = stream.getAudioTracks()[0];
    if (!track || track.getSettings().deviceId !== preferred) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('The browser did not open the selected microphone. No fallback recording was started.');
    }
    return stream;
  }
  function release(capture) {
    if (!capture) return;
    clearTimeout(capture.timer); cancelAnimationFrame(capture.frame);
    capture.stream?.getTracks().forEach(t => t.stop());
    try { capture.source?.disconnect(); capture.node?.disconnect(); } catch {}
    void capture.context?.close().catch(() => {});
  }
  function stopTest() { const old = test; test = null; release(old); el('audioMeter').value = 0; render(); }
  async function toggleTest() {
    if (test) { stopTest(); status('Microphone test stopped. No recording saved.'); return; }
    const capture = {}; test = capture; render();
    try {
      capture.context = new AudioContext(); await capture.context.resume();
      capture.stream = await exactStream();
      if (test !== capture) { release(capture); return; }
      capture.source = capture.context.createMediaStreamSource(capture.stream);
      const analyser = capture.context.createAnalyser(); analyser.fftSize = 512; capture.source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      function meter() {
        if (test !== capture) return;
        analyser.getFloatTimeDomainData(data);
        el('audioMeter').value = Math.min(1, Math.sqrt(data.reduce((sum, n) => sum + n * n, 0) / data.length) * 6);
        capture.frame = requestAnimationFrame(meter);
      }
      meter(); capture.timer = setTimeout(() => { stopTest(); status('Microphone test ended after 20 seconds.'); }, 20000);
      capture.stream.getAudioTracks()[0].onended = () => { if (test === capture) { stopTest(); status('Selected microphone disconnected.'); } };
      status(`Testing ${savedLabel || 'selected microphone'}. Speak to move the meter. Audio stays on this device.`);
    } catch (e) { if (test === capture) { stopTest(); status(microphoneError(e)); } else release(capture); }
  }
  const errorCopy = code => ({
    authentication_required: 'Sign in again to use dictation.',
    audio_admin_required: 'Voice typing is not available for this account.',
    audio_consent_required: 'Please agree to speech processing before using voice typing.',
    transcription_not_configured: 'Voice typing is not available yet. You can still type your message.',
    transcription_credentials_rejected: 'Voice typing is unavailable right now. Please try again later.',
    transcription_rate_limited: 'Transcription limit reached. Wait before retrying; nothing was automatically resubmitted.',
    transcription_timeout_or_canceled: 'Transcription timed out or was canceled. Your original draft is unchanged.',
    audio_upload_timeout: 'Audio upload timed out. Check your connection and retry.',
    transcription_provider_unavailable: 'Voice typing is unavailable. Your original draft is unchanged; try again later.',
    invalid_audio: 'The recording format was invalid. Try a new short recording.',
    audio_too_large: 'This recording is too large. Record no more than 60 seconds.'
  })[code] || 'Transcription could not complete. Your original draft is unchanged.';
  async function checkService(force = false) {
    if (checking || (!force && Date.now() - checkedAt < 60000)) return;
    checking = true; render();
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/audio/status', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      serviceReady = response.ok && data.available === true;
      checkedAt = Date.now();
      serviceProblem = serviceReady ? '' : errorCopy(data.error || 'transcription_not_configured');
    } catch { serviceReady = false; serviceProblem = 'Voice typing could not connect. Check your connection and try again.'; }
    finally { clearTimeout(timer); checking = false; render(); }
  }
  function requestConsent() {
    if (consentGranted) return Promise.resolve(true);
    if (consentPending) return consentPending;
    const dialog = el('audioConsentDialog');
    consentPending = new Promise(resolve => {
      dialog.returnValue = 'cancel';
      dialog.onclose = () => {
        consentGranted = dialog.returnValue === 'continue';
        consentPending = null;
        resolve(consentGranted);
      };
      dialog.showModal();
    });
    return consentPending;
  }
  async function transcribe(audio) {
    if (!consentGranted) throw new Error(errorCopy('audio_consent_required'));
    const controller = new AbortController(); uploadController = controller; render();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch('/api/audio/transcribe', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'audio/wav', 'X-Audio-Consent': 'groq-audio-v1' }, body: encodeWav(audio),
      });
      const data = await response.json();
      if (!response.ok) {
        const retry = Number(response.headers.get('retry-after'));
        throw new Error(errorCopy(data.error) + (response.status === 429 && retry > 0 ? ` Retry in about ${Math.ceil(retry)} seconds.` : ''));
      }
      if (typeof data.text !== 'string') throw new Error('The transcription service returned an invalid response. Your draft is unchanged.');
      return data;
    } catch (e) {
      if (controller.signal.aborted) throw new Error('Transcription canceled or timed out. Your original draft is unchanged.');
      if (e instanceof TypeError) throw new Error('Connection failed. Your original draft is unchanged.');
      throw e;
    } finally { clearTimeout(timer); if (uploadController === controller) uploadController = null; render(); }
  }
  function endSession(message, transcript) {
    const old = session; if (!old) return;
    session = null; release(old); old.chunks = [];
    if (typeof transcript === 'string' && adapter.context().agentId === old.agentId) adapter.setDraft(adapter.mergeDraft(old.base, transcript));
    adapter.status(message); adapter.onState(false); render();
  }
  function cancel(message = 'Dictation canceled. Your original draft is unchanged.') {
    if (!session) return;
    uploadController?.abort();
    endSession(message);
  }
  async function stopRecording() {
    const capture = session;
    if (!capture || capture.phase !== 'recording') return;
    capture.phase = 'transcribing'; clearTimeout(capture.timer);
    capture.source.disconnect();
    await new Promise(resolve => {
      capture.flushed = resolve; capture.node.port.postMessage('flush'); setTimeout(resolve, 150);
    });
    release(capture);
    if (session !== capture) return;
    adapter.status('Turning speech into text… Click the mic to cancel.'); render();
    try {
      const count = capture.chunks.reduce((n, chunk) => n + chunk.length, 0);
      if (count < capture.sampleRate * 0.25) { endSession('Recording was too short. Your draft is unchanged.'); return; }
      const pcm = new Float32Array(count); let offset = 0;
      for (const chunk of capture.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
      capture.chunks = [];
      const rms = Math.sqrt(pcm.reduce((sum, v) => sum + v * v, 0) / pcm.length);
      if (rms < 0.001) { endSession('No usable audio detected. Check the selected microphone with the input meter.'); return; }
      const offline = new OfflineAudioContext(1, Math.ceil(pcm.length * 16000 / capture.sampleRate), 16000);
      const buffer = offline.createBuffer(1, pcm.length, capture.sampleRate); buffer.copyToChannel(pcm, 0);
      const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start();
      const rendered = await offline.startRendering();
      if (session !== capture) return;
      const result = await transcribe(new Float32Array(rendered.getChannelData(0)));
      if (session !== capture) return;
      const text = result.text.trim();
      endSession(text ? (capture.base.length + text.length + 1 > 2000 ? 'Transcript added up to the 2,000-character draft limit. Review before sending.' : 'Your text is ready. Review or edit it, then press Send.') : 'No speech recognized. Your draft is unchanged.', text);
    } catch (e) { if (session === capture) endSession(e.message); }
  }
  async function toggle() {
    if (session?.phase === 'recording') { await stopRecording(); return; }
    if (session) { cancel(); return; }
    if (!adapter.context().canDictate || !supported || preparing) return;
    preparing = true;
    const startingAgentId = adapter.context().agentId;
    try {
      await refreshDevices();
      if (!devices.some(d => d.deviceId === preferred)) {
        adapter.openSettings(); status('Choose a microphone to start voice typing.'); return;
      }
      adapter.status('Preparing voice typing…');
      await checkService();
      if (!serviceReady) { adapter.status(serviceProblem || 'Voice typing is unavailable. Please try again later.'); return; }
      if (!await requestConsent()) { adapter.status('Voice typing canceled. No recording was started.'); return; }
    } finally { preparing = false; }
    if (!adapter.context().canDictate || document.hidden || adapter.context().agentId !== startingAgentId) return;
    stopTest();
    const ctx = adapter.context();
    if (ctx.draft.length >= 2000) { adapter.status('Your draft is full. Shorten it before recording.'); return; }
    const capture = { phase: 'starting', base: ctx.draft, agentId: ctx.agentId, chunks: [], samples: 0 };
    session = capture; adapter.onState(true); adapter.status('Opening your selected microphone…'); render();
    capture.timer = setTimeout(() => { if (session === capture) cancel('Microphone did not start. Check permissions and try again.'); }, 15000);
    try {
      capture.context = new AudioContext({ sampleRate: 16000 }); await capture.context.resume();
      capture.stream = await exactStream();
      if (session !== capture) { release(capture); return; }
      await capture.context.audioWorklet.addModule('/local-audio-capture.mjs');
      if (session !== capture) { release(capture); return; }
      capture.sampleRate = capture.context.sampleRate;
      capture.source = capture.context.createMediaStreamSource(capture.stream);
      capture.node = new AudioWorkletNode(capture.context, 'keus-audio-capture');
      capture.node.port.onmessage = ({ data }) => {
        if (session !== capture) return;
        if (data.flushed) capture.flushed?.();
        if (data.chunk && capture.samples < capture.sampleRate * 60) {
          const chunk = data.chunk.subarray(0, Math.max(0, capture.sampleRate * 60 - capture.samples));
          capture.chunks.push(chunk); capture.samples += chunk.length;
        }
      };
      capture.source.connect(capture.node); capture.node.connect(capture.context.destination);
      capture.stream.getAudioTracks()[0].onended = () => { if (session === capture && capture.phase === 'recording') cancel('Selected microphone disconnected. Your draft is unchanged.'); };
      clearTimeout(capture.timer); capture.phase = 'recording';
      capture.timer = setTimeout(stopRecording, 60000);
      adapter.status(`Recording with ${savedLabel || 'selected microphone'}. Click the mic to stop and turn speech into text. Maximum 60 seconds.`); render();
    } catch (e) { if (session === capture) endSession(microphoneError(e)); else release(capture); }
  }
  el('audioPermission').onclick = permit;
  el('audioDeviceSelect').onchange = selectDevice;
  el('audioTest').onclick = toggleTest;
  navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopTest(); if (session?.phase !== 'transcribing') cancel('Recording stopped when the tab was hidden. Your draft is unchanged.'); } });
  window.addEventListener('pagehide', () => { if (el('audioConsentDialog').open) el('audioConsentDialog').close('cancel'); stopTest(); cancel(); });
  render();
  return { toggle, refreshDevices, checkService, stopTest, sync(canDictate) {
    if (session && (!canDictate || adapter.context().agentId !== session.agentId)) cancel('Conversation changed. Recording stopped and your original draft is preserved.');
    render();
  } };
}
