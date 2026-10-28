import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopHtml = fs.readFileSync(path.resolve(testDir, '../../apps/web/public/desktop-preview.html'), 'utf8');


test('desktop chat progressively renders answers, removes the completed progress card, and accepts only Scout cue events', () => {
  assert.match(desktopHtml, /headers:\s*\{\s*Accept:\s*'text\/event-stream',\s*'Content-Type':\s*'application\/json'\s*\}/);
  assert.match(desktopHtml, /\['delta', 'avatar_cue', 'done', 'error'\]\.includes\(name\)/);
  assert.match(desktopHtml, /const answerText = assistantRow\?\.querySelector\('\.chat-answer-text'\)/);
  assert.match(desktopHtml, /renderChatMarkdown\(answerText, replyText\)/);
  assert.match(desktopHtml, /renderChatMarkdown\(answerText, reply\)/);
  assert.match(desktopHtml, /className = 'chat-live-status'/);
  assert.match(desktopHtml, /function setChatLiveStatus\(row, stage\)/);
  assert.match(desktopHtml, /position:absolute!important; width:1px!important/);
  assert.match(desktopHtml, /Reply complete\./);
  assert.doesNotMatch(desktopHtml, /chat-progress|chat-thinking-dots|Prompt received|Streaming answer/);
  assert.match(desktopHtml, /function appendChatProviderAttribution\(row, attribution\)/);
  assert.match(desktopHtml, /const candidate = payload\?\.attribution/);
  assert.match(desktopHtml, /appendChatProviderAttribution\(assistantRow, replyAttribution\)/);
  assert.match(desktopHtml, /note\.textContent = `Provider: \$\{provider\} · Model: \$\{model\}`/);
  assert.match(desktopHtml, /chat-streaming \.chat-answer-text::after/);
  assert.match(desktopHtml, /function playScoutAvatarCue\(cue, requestAgentId\)/);
  assert.match(desktopHtml, /payload\?\.avatar === 'magnifier'/);
  const cueHandlerStart = desktopHtml.indexOf('  function playScoutAvatarCue');
  const cueHandlerEnd = desktopHtml.indexOf('  function setChatLiveStatus', cueHandlerStart);
  const cueHandler = desktopHtml.slice(cueHandlerStart, cueHandlerEnd);
  assert.match(cueHandler, /document\.getElementById\('savedAgentAvatar'\)\?\.querySelector\('\.agent-avatar-art'\)/);
  assert.doesNotMatch(cueHandler, /hdrAvatar|chat-reply-avatar/, 'only the selected sidebar avatar animates');
  assert.match(desktopHtml, /const SCOUT_CUE_REPEAT_COUNT = 4/);
  assert.match(desktopHtml, /SCOUT_CUE_DURATIONS\[cue\] \* SCOUT_CUE_REPEAT_COUNT/);
  assert.match(desktopHtml, /prefers-reduced-motion:reduce/);
  assert.ok(desktopHtml.includes('.scout-cue-mark { opacity:0; }'));
  const reducedMotionStart = desktopHtml.lastIndexOf('@media (prefers-reduced-motion:reduce)');
  const reducedMotionEnd = desktopHtml.indexOf('  html[data-review-fixture="true"] .saved-agent-list-row', reducedMotionStart);
  const reducedMotionStyles = desktopHtml.slice(reducedMotionStart, reducedMotionEnd);
  assert.ok(reducedMotionStart >= 0 && reducedMotionEnd > reducedMotionStart);
  assert.ok(!reducedMotionStyles.includes('.agent-avatar-art[class*="scout-cue-"] .scout-cue-mark'), 'reduced motion reveals only the active cue symbol');
  for (const cue of ['notice', 'search', 'inspect', 'compare', 'draft', 'organize', 'verify', 'explain', 'ask', 'wait', 'success', 'recover']) {
    assert.ok(desktopHtml.includes(`${cue}:`), `duration is present for ${cue}`);
    assert.ok(desktopHtml.includes(`scout-cue-${cue}`), `cue class is present for ${cue}`);
    const animationSelector = `.agent-avatar-art.scout-cue-${cue}`;
    const animationStart = desktopHtml.indexOf(animationSelector);
    const animationEnd = desktopHtml.indexOf('\n', animationStart);
    assert.ok(animationStart >= 0 && desktopHtml.slice(animationStart, animationEnd).includes(' 4 both'), `cue plays four loops: ${cue}`);
    assert.ok(desktopHtml.includes(`scout-mark-${cue}`), `symbol is present for ${cue}`);
    assert.ok(desktopHtml.includes(`.agent-avatar-art.scout-cue-${cue} .scout-mark-${cue} { animation:`), `symbolic choreography is mapped for ${cue}`);
    assert.ok(reducedMotionStyles.includes(`.agent-avatar-art.scout-cue-${cue} .scout-mark-${cue}`), `reduced motion shows only the active ${cue} symbol`);
  }
  assert.doesNotMatch(desktopHtml, /eventName\s*===\s*['"]reasoning['"]/i);
});


test('assistant Markdown renders common blocks safely and rejects executable links or raw HTML', () => {
  const start = desktopHtml.indexOf('  function safeChatMarkdownHref');
  const end = desktopHtml.indexOf('  function createAssistantChatMessage', start);
  assert.ok(start >= 0 && end > start);
  const rendererSource = desktopHtml.slice(start, end);
  assert.doesNotMatch(rendererSource, /innerHTML/);

  class MockNode {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.value = ''; }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; this.value = ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    set textContent(value) { this.value = String(value); this.children = []; }
    get textContent() { return this.value + this.children.map((node) => node.textContent).join(''); }
  }
  const document = {
    createElement(tag) { return new MockNode(tag); },
    createTextNode(value) { const node = new MockNode('#text'); node.textContent = value; return node; },
  };
  const renderMarkdown = new Function('document', 'window', `${rendererSource}; return renderChatMarkdown;`)(
    document,
    { location: { href: 'https://kues.example/chat' } },
  );
  const root = new MockNode('div');
  renderMarkdown(root, [
    '# **Streamed** answer',
    '',
    'A **bold** and *italic* `inline` snippet with ~~old~~ text.',
    '',
    '- First item',
    '- **Second** item',
    '',
    '1. Ordered one',
    '2. Ordered two',
    '',
    '> Quoted context',
    '',
    '```js',
    'const html = "<img src=x>";',
    '```',
    '',
    '| Kind | State |',
    '|:---|---:|',
    '| Safe | **ready** |',
    '',
    '[Docs](https://example.test/help "Documentation") [unsafe](javascript:alert(1))',
    '<script>alert(1)</script>',
  ].join('\n'));
  const walk = (node) => [node, ...node.children.flatMap(walk)];
  const nodes = walk(root);
  const find = (tag) => nodes.filter((node) => node.tagName === tag);
  assert.equal(find('h1')[0]?.textContent, 'Streamed answer');
  assert.equal(find('ul')[0]?.children.length, 2);
  assert.equal(find('ol')[0]?.children.length, 2);
  assert.equal(find('blockquote').length, 1);
  assert.equal(find('table').length, 1);
  const fencedCode = find('pre')[0]?.children[0];
  assert.equal(fencedCode?.tagName, 'code');
  assert.equal(fencedCode?.textContent, 'const html = "<img src=x>";');
  const links = find('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].attributes.href, 'https://example.test/help');
  assert.equal(links[0].attributes.target, '_blank');
  assert.equal(links[0].attributes.rel, 'noopener noreferrer');
  assert.ok(root.textContent.includes('[unsafe](javascript:alert(1))'));
  assert.ok(root.textContent.includes('<script>alert(1)</script>'));
  assert.equal(find('script').length, 0);
});


test('admin provider attribution is added as safe text and never duplicated', () => {
  const start = desktopHtml.indexOf('  function appendChatProviderAttribution');
  const end = desktopHtml.indexOf('\n\n  function runScoutCueQueue', start);
  assert.ok(start >= 0 && end > start);
  const helperSource = desktopHtml.slice(start, end);
  const document = {
    createElement(tag) {
      return {
        tag,
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
      };
    },
  };
  const appendAttribution = new Function('document', `${helperSource}; return appendChatProviderAttribution;`)(document);
  const textNode = {
    children: [],
    querySelector(selector) { return this.children.find((node) => `.${node.className}` === selector) || null; },
    append(node) { this.children.push(node); },
  };
  const row = { querySelector(selector) { return selector === '.msg-text' ? textNode : null; } };
  const attribution = { provider: 'primary-key', providerDisplayName: '<img src=x onerror=alert(1)>', model: 'safe-model\u0007' };
  appendAttribution(row, attribution);
  appendAttribution(row, attribution);
  assert.equal(textNode.children.length, 1);
  assert.equal(textNode.children[0].textContent, 'Provider: <img src=x onerror=alert(1)> (primary-key) · Model: safe-model');
  assert.equal(textNode.children[0].attributes['aria-label'], 'Provider and model used for this reply');
});

test('admin provider/model controls are server-gated, request-scoped, and render diagnostics as safe text', () => {
  assert.match(desktopHtml, /id="adminChatControls" hidden/);
  assert.match(desktopHtml, /id="chatProviderSelect" disabled/);
  assert.match(desktopHtml, /id="chatModelId" type="text"[^>]*disabled/);
  assert.match(desktopHtml, /overrides apply to the next message only/i);
  assert.match(desktopHtml, /data\?\.adminControls !== true/);
  assert.match(desktopHtml, /function renderAdminChatControls\(data\)/);
  assert.match(desktopHtml, /Configured primary \(dynamic\)/);
  assert.match(desktopHtml, /provider\.isFallback \? 'marked backup' : 'manual target'/);
  assert.match(desktopHtml, /requestBody\.providerKey = providerKey/);
  assert.match(desktopHtml, /requestBody\.modelId = modelId/);
  assert.match(desktopHtml, /chatProviderSelect\?\.addEventListener\('change', syncAdminChatModelInput\)/);
  assert.doesNotMatch(desktopHtml, /syncChatAdminModelInput/);
  assert.match(desktopHtml, /resetAdminChatOverrides\(\)/);
  assert.match(desktopHtml, /error\.adminDiagnostics = data\.adminDiagnostics/);
  assert.match(desktopHtml, /error\.adminDiagnostics = payload\?\.adminDiagnostics/);
  const start = desktopHtml.indexOf('  function setAdminChatDiagnostics');
  const end = desktopHtml.indexOf('  async function loadChatHistory', start);
  assert.ok(start >= 0 && end > start);
  const diagnosticsSource = desktopHtml.slice(start, end);
  assert.match(diagnosticsSource, /output\.textContent = lines\.join/);
  assert.doesNotMatch(diagnosticsSource, /innerHTML/);
  assert.match(desktopHtml, /setAdminChatDiagnostics\(error\.adminDiagnostics\)/);
});

test('authenticated workspace starts with an explicit accessible loading state and clears it after hydration', () => {
  assert.match(desktopHtml, /<div class="window" id="workspaceApp" aria-busy="true">/);
  assert.match(desktopHtml, /id="hdrName">Loading your workspace…/);
  assert.match(desktopHtml, /id="hdrSub">Loading your agents…/);
  assert.match(desktopHtml, /document\.getElementById\('workspaceApp'\)\?\.removeAttribute\('aria-busy'\)/);
});

test('authenticated sidebar agents remain switchable while the sample fixture stays display-only', () => {
  assert.match(desktopHtml, /html\[data-review-fixture="true"\] \.saved-agent-list-row\{cursor:default;pointer-events:none\}/);
  assert.match(desktopHtml, /html:not\(\[data-review-fixture="true"\]\) \.saved-agent-list-row\{cursor:pointer;pointer-events:auto\}/);
  assert.match(desktopHtml, /row\.addEventListener\('click', \(\) => selectDesktopAgent\(agent\.id\)\)/);
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
