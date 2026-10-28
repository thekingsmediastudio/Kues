import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopHtml = fs.readFileSync(path.resolve(testDir, '../../apps/web/public/desktop-preview.html'), 'utf8');


test('desktop chat requests SSE and progressively renders only answer-delta events as text', () => {
  assert.match(desktopHtml, /headers:\s*\{\s*Accept:\s*'text\/event-stream',\s*'Content-Type':\s*'application\/json'\s*\}/);
  assert.match(desktopHtml, /\['delta', 'done', 'error'\]\.includes\(name\)/);
  assert.match(desktopHtml, /const answerText = assistantRow\?\.querySelector\('\.chat-answer-text'\)/);
  assert.match(desktopHtml, /answerText\.textContent\s*=\s*replyText/);
  assert.match(desktopHtml, /chat-thinking-dots/);
  assert.match(desktopHtml, /chatThinkingPulse/);
  assert.match(desktopHtml, /chat-progress-steps/);
  assert.match(desktopHtml, /Prompt received/);
  assert.match(desktopHtml, /Preparing response/);
  assert.match(desktopHtml, /Streaming answer/);
  assert.match(desktopHtml, /function setChatProgress\(row, stage\)/);
  assert.match(desktopHtml, /chat-streaming \.chat-answer-text::after/);
  assert.doesNotMatch(desktopHtml, /eventName\s*===\s*['"]reasoning['"]/i);
});

test('desktop agent avatars are enlarged and use transparent backplates', () => {
  assert.match(desktopHtml, /\.saved-agent-avatar\{width:52px;height:52px;background:transparent;border:0;border-radius:0\}/);
  assert.match(desktopHtml, /\.saved-agent-avatar \.agent-avatar-art\{width:50px;height:50px;/);
  assert.match(desktopHtml, /\.header-agent-avatar\{width:42px;height:42px;background:transparent;border:0;border-radius:0\}/);
  assert.match(desktopHtml, /\.header-agent-avatar \.agent-avatar-art\{width:41px;height:41px;/);
  assert.match(desktopHtml, /\.chat-reply-avatar \{ width: 48px; height: 48px;[^}]*border-radius: 0;[^}]*background: transparent;/);
  assert.match(desktopHtml, /\.chat-reply-avatar svg \{ width: 46px; height: 46px;/);
  assert.match(desktopHtml, /body\.typing-mode #hdrAvatar \{[^}]*box-shadow:none;/);
});
