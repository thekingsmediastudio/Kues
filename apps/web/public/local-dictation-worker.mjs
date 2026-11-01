// Pinned runtime/model. Audio is processed in this worker, never sent to an API.
let transcriber;
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      transcriber ||= await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        revision: '79fb389fc764e7c395bd330e9531d9d32ada7049', device: 'wasm', dtype: 'q8',
        progress_callback: p => self.postMessage({ id, type: 'progress', status: p.status, file: p.file, progress: p.progress }),
      });
      self.postMessage({ id, type: 'ready' });
    } else if (type === 'transcribe') {
      if (!transcriber) throw new Error('Model is not loaded.');
      if (!(data.audio instanceof Float32Array) || data.audio.length > 16000 * 61) throw new Error('Invalid audio length.');
      const output = await transcriber(data.audio, { chunk_length_s: 30, stride_length_s: 5, max_new_tokens: 256 });
      self.postMessage({ id, type: 'result', text: String(output.text || '') });
    }
  } catch (error) {
    self.postMessage({ id, type: 'error', message: String(error.message || 'Local transcription failed.').slice(0, 200) });
  }
};
