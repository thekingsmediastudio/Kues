import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { microphoneConstraints, microphoneError } from '../../apps/web/public/local-audio.mjs';
const source = fs.readFileSync(new URL('../../apps/web/public/local-audio.mjs', import.meta.url), 'utf8');
test('selected microphone capture uses exact constraints with no default-device fallback', () => {
  assert.deepEqual(microphoneConstraints('usb-device-123').audio.deviceId, { exact: 'usb-device-123' });
  assert.equal(microphoneConstraints('usb-device-123').video, false);
  for (const id of ['', 'default', 'communications', undefined]) assert.throws(() => microphoneConstraints(id));
  assert.match(source, /track.getSettings\(\).deviceId !== preferred/);
});
test('missing and denied microphone errors explain recovery without claiming a fallback', () => {
  assert.match(microphoneError({ name: 'OverconstrainedError' }), /No other microphone/);
  assert.match(microphoneError({ name: 'NotAllowedError' }), /permission denied/);
  assert.match(microphoneError({ name: 'NotReadableError' }), /busy/);
});
test('Groq client uses the same-origin upload route and an explicit consent header', () => {
  assert.match(source, /fetch\('\/api\/audio\/transcribe'/);
  assert.match(source, /'X-Audio-Consent': 'groq-audio-v1'/);
  assert.match(source, /if \(!consentGranted\)/);
  assert.doesNotMatch(source, /new Worker|api\.groq\.com|SpeechRecognition/);
  assert.match(source, /capture.sampleRate \* 60/);
  assert.match(source, /adapter.context\(\).agentId === old.agentId/);
  assert.match(source, /getTracks\(\).forEach\(t => t.stop\(\)\)/);
});
