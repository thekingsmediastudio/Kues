// Device preference stays in this browser. No audio upload or cloud fallback.
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
export function createLocalAudio(adapter) {
  const el = id => document.getElementById(id);
  const key = 'keus.audio.device.v1';
  let preferred = '', savedLabel = '', devices = [], worker = null, modelReady = false, job = null, jobId = 0;
  let session = null, test = null, deviceVersion = 0, preparing = false;
  const supported = Boolean(isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode && window.Worker);
  try { const saved = JSON.parse(localStorage.getItem(key) || '{}'); preferred = saved.id || ''; savedLabel = saved.label || ''; } catch {}
  const status = message => { el('audioStatus').textContent = message; };
  function render() {
    const active = Boolean(session);
    const ctx = adapter.context();
    const mic = el('chatMicButton');
    mic.disabled = !supported || (!active && !ctx.canDictate);
    mic.classList.toggle('is-listening', session?.phase === 'recording');
    mic.setAttribute('aria-pressed', String(active));
    mic.title = mic.ariaLabel = session?.phase === 'recording' ? 'Stop recording and transcribe locally' : active ? 'Cancel local dictation' : 'Dictate using your selected microphone';
    el('chatInput').readOnly = active;
    el('audioDeviceSelect').disabled = Boolean(session || test);
    el('audioPermission').disabled = !supported || Boolean(session || test);
    el('audioTest').disabled = !supported || Boolean(session || (!test && !devices.some(d => d.deviceId === preferred)));
    el('audioTest').textContent = test ? 'Stop microphone test' : 'Test selected microphone';
    el('audioModelLoad').disabled = !supported || Boolean(job || session || modelReady);
    el('audioModelLoad').textContent = modelReady ? 'English model ready' : 'Download / load English model';
    el('audioModelCancel').hidden = !job;
    for (const id of ['chatPlusButton', 'chatEmojiButton']) el(id).disabled = active;
    if (!supported) adapter.status('Local voice typing is unavailable in this browser. You can still type.');
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
  function discardWorker(message = 'Local operation canceled.') {
    worker?.terminate(); worker = null; modelReady = false;
    el('audioModelStatus').textContent = message;
    if (job) { const old = job; job = null; clearTimeout(old.timer); old.reject(new Error(message)); }
    render();
  }
  function runWorker(type, audio) {
    if (job) return Promise.reject(new Error('A local operation is already running.'));
    if (!worker) {
      worker = new Worker('/local-dictation-worker.mjs', { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (!job || data.id !== job.id) return;
        if (data.type === 'progress') {
          const percent = Number.isFinite(data.progress) ? ` ${Math.floor(data.progress)}%` : '';
          el('audioModelStatus').textContent = `Loading model assets${percent}${data.file ? ` (${data.file.split('/').pop()})` : ''}. Percentages apply to each file.`;
          return;
        }
        const old = job; job = null; clearTimeout(old.timer);
        if (data.type === 'error') { modelReady = false; worker?.terminate(); worker = null; old.reject(new Error(data.message)); }
        else { if (data.type === 'ready') modelReady = true; old.resolve(data); }
        render();
      };
      worker.onerror = () => discardWorker('Local model could not run. Check network access for model downloads and browser support.');
    }
    return new Promise((resolve, reject) => {
      const id = ++jobId;
      job = { id, resolve, reject, timer: setTimeout(() => discardWorker('Local processing timed out. Your draft is preserved; retry or type instead.'), type === 'load' ? 240000 : 120000) };
      worker.postMessage({ id, type, audio }, audio ? [audio.buffer] : []); render();
    });
  }
  async function loadModel() {
    if (job || modelReady) return;
    el('audioModelStatus').textContent = 'Downloading local runtime/model assets. No microphone audio is uploaded.';
    try { await runWorker('load'); el('audioModelStatus').textContent = 'English model ready on this device. Record, stop, then review the transcript.'; }
    catch (e) { el('audioModelStatus').textContent = e.message; }
    render();
  }
  function endSession(message, transcript) {
    const old = session; if (!old) return;
    session = null; release(old); old.chunks = [];
    if (typeof transcript === 'string' && adapter.context().agentId === old.agentId) adapter.setDraft(adapter.mergeDraft(old.base, transcript));
    adapter.status(message); adapter.onState(false); render();
  }
  function cancel(message = 'Local dictation canceled. Your original draft is unchanged.') {
    if (!session) return;
    if (job) discardWorker(message);
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
    adapter.status('Transcribing on your device… Click the mic to cancel.'); render();
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
      const result = await runWorker('transcribe', new Float32Array(rendered.getChannelData(0)));
      if (session !== capture) return;
      const text = result.text.trim();
      endSession(text ? 'Local transcript ready. Check it for mistakes, edit, then press Send.' : 'No speech recognized. Your draft is unchanged.', text);
    } catch (e) { if (session === capture) endSession(e.message); }
  }
  async function toggle() {
    if (session?.phase === 'recording') { await stopRecording(); return; }
    if (session) { cancel(); return; }
    if (!adapter.context().canDictate || !supported || preparing) return;
    preparing = true;
    try { await refreshDevices(); } finally { preparing = false; }
    if (!adapter.context().canDictate || document.hidden) return;
    if (!modelReady || !devices.some(d => d.deviceId === preferred)) {
      adapter.openSettings(); status('Select and test a microphone, then load the English model to enable local dictation.'); return;
    }
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
      adapter.status(`Recording locally with ${savedLabel || 'selected microphone'}. Click the mic to stop and transcribe. Maximum 60 seconds.`); render();
    } catch (e) { if (session === capture) endSession(microphoneError(e)); else release(capture); }
  }
  el('audioPermission').onclick = permit;
  el('audioDeviceSelect').onchange = selectDevice;
  el('audioTest').onclick = toggleTest;
  el('audioModelLoad').onclick = loadModel;
  el('audioModelCancel').onclick = () => { discardWorker(); if (session) cancel(); };
  navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopTest(); if (session?.phase !== 'transcribing') cancel('Recording stopped when the tab was hidden. Your draft is unchanged.'); } });
  window.addEventListener('pagehide', () => { stopTest(); cancel(); discardWorker(); });
  render();
  return { toggle, refreshDevices, stopTest, sync(canDictate) {
    if (session && (!canDictate || adapter.context().agentId !== session.agentId)) cancel('Conversation changed. Recording stopped and your original draft is preserved.');
    render();
  } };
}
