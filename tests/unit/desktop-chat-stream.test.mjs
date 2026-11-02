import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopHtml = fs.readFileSync(path.resolve(testDir, '../../apps/web/public/desktop-preview.html'), 'utf8');


test('desktop chat progressively renders answers, removes the completed progress card, and preserves Scout action cues', () => {
  assert.match(desktopHtml, /headers:\s*\{\s*Accept:\s*'text\/event-stream',\s*'Content-Type':\s*'application\/json',\s*\.\.\.\(wantsResearch/);
  assert.match(desktopHtml, /\['delta', 'avatar_cue', 'tool_approval_required', 'research_status', 'done', 'error'\]\.includes\(name\)/);
  assert.match(desktopHtml, /const answerText = assistantRow\?\.querySelector\('\.chat-answer-text'\)/);
  assert.match(desktopHtml, /renderChatMarkdown\(answerText, replyText, \{ streaming: true \}\)/);
  assert.match(desktopHtml, /renderChatMarkdown\(answerText, reply\)/);
  assert.match(desktopHtml, /className = 'chat-live-status'/);
  assert.match(desktopHtml, /className = 'chat-typing-indicator'/);
  assert.match(desktopHtml, /className = 'chat-typing-dot'/);
  assert.match(desktopHtml, /for \(let index = 0; index < 3; index \+= 1\)/);
  assert.match(desktopHtml, /text\.append\(liveStatus, typingIndicator\)/);
  assert.match(desktopHtml, /@keyframes chatTypingBounce/);
  assert.match(desktopHtml, /\.chat-typing-dot:nth-child\(2\) \{ animation-delay:\.14s; \}/);
  assert.match(desktopHtml, /\.chat-typing-dot:nth-child\(3\) \{ animation-delay:\.28s; \}/);
  assert.match(desktopHtml, /\.chat-typing-dot \{ animation:none; opacity:\.75; transform:none; \}/);
  assert.match(desktopHtml, /function setChatLiveStatus\(row, stage\)/);
  assert.match(desktopHtml, /position:absolute!important; width:1px!important/);
  assert.match(desktopHtml, /Reply complete\./);
  assert.doesNotMatch(desktopHtml, /chat-progress|chat-thinking-dots|Prompt received|Streaming answer/);
  assert.match(desktopHtml, /function appendChatProviderAttribution\(row, attribution\)/);
  assert.match(desktopHtml, /Your workspace agent tools are available automatically in chat/);
  assert.match(desktopHtml, /Every write pauses for your explicit approval/);
  assert.doesNotMatch(desktopHtml, /chatAgentMode|agentMode = true|Agent mode · workspace tools/);
  assert.match(desktopHtml, /function renderWorkspaceApprovalCard\(row, payload, threadAgentId\)/);
  assert.match(desktopHtml, /fetch\('\/api\/chat\/tool-approval'/);
  assert.match(desktopHtml, /if \(lastAssistantRow && Array\.isArray\(data\.pendingActions\)\)/);
  assert.match(desktopHtml, /const candidate = payload\?\.attribution/);
  assert.match(desktopHtml, /appendChatProviderAttribution\(assistantRow, replyAttribution\)/);
  assert.match(desktopHtml, /note\.textContent = `Provider: \$\{provider\} · Model: \$\{model\}`/);
  assert.match(desktopHtml, /chat-streaming \.chat-answer-text::after/);
  assert.match(desktopHtml, /function playScoutAvatarCue\(cue, requestAgentId\)/);
  assert.match(desktopHtml, /function playAvatarEmotion\(cue, requestAgentId, replyRow\)/);
  assert.match(desktopHtml, /function launchAvatarMoodIcon\(svg, cue\)/);
  assert.match(desktopHtml, /launchAvatarMoodIcon\(replyAvatar, cue\)/);
  assert.match(desktopHtml, /\.avatar-mood-burst \{ position:fixed; z-index:9999/);
  assert.match(desktopHtml, /@keyframes avatarMoodBurstLift/);
  assert.match(desktopHtml, /\.avatar-mood-burst-static \{ animation:avatarMoodBurstFade 650ms/);
  assert.match(desktopHtml, /payload\?\.avatar === 'emotion'/);
  assert.match(desktopHtml, /playAvatarEmotion\(payload\.cue, requestAgentId, assistantRow \|\| pendingRow\)/);
  assert.match(desktopHtml, /\.agent-avatar-art\.avatar-mood-curious/);
  assert.match(desktopHtml, /\.agent-avatar-art\[class\*="avatar-mood-"\] \{ animation:none!important; filter:brightness\(1\.4\) saturate\(1\.25\) drop-shadow\(0 0 8px rgba\(245,185,66,\.95\)\); \}/);
  assert.ok(desktopHtml.includes('translateY(-11px)'), 'the excited reaction has a clearly visible bounce');
  assert.ok(desktopHtml.includes('drop-shadow(0 0 10px rgba(245,185,66,1))'), 'the excited reaction includes a strong glow');
  for (const cue of ['happy', 'curious', 'thoughtful', 'empathetic', 'excited', 'concerned']) {
    const keyframeName = `avatarMood${cue[0].toUpperCase()}${cue.slice(1)}`;
    assert.ok(desktopHtml.includes(`.agent-avatar-art.avatar-mood-${cue} {`), `animation is mapped for ${cue}`);
    assert.ok(desktopHtml.includes(`@keyframes ${keyframeName}`), `keyframes are defined for ${cue}`);
  }
  assert.match(desktopHtml, /payload\?\.avatar === 'magnifier'/);
  const cueHandlerStart = desktopHtml.indexOf('  function playScoutAvatarCue');
  const cueHandlerEnd = desktopHtml.indexOf('  function runAvatarEmotionQueue', cueHandlerStart);
  const cueHandler = desktopHtml.slice(cueHandlerStart, cueHandlerEnd);
  assert.match(cueHandler, /document\.getElementById\('savedAgentAvatar'\)\?\.querySelector\('\.agent-avatar-art'\)/);
  assert.doesNotMatch(cueHandler, /hdrAvatar|chat-reply-avatar/, 'Scout action cues stay on the selected sidebar avatar');
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

test('workspace approval cards render reviewed values as text and call the approval endpoint only on a button action', async () => {
  const start = desktopHtml.indexOf('  function renderWorkspaceApprovalCard');
  const end = desktopHtml.indexOf('  async function decideWorkspaceToolApproval', start);
  assert.ok(start >= 0 && end > start);
  const source = desktopHtml.slice(start, end);
  class MockNode {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.listeners = {};
      this.className = '';
      this.textContent = '';
      this.type = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelector(selector) {
      if (selector.startsWith('[data-workspace-action-id=')) {
        const id = selector.match(/"([^"]+)"/)?.[1];
        return this.children.find((child) => child.dataset.workspaceActionId === id) || null;
      }
      return null;
    }
    get childElementCount() { return this.children.length; }
  }
  const document = { createElement(tag) { return new MockNode(tag); } };
  const decisions = [];
  const renderCard = new Function('document', 'decideWorkspaceToolApproval', `${source}; return renderWorkspaceApprovalCard;`)(
    document,
    (...args) => { decisions.push(args); },
  );
  const body = new MockNode('div');
  const row = { querySelector(selector) { return selector === '.agent-msg-body' ? body : null; } };
  const actionId = 'A'.repeat(32);
  const payload = {
    actionId,
    action: {
      title: 'Rename workspace',
      summary: 'Change the workspace display name.',
      fields: [{ label: 'Workspace name', before: 'Old name', value: '<script>not markup</script>' }],
    },
  };
  renderCard(row, payload, 'agent-1');
  assert.equal(body.children.length, 1);
  const card = body.children[0];
  assert.equal(card.dataset.workspaceActionId, actionId);
  assert.equal(card.children[0].textContent, 'Rename workspace');
  assert.equal(card.children[1].textContent, 'Change the workspace display name.');
  const list = card.children.find((child) => child.className === 'workspace-tool-approval-fields');
  assert.ok(list);
  assert.equal(list.children[0].children[1].textContent, 'Old name → <script>not markup</script>');
  assert.equal(card.children.at(-1).children[0].textContent, 'Approve change');
  assert.equal(card.children.at(-1).children[1].textContent, 'Cancel');
  assert.equal(decisions.length, 0, 'rendering a proposal does not approve it');
  card.children.at(-1).children[0].listeners.click();
  assert.deepEqual(decisions[0], [actionId, 'approve', card, 'agent-1']);
  card.children.at(-1).children[1].listeners.click();
  assert.deepEqual(decisions[1], [actionId, 'reject', card, 'agent-1']);
  renderCard(row, payload, 'agent-1');
  assert.equal(body.children.length, 1, 'reloaded proposals do not duplicate approval cards');
});

test('approving a workspace change refreshes live workspace data before reloading chat history', async () => {
  const start = desktopHtml.indexOf('  async function decideWorkspaceToolApproval');
  const end = desktopHtml.indexOf('\n\n  function runScoutCueQueue', start);
  assert.ok(start >= 0 && end > start);
  const source = desktopHtml.slice(start, end);
  const makeHarness = (approvalStatus) => {
    const calls = [];
    const status = { textContent: '' };
    const controls = [{ disabled: false }];
    const card = {
      dataset: {},
      querySelectorAll() { return controls; },
      querySelector(selector) { return selector === '.workspace-tool-approval-status' ? status : null; },
    };
    const fetch = async (url, options) => {
      calls.push(['approval', url, options]);
      return {
        status: 200,
        ok: true,
        async json() {
          return {
            status: approvalStatus,
            message: approvalStatus === 'approved' ? 'Updated Scout.' : 'Cancelled the proposed change.',
            historyUserMessage: `${approvalStatus} workspace change: Update Scout.`,
          };
        },
      };
    };
    const loadWorkspace = async (options) => { calls.push(['workspace', options]); return true; };
    const loadHistory = async (agentId) => { calls.push(['history', agentId]); };
    const decide = new Function(
      'fetch', 'location', 'loadAuthenticatedWorkspace', 'loadChatHistory', 'selectedAgentId', 'syncChatComposer', 'chatNotice',
      `${source}; return decideWorkspaceToolApproval;`,
    )(fetch, { replace() {} }, loadWorkspace, loadHistory, 'agent-1', () => {}, '');
    return { card, calls, controls, decide, status };
  };

  const approved = makeHarness('approved');
  await approved.decide('A'.repeat(32), 'approve', approved.card, 'agent-1');
  assert.deepEqual(approved.calls.map(([kind, value]) => [kind, value]), [
    ['approval', '/api/chat/tool-approval'],
    ['workspace', { quiet: true }],
    ['history', 'agent-1'],
  ]);
  assert.equal(approved.card.dataset.state, 'approved');
  assert.equal(approved.status.textContent, 'Updated Scout.');
  assert.equal(approved.controls[0].disabled, true);

  const rejected = makeHarness('rejected');
  await rejected.decide('B'.repeat(32), 'reject', rejected.card, 'agent-1');
  assert.deepEqual(rejected.calls.map(([kind, value]) => [kind, value]), [
    ['approval', '/api/chat/tool-approval'],
    ['history', 'agent-1'],
  ]);
});

test('quiet workspace refresh renders current data without replacing the app on a transient fetch failure', async () => {
  const start = desktopHtml.indexOf('  async function loadAuthenticatedWorkspace');
  const end = desktopHtml.indexOf('  function newAgentErrorCopy', start);
  assert.ok(start >= 0 && end > start);
  const source = desktopHtml.slice(start, end);
  const makeLoader = (fetchImpl) => {
    const rendered = [];
    const state = { unavailable: 0, chatAvailabilityLoads: 0, reviewFixtures: 0 };
    const loader = new Function(
      'fetchUiRead', 'setUiWait', 'location', 'isLocalReviewHost', 'renderLocalReviewFixture', 'renderAuthenticatedWorkspace', 'loadChatAvailability', 'setWorkspaceUnavailable',
      `${source}; return loadAuthenticatedWorkspace;`,
    )(
      fetchImpl,
      () => {},
      { replace() {} },
      () => false,
      () => { state.reviewFixtures += 1; },
      (data) => { rendered.push(data); },
      () => { state.chatAvailabilityLoads += 1; },
      () => { state.unavailable += 1; },
    );
    return { loader, rendered, state };
  };
  const latestBootstrap = { agents: [{ id: 'agent-1', settings: { color: '#ff7777' } }] };
  const success = makeLoader(async (url, options) => {
    assert.equal(url, '/api/workspace/bootstrap');
    assert.equal(options.credentials, 'same-origin');
    return { status: 200, ok: true, async json() { return latestBootstrap; } };
  });
  assert.equal(await success.loader({ quiet: true }), true);
  assert.deepEqual(success.rendered, [latestBootstrap]);
  assert.equal(success.state.chatAvailabilityLoads, 1);
  assert.equal(success.state.unavailable, 0);

  const failure = makeLoader(async () => { throw new Error('temporary network error'); });
  assert.equal(await failure.loader({ quiet: true }), false);
  assert.equal(failure.state.unavailable, 0, 'quiet refresh leaves the already-loaded workspace intact');
  assert.equal(await failure.loader(), false);
  assert.equal(failure.state.unavailable, 1, 'initial non-quiet load still reports a workspace failure');
});

test('composer accent follows the selected agent color and updates across agent changes', () => {
  const helperStart = desktopHtml.indexOf('  function setSelectedAgentComposerAccent');
  const helperEnd = desktopHtml.indexOf('  function findSelectedChatAgent', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperSource = desktopHtml.slice(helperStart, helperEnd);
  const applied = [];
  const document = { documentElement: { style: { setProperty(name, value) { applied.push([name, value]); } } } };
  const safeAvatarColor = (color) => /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#32d583';
  const setAccent = new Function(
    'currentBootstrap', 'safeAvatarColor', 'document',
    `${helperSource}; return setSelectedAgentComposerAccent;`,
  )({ onboarding: { profile: { agent: { color: '#4c8dff' } } } }, safeAvatarColor, document);

  setAccent({ settings: { color: '#ff7777' } });
  setAccent({ color: '#b57cff' });
  setAccent(null);
  assert.deepEqual(applied, [
    ['--agent-accent', '#ff7777'],
    ['--agent-accent', '#b57cff'],
    ['--agent-accent', '#4c8dff'],
  ]);
  assert.match(desktopHtml, /border-color:color-mix\(in srgb,var\(--agent-accent\)/);
  assert.match(desktopHtml, /\.composer-pill:focus-within\s*\{[^}]*border-color:\s*var\(--agent-accent\)/);
  assert.match(desktopHtml, /:root\[data-theme="light"\] \.composer-pill:focus-within\{border-color:var\(--agent-accent\)/);

  const selectionStart = desktopHtml.indexOf('  function selectDesktopAgent');
  const selectionEnd = desktopHtml.indexOf('  function chatErrorCopy', selectionStart);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
  assert.match(desktopHtml.slice(selectionStart, selectionEnd), /setSelectedAgentComposerAccent\(agent\)/);
  const bootstrapStart = desktopHtml.indexOf('  function renderAuthenticatedWorkspace');
  const bootstrapEnd = desktopHtml.indexOf('  async function loadAuthenticatedWorkspace', bootstrapStart);
  assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart);
  assert.match(desktopHtml.slice(bootstrapStart, bootstrapEnd), /setSelectedAgentComposerAccent\(agent\)/);
});

test('pending assistant messages render three decorative bouncing dots and an accessible typing status', () => {
  const start = desktopHtml.indexOf('  function createAssistantChatMessage');
  const end = desktopHtml.indexOf('  function appendChatProviderAttribution', start);
  assert.ok(start >= 0 && end > start);
  const source = desktopHtml.slice(start, end);
  class MockNode {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
  }
  const streamInner = new MockNode('div');
  const chatStream = { scrollTop: 0, scrollHeight: 120 };
  const document = {
    createElement(tag) { return new MockNode(tag); },
    getElementById(id) { return id === 'streamInner' ? streamInner : id === 'chatStream' ? chatStream : null; },
  };
  const createMessage = new Function('document', 'findSelectedChatAgent', 'objectAvatarSvg', 'renderChatMarkdown', `${source}; return createAssistantChatMessage;`)(
    document,
    () => ({ name: 'Idea Generator', avatar: 'lightbulb', settings: { color: '#32d583' } }),
    () => '<svg></svg>',
    () => { throw new Error('pending messages do not render Markdown'); },
  );
  const row = createMessage('Thinking...', { pending: true });
  assert.match(row.className, /chat-pending/);
  assert.equal(streamInner.children[0], row);
  assert.equal(chatStream.scrollTop, chatStream.scrollHeight);
  const text = row.children[1].children[1];
  const [status, typingIndicator] = text.children;
  assert.equal(status.className, 'chat-live-status');
  assert.equal(status.attributes.role, 'status');
  assert.equal(status.attributes['aria-live'], 'polite');
  assert.equal(status.textContent, 'Preparing response.');
  assert.equal(typingIndicator.className, 'chat-typing-indicator');
  assert.equal(typingIndicator.attributes['aria-hidden'], 'true');
  assert.deepEqual(typingIndicator.children.map((dot) => dot.className), [
    'chat-typing-dot', 'chat-typing-dot', 'chat-typing-dot',
  ]);
});


test('allowlisted mood cues animate only the avatar attached to the message', () => {
  const start = desktopHtml.indexOf('  function runAvatarEmotionQueue');
  const end = desktopHtml.indexOf('  function setChatLiveStatus', start);
  assert.ok(start >= 0 && end > start);
  const source = desktopHtml.slice(start, end);
  const makeAvatar = () => {
    const classes = new Set();
    return {
      classes,
      svg: {
        isConnected: true,
        classList: {
          add(value) { classes.add(value); },
          remove(...values) { values.forEach((value) => classes.delete(value)); },
        },
        getBoundingClientRect() {},
      },
    };
  };
  const replyAvatar = makeAvatar();
  const sidebarAvatar = makeAvatar();
  const headerAvatar = makeAvatar();
  const document = {
    getElementById(id) { throw new Error(`Mood cues must not look up non-message avatar ${id}`); },
  };
  const timers = [];
  let reducedMotion = false;
  const window = {
    matchMedia() { return { matches: reducedMotion }; },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
  };
  const selectedAgent = { id: 'agent-1', avatar: 'bulb' };
  const launchedIcons = [];
  const playAvatarEmotion = new Function('window', 'document', 'findSelectedChatAgent', 'emotionDurations', 'launchAvatarMoodIcon', `
    const AVATAR_EMOTION_DURATIONS = emotionDurations;
    const AVATAR_EMOTION_IDS = new Set(Object.keys(AVATAR_EMOTION_DURATIONS));
    const AVATAR_EMOTION_CLASSES = Object.keys(AVATAR_EMOTION_DURATIONS).map((cue) => 'avatar-mood-' + cue);
    const avatarEmotionQueues = new WeakMap();
    const avatarEmotionTimers = new WeakMap();
    ${source}
    return playAvatarEmotion;
  `)(window, document, () => selectedAgent, {
    happy: 1280, curious: 1200, thoughtful: 1300, empathetic: 1200, excited: 1300, concerned: 1100,
  }, (svg, cue) => launchedIcons.push({ svg, cue }));
  const row = {
    querySelector(selector) {
      assert.equal(selector, '.chat-reply-avatar .agent-avatar-art');
      return replyAvatar.svg;
    },
  };
  playAvatarEmotion('curious', 'agent-1', row);
  assert.equal(launchedIcons.length, 1);
  assert.equal(launchedIcons[0].svg, replyAvatar.svg);
  assert.equal(launchedIcons[0].cue, 'curious');
  assert.ok(replyAvatar.classes.has('avatar-mood-curious'));
  assert.equal(sidebarAvatar.classes.size, 0);
  assert.equal(headerAvatar.classes.size, 0);
  assert.deepEqual(timers.map((timer) => timer.delay), [1280]);
  timers[0].callback();
  assert.equal(replyAvatar.classes.size, 0);
  reducedMotion = true;
  playAvatarEmotion('excited', 'agent-1', row);
  assert.equal(launchedIcons.length, 2);
  assert.equal(launchedIcons[1].cue, 'excited');
  assert.ok(replyAvatar.classes.has('avatar-mood-excited'));
  assert.equal(sidebarAvatar.classes.size, 0);
  assert.equal(headerAvatar.classes.size, 0);
  assert.deepEqual(timers.slice(1).map((timer) => timer.delay), [850]);
  timers[1].callback();
  assert.equal(replyAvatar.classes.size, 0);
  playAvatarEmotion('happy', 'agent-1', null);
  playAvatarEmotion('not-allowlisted', 'agent-1', row);
  playAvatarEmotion('happy', 'different-agent', row);
  assert.equal(launchedIcons.length, 2, 'missing, invalid, or stale message cues do not animate');
  assert.equal(timers.length, 2, 'only the message avatar receives an animation timer');
});

test('mood SVG follows the bouncing avatar as it rises and fades, with a reduced-motion static fallback', () => {
  const iconsStart = desktopHtml.indexOf('  const AVATAR_EMOTION_ICON_SVGS = Object.freeze({');
  const iconsClose = desktopHtml.indexOf('\n  });', iconsStart);
  const launchStart = desktopHtml.indexOf('  function launchAvatarMoodIcon', iconsClose);
  const launchEnd = desktopHtml.indexOf('  function runAvatarEmotionQueue', launchStart);
  assert.ok(iconsStart >= 0 && iconsClose > iconsStart && launchStart > iconsClose && launchEnd > launchStart);
  const iconsSource = desktopHtml.slice(iconsStart, iconsClose + 6);
  const launchSource = desktopHtml.slice(launchStart, launchEnd);
  const created = [];
  const removedTimers = [];
  const document = {
    documentElement: { clientWidth: 800, clientHeight: 600 },
    body: { children: [], append(node) { this.children.push(node); } },
    createElement(tag) {
      assert.equal(tag, 'div');
      const node = {
        attributes: {},
        removed: false,
        style: { values: {}, setProperty(name, value) { this.values[name] = String(value); } },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        remove() {
          this.removed = true;
          const index = document.body.children.indexOf(this);
          if (index >= 0) document.body.children.splice(index, 1);
        },
      };
      created.push(node);
      return node;
    },
  };
  let reducedMotion = false;
  let currentRect = { left: 40, top: 60, width: 40, height: 40 };
  let frameCallback = null;
  let frameId = 0;
  const cancelledFrames = [];
  const timers = [];
  const window = {
    matchMedia() { return { matches: reducedMotion }; },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout(id) { removedTimers.push(id); },
    requestAnimationFrame(callback) { frameCallback = callback; frameId += 1; return frameId; },
    cancelAnimationFrame(id) { cancelledFrames.push(id); },
  };
  const launch = new Function('window', 'document', `
    ${iconsSource}
    let activeAvatarMoodBurst = null;
    let activeAvatarMoodBurstTimer = null;
    let activeAvatarMoodBurstFrame = null;
    ${launchSource}
    return { launchAvatarMoodIcon, AVATAR_EMOTION_ICON_SVGS };
  `)(window, document);
  assert.deepEqual(Object.keys(launch.AVATAR_EMOTION_ICON_SVGS), [
    'happy', 'curious', 'thoughtful', 'empathetic', 'excited', 'concerned',
  ]);
  const avatar = { getBoundingClientRect: () => currentRect };
  launch.launchAvatarMoodIcon(avatar, 'excited');
  const flying = created[0];
  assert.equal(flying.className, 'avatar-mood-burst');
  assert.equal(flying.attributes['aria-hidden'], 'true');
  assert.match(flying.innerHTML, /^<svg /);
  assert.equal(flying.style.left, '42px');
  assert.equal(flying.style.top, '62px');
  assert.equal(flying.style.values['--mood-drift-mid-x'], '3px');
  assert.equal(flying.style.values['--mood-rise-mid-y'], '-14px');
  assert.equal(flying.style.values['--mood-drift-x'], '8px');
  assert.equal(flying.style.values['--mood-rise-y'], '-38px');
  assert.equal(flying.style.values['--mood-flight-x'], undefined, 'the icon stays beside the avatar rather than crossing to screen center');
  assert.equal(timers[0].delay, 1040);
  currentRect = { left: 44, top: 59, width: 40, height: 40 };
  frameCallback();
  assert.equal(flying.style.left, '46px', 'the burst follows the animated avatar horizontally');
  assert.equal(flying.style.top, '61px', 'the burst follows the animated avatar vertically');
  timers[0].callback();
  assert.deepEqual(cancelledFrames, [2], 'avatar-follow animation is cleaned up when the burst fades');
  assert.equal(flying.removed, true);
  assert.equal(document.body.children.length, 0);

  reducedMotion = true;
  launch.launchAvatarMoodIcon(avatar, 'happy');
  const staticIcon = created[1];
  assert.equal(staticIcon.className, 'avatar-mood-burst avatar-mood-burst-static');
  assert.equal(staticIcon.style.values['--mood-rise-y'], undefined, 'reduced motion keeps the icon still');
  assert.equal(timers[1].delay, 650);
  timers[1].callback();
  assert.equal(staticIcon.removed, true);
  assert.equal(removedTimers.length, 0);
  launch.launchAvatarMoodIcon(avatar, 'unsupported');
  assert.equal(created.length, 2, 'unallowlisted cues cannot create SVG overlays');
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
  assert.match(desktopHtml, /<select id="chatModelId" disabled/);
  assert.doesNotMatch(desktopHtml, /id="chatModelId"[^>]*type="text"/);
  assert.match(desktopHtml, /function loadAdminChatModelCatalog\(\)/);
  assert.match(desktopHtml, /fetch\(`\/api\/chat\/models\$\{query\}`/);
  assert.match(desktopHtml, /Live catalog unavailable; only the configured model is selectable/);
  assert.match(desktopHtml, /overrides apply to the next message only/i);
  assert.match(desktopHtml, /data\?\.adminControls !== true/);
  assert.match(desktopHtml, /function renderAdminChatControls\(data\)/);
  assert.match(desktopHtml, /Configured primary \(dynamic\)/);
  assert.match(desktopHtml, /provider\.isFallback \? 'marked backup' : 'manual target'/);
  assert.match(desktopHtml, /requestBody\.providerKey = providerKey/);
  assert.match(desktopHtml, /requestBody\.modelId = modelId/);
  assert.match(desktopHtml, /chatProviderSelect\?\.addEventListener\('change', \(\) => \{ void loadAdminChatModelCatalog\(\); \}\)/);
  assert.match(desktopHtml, /chatModelIdSelect\?\.addEventListener\('change'/);
  assert.doesNotMatch(desktopHtml, /syncAdminChatModelInput|syncChatAdminModelInput/);
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

test('admin model dropdown fetches the selected provider catalog and retains only its configured model on failure', async () => {
  const start = desktopHtml.indexOf('  function cleanAdminChatModelText');
  const end = desktopHtml.indexOf('  function resetAdminChatOverrides', start);
  assert.ok(start >= 0 && end > start);
  const helperSource = desktopHtml.slice(start, end);
  class MockSelect {
    constructor(value = '') { this.value = value; this.disabled = true; this.options = []; }
    replaceChildren(...children) {
      this.options = children;
      this.value = children[0]?.value || '';
    }
    append(option) {
      this.options.push(option);
      if (this.options.length === 1) this.value = option.value;
    }
  }
  const makeHarness = (fetchImpl) => {
    const elements = {
      adminChatControls: { hidden: false },
      chatProviderSelect: { value: 'manual-target' },
      chatModelId: new MockSelect(),
      adminChatCatalogStatus: { textContent: '' },
    };
    const document = {
      getElementById(id) { return elements[id] || null; },
      createElement(tag) { assert.equal(tag, 'option'); return { value: '', textContent: '' }; },
    };
    const harness = new Function('document', 'fetch', 'location', 'initialProviders', `
      let chatAdminProviders = initialProviders;
      let chatAdminCatalogLoadVersion = 0;
      let chatAdminModelWasEdited = false;
      let chatAdminCatalogProviderKey = '';
      let chatAdminConfiguredModelId = '';
      let chatAdminCatalogLoading = false;
      const chatAvailable = true;
      const chatPending = false;
      const chatHistoryLoading = false;
      function syncAdminChatControlsAvailability() {
        const modelSelect = document.getElementById('chatModelId');
        if (modelSelect) modelSelect.disabled = chatPending || chatHistoryLoading || chatAdminCatalogLoading || !chatAdminConfiguredModelId;
      }
      ${helperSource}
      return {
        load: loadAdminChatModelCatalog,
        state: () => ({ chatAdminModelWasEdited, chatAdminCatalogProviderKey, chatAdminConfiguredModelId, chatAdminCatalogLoading }),
      };
    `)(
      document,
      fetchImpl,
      { replace() {} },
      [
        { providerKey: 'primary', modelId: 'primary-model', isPrimary: true },
        { providerKey: 'manual-target', modelId: 'manual-configured', isPrimary: false },
      ],
    );
    return { ...harness, elements };
  };

  const successfulCalls = [];
  const successful = makeHarness(async (url, options) => {
    successfulCalls.push({ url, options });
    return {
      status: 200,
      ok: true,
      async json() {
        return {
          configuredModelId: 'manual-configured',
          catalogAvailable: true,
          models: [
            { id: 'manual-configured', displayName: 'Manual default' },
            { id: 'manual-v2', displayName: '<unsafe label>' },
          ],
        };
      },
    };
  });
  await successful.load();
  assert.equal(successfulCalls[0].url, '/api/chat/models?providerKey=manual-target');
  assert.equal(successfulCalls[0].options.credentials, 'same-origin');
  assert.deepEqual(successful.elements.chatModelId.options.map((option) => option.value), ['manual-configured', 'manual-v2']);
  assert.equal(successful.elements.chatModelId.options[0].textContent, 'Manual default · configured');
  assert.equal(successful.elements.chatModelId.options[1].textContent, '<unsafe label>');
  assert.equal(successful.elements.chatModelId.value, 'manual-configured');
  assert.match(successful.elements.adminChatCatalogStatus.textContent, /2 models available/);
  assert.deepEqual(successful.state(), {
    chatAdminModelWasEdited: false,
    chatAdminCatalogProviderKey: 'manual-target',
    chatAdminConfiguredModelId: 'manual-configured',
    chatAdminCatalogLoading: false,
  });

  const failed = makeHarness(async () => ({ status: 503, ok: false, async json() { throw new Error('must_not_parse'); } }));
  await failed.load();
  assert.deepEqual(failed.elements.chatModelId.options.map((option) => option.value), ['manual-configured']);
  assert.equal(failed.elements.chatModelId.value, 'manual-configured');
  assert.match(failed.elements.adminChatCatalogStatus.textContent, /catalog unavailable/i);
  assert.deepEqual(failed.state(), {
    chatAdminModelWasEdited: false,
    chatAdminCatalogProviderKey: 'manual-target',
    chatAdminConfiguredModelId: 'manual-configured',
    chatAdminCatalogLoading: false,
  });
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

test('send button is active only when text is typed and turns into a square stop button while awaiting a reply', () => {
  assert.match(desktopHtml, /\.comp-send:not\(:disabled\):not\(\.is-stop\)\{cursor:pointer;background:var\(--agent-accent/);
  assert.match(desktopHtml, /\.comp-send\.is-stop\{cursor:pointer;/);
  assert.match(desktopHtml, /const CHAT_SEND_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"/);
  assert.match(desktopHtml, /const CHAT_STOP_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"[^>]*><rect x="6" y="6" width="12" height="12"/);
  assert.match(desktopHtml, /sendButton\.classList\.add\('is-stop'\)/);
  assert.match(desktopHtml, /sendButton\.classList\.remove\('is-stop'\)/);
  assert.match(desktopHtml, /sendButton\.setAttribute\('aria-label', 'Stop generating'\)/);
  assert.match(desktopHtml, /stopChatMessage\(\)/);

  const syncStart = desktopHtml.indexOf('  function syncChatComposer');
  const syncEnd = desktopHtml.indexOf('  function appendUserChatMessage', syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart);
  const syncSource = desktopHtml.slice(syncStart, syncEnd);

  const input = { value: '', disabled: false, placeholder: '', setAttribute() {} };
  const sendButton = {
    disabled: true,
    classes: new Set(),
    classList: {
      add(cls) { sendButton.classes.add(cls); },
      remove(cls) { sendButton.classes.delete(cls); },
    },
    attrs: {},
    setAttribute(name, val) { sendButton.attrs[name] = val; },
    innerHTML: '',
  };
  const document = {
    getElementById(id) {
      if (id === 'chatInput') return input;
      if (id === 'chatSendButton') return sendButton;
      return null;
    },
    documentElement: { dataset: {} },
  };

  let chatPending = false;
  let chatAvailable = true;
  let chatHistoryReady = true;
  let chatHistoryLoading = false;
  let chatNotice = '';
  const currentBootstrap = { user: { id: 'usr-1' } };
  const findSelectedChatAgent = () => ({ id: 'agt-1', status: 'active' });
  const textById = () => {};
  const syncAdminChatControlsAvailability = () => {};

  const makeSync = (pendingState) => new Function(
    'document', 'findSelectedChatAgent', 'currentBootstrap', 'chatAvailable', 'chatHistoryReady',
    'chatHistoryLoading', 'chatPending', 'chatNotice', 'textById', 'syncAdminChatControlsAvailability',
    'CHAT_SEND_ICON_SVG', 'CHAT_STOP_ICON_SVG',
    `let dictationSession = null; function syncDictationControl() {} ${desktopHtml.slice(desktopHtml.indexOf('  function resizeChatInput('), desktopHtml.indexOf('  function syncChatComposer('))}; ${syncSource}; return syncChatComposer;`,
  )(
    document, findSelectedChatAgent, currentBootstrap, chatAvailable, chatHistoryReady,
    chatHistoryLoading, pendingState, chatNotice, textById, syncAdminChatControlsAvailability,
    '<svg class="send"></svg>', '<svg class="stop"></svg>',
  );

  // 1. Initial state: input empty -> sendButton disabled, not stop
  input.value = '';
  makeSync(false)();
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.classes.has('is-stop'), false);
  assert.equal(sendButton.innerHTML, '<svg class="send"></svg>');

  // 2. Text typed -> sendButton active (enabled), not stop
  input.value = 'Hello agent';
  makeSync(false)();
  assert.equal(sendButton.disabled, false);
  assert.equal(sendButton.classes.has('is-stop'), false);
  assert.equal(sendButton.innerHTML, '<svg class="send"></svg>');

  // 3. Text removed -> sendButton disabled again
  input.value = '   ';
  makeSync(false)();
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.classes.has('is-stop'), false);

  // 4. Message sent, waiting for reply (chatPending = true) -> square stop button, enabled
  input.value = '';
  makeSync(true)();
  assert.equal(sendButton.disabled, false);
  assert.equal(sendButton.classes.has('is-stop'), true);
  assert.equal(sendButton.attrs['aria-label'], 'Stop generating');
  assert.equal(sendButton.innerHTML, '<svg class="stop"></svg>');

  // 5. Reply finished (chatPending = false) -> back to send button
  makeSync(false)();
  assert.equal(sendButton.classes.has('is-stop'), false);
  assert.equal(sendButton.attrs['aria-label'], 'Send message');
  assert.equal(sendButton.innerHTML, '<svg class="send"></svg>');
  assert.equal(sendButton.disabled, true);
});

test('products card grid renders 3-per-row layout and collapses items beyond two rows (6 cards) behind Show more', () => {
  const start = desktopHtml.indexOf('  function safeChatMarkdownHref');
  const end = desktopHtml.indexOf('  function createAssistantChatMessage', start);
  assert.ok(start >= 0 && end > start);
  const rendererSource = desktopHtml.slice(start, end);

  class MockClassList {
    constructor() { this.classes = new Set(); }
    add(c) { this.classes.add(c); }
    remove(c) { this.classes.delete(c); }
    has(c) { return this.classes.has(c); }
    contains(c) { return this.classes.has(c); }
    toggle(c) {
      if (this.classes.has(c)) { this.classes.delete(c); return false; }
      this.classes.add(c); return true;
    }
    toString() { return Array.from(this.classes).join(' '); }
  }

  class MockNode {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.classList = new MockClassList();
      this.style = {};
      this.value = '';
      this.listeners = {};
    }
    get className() { return this.classList.toString(); }
    set className(val) {
      this.classList = new MockClassList();
      for (const c of String(val || '').split(/\s+/).filter(Boolean)) this.classList.add(c);
    }
    append(...nodes) {
      for (const n of nodes) {
        if (typeof n === 'string') this.children.push(new MockNode('#text'));
        else this.children.push(n);
      }
    }
    prepend(...nodes) {
      for (const n of nodes.reverse()) {
        this.children.unshift(typeof n === 'string' ? new MockNode('#text') : n);
      }
    }
    remove() { this.removed = true; }
    replaceChildren(...nodes) { this.children = nodes; this.value = ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    set textContent(value) { this.value = String(value); this.children = []; }
    get textContent() { return this.value + this.children.map((node) => node.textContent).join(''); }
    addEventListener(event, fn) {
      this.listeners[event] = this.listeners[event] || [];
      this.listeners[event].push(fn);
    }
    dispatchEvent(event) {
      const e = typeof event === 'string' ? { type: event, preventDefault() {} } : event;
      for (const fn of (this.listeners[e.type] || [])) fn(e);
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
      const results = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (sel.startsWith('.') && c.classList && c.classList.contains(sel.slice(1))) results.push(c);
          else if (c.tagName === sel) results.push(c);
          walk(c);
        }
      };
      walk(this);
      return results;
    }
  }

  const doc = {
    createElement(tag) { return new MockNode(tag); },
    createElementNS(ns, tag) { return new MockNode(tag); },
    createTextNode(val) { const n = new MockNode('#text'); n.textContent = val; return n; },
  };

  const { buildProductsCardGrid, renderChatMarkdown } = new Function(
    'document',
    'window',
    `${rendererSource}; return { buildProductsCardGrid, renderChatMarkdown };`,
  )(doc, { location: { href: 'https://kues.example/chat' } });

  // 1. Test 9 products (> 6 cards): collapses extra 3 cards and renders toggle button
  const nineProducts = [
    ':::products-grid',
    '1. **Ceramic Tabletop Bundle (4 Pieces)** by Studio Kera\n   ![Ceramic Bundle](https://example.com/c1.jpg)\n   - **Price:** $78.50 USD\n   - **Seller:** Studio Kera (studiokera.example.com)\n   - **Status:** In Stock\n   - **Link:** [View product](https://example.com/c1)\n   - **Evidence:** `sha256:d839bb045bb6...`',
    '2. **Classic Merino Wool Crewneck Sweater** by Nordic Knitwear\n   - **Price:** $84.00 USD\n   - **Seller:** Nordic Knitwear\n   - **Status:** In Stock',
    '3. **Dual-Sided Vegan Leather Desk Mat**\n   - **Price:** $38.00 USD',
    '4. **Solid Brass Architect Ruler 30cm**\n   - **Price:** $24.50 USD',
    '5. **Hardcover Linen Grid Notebook (A5)**\n   - **Price:** $22.00 USD',
    '6. **Stoneware Pour-Over Dripper & Mug Set**\n   - **Price:** $46.00 USD',
    '7. **Precision Mechanical Drafting Pencil**\n   - **Price:** $32.00 USD',
    '8. **Solid White Oak Desktop Organizer Tray**\n   - **Price:** $54.00 USD',
    '9. **Ribbed British Lambswool Knit Beanie**\n   - **Price:** $36.00 USD',
    ':::',
  ].join('\n\n');

  const grid = buildProductsCardGrid(nineProducts);
  assert.ok(grid, 'Grid container should be created');
  assert.ok(grid.classList.contains('products-grid-container'));
  assert.ok(grid.classList.contains('is-collapsed'), 'Container should start collapsed when cards > 6');

  const cards = grid.querySelectorAll('.product-card');
  assert.equal(cards.length, 9, 'All 9 product cards should be rendered in the DOM');

  const overflowCards = grid.querySelectorAll('.product-card-overflow');
  assert.equal(overflowCards.length, 3, 'Cards beyond 2 rows (6 cards) should have overflow class');

  const toggleBtn = grid.querySelector('.products-grid-toggle-btn');
  assert.ok(toggleBtn, 'Toggle button must be rendered for > 6 products');
  assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');
  assert.match(toggleBtn.textContent, /Show 3 more products/);

  // Click toggle to expand
  toggleBtn.dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(grid.classList.contains('is-collapsed'), false, 'Grid should not have is-collapsed class after expansion');
  assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(toggleBtn.textContent, 'Show less');

  // Click toggle again to collapse
  toggleBtn.dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(grid.classList.contains('is-collapsed'), true, 'Grid should collapse again on second click');
  assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');
  assert.match(toggleBtn.textContent, /Show 3 more products/);

  // 2. Test <= 6 products (5 products): fits within 2 rows, no toggle button
  const fiveProducts = [
    ':::products-grid',
    '1. **P1** by B1\n   - **Price:** $10.00 USD',
    '2. **P2** by B2\n   - **Price:** $20.00 USD',
    '3. **P3** by B3\n   - **Price:** $30.00 USD',
    '4. **P4** by B4\n   - **Price:** $40.00 USD',
    '5. **P5** by B5\n   - **Price:** $50.00 USD',
    ':::',
  ].join('\n\n');

  const smallGrid = buildProductsCardGrid(fiveProducts);
  assert.ok(smallGrid);
  assert.equal(smallGrid.classList.contains('is-collapsed'), false);
  assert.equal(smallGrid.querySelectorAll('.product-card').length, 5);
  assert.equal(smallGrid.querySelectorAll('.product-card-overflow').length, 0);
  assert.equal(smallGrid.querySelector('.products-grid-toggle-btn'), null, 'No toggle button when cards <= 6');

  // 3. Test renderChatMarkdown end-to-end integration with products grid block
  const root = new MockNode('div');
  renderChatMarkdown(root, `Discovered products:\n\n${nineProducts}\n\n*Source:* Channel3 (Sample Fixtures)`);
  const rootGrid = root.querySelector('.products-grid-container');
  assert.ok(rootGrid, 'renderChatMarkdown should render .products-grid-container');
  assert.equal(rootGrid.querySelectorAll('.product-card').length, 9);

  // 4. Test zero price and unknown seller sanitation, plus media preview click behavior
  let modalOpenedItem = null;
  const mockWindow = {
    location: { href: 'https://kues.example/chat' },
  };
  const mockGlobal = {
    openProductImageModal: (item) => { modalOpenedItem = item; },
  };

  const edgeProducts = [
    ':::products-grid',
    '1. **Zero Price Product**\n   ![Zero](https://example.com/z.jpg)\n   - **Price:** $0.00 USD\n   - **Seller:** Unknown seller (vendor.example.com)\n   - **Status:** In Stock',
    ':::',
  ].join('\n\n');

  const edgeGrid = buildProductsCardGrid(edgeProducts);
  assert.ok(edgeGrid);
  const edgeCard = edgeGrid.querySelector('.product-card');
  assert.ok(edgeCard);

  const priceNode = edgeCard.querySelector('.product-card-price');
  assert.equal(priceNode.textContent, 'Price on request', 'Zero dollar price should be sanitized to Price on request');

  const merchantNode = edgeCard.querySelector('.product-card-merchant');
  assert.doesNotMatch(merchantNode.textContent, /Unknown seller/i, 'Unknown seller should never be displayed on card');
  assert.match(merchantNode.textContent, /vendor\.example\.com/, 'Should display merchant domain when seller is unknown');

  const mediaNode = edgeCard.querySelector('.product-card-media');
  assert.equal(mediaNode.getAttribute('role'), 'button');
  assert.ok(edgeCard.querySelector('.product-card-zoom-badge'), 'Zoom preview badge should be present');

  // Verify lightbox modal exists in the HTML page
  assert.ok(desktopHtml.includes('id="productImageOverlayBackdrop"'), 'Lightbox backdrop modal must exist in HTML');
  assert.ok(desktopHtml.includes('id="productModalImage"'), 'Modal image container must exist');
  assert.ok(desktopHtml.includes('id="productModalBuyBtn"'), 'Modal Buy with Agent button must exist in HTML');

  // 5. Test Buy action button on product cards
  const actionsNode = edgeCard.querySelector('.product-card-actions');
  assert.ok(actionsNode, 'Product card should contain .product-card-actions container');
  const buyBtn = edgeCard.querySelector('.product-card-buy-btn');
  assert.ok(buyBtn, 'Product card should render .product-card-buy-btn button');
  assert.match(buyBtn.textContent, /Buy/i, 'Buy button should have Buy text');
  assert.ok(desktopHtml.includes('function requestProductPurchase'), 'requestProductPurchase handler must be defined');

  // 6. Test filter badges parsing and live sorting in desktop chat
  const filteredProductsMarkdown = [
    ':::products-grid',
    '[Filters: Under $100 USD · In Stock Only · Price: Low to High]',
    '1. **Expensive Keyboard**\n   - **Price:** $150.00 USD\n   - **Status:** In Stock',
    '2. **Cheap Keyboard**\n   - **Price:** $45.00 USD\n   - **Status:** In Stock',
    '3. **Mid-range Keyboard**\n   - **Price:** $85.00 USD\n   - **Status:** In Stock',
    '4. **Out of Stock Keyboard**\n   - **Price:** $30.00 USD\n   - **Status:** Out of Stock',
    ':::',
  ].join('\n\n');

  const filteredGrid = buildProductsCardGrid(filteredProductsMarkdown);
  assert.ok(filteredGrid);

  const toolbar = filteredGrid.querySelector('.products-grid-toolbar');
  assert.ok(toolbar, 'Products grid should render .products-grid-toolbar');

  const filterBadges = filteredGrid.querySelectorAll('.product-filter-badge');
  assert.equal(filterBadges.length, 3, 'All 3 filter badges should be rendered');
  assert.equal(filterBadges[0].textContent, 'Under $100 USD');
  assert.equal(filterBadges[1].textContent, 'In Stock Only');
  assert.equal(filterBadges[2].textContent, 'Price: Low to High');

  const sortBtns = filteredGrid.querySelectorAll('.products-sort-btn');
  assert.equal(sortBtns.length, 3, 'Default, Price: Low to High, and Price: High to Low sort buttons should exist');

  const inStockFilterBtn = filteredGrid.querySelector('.products-filter-toggle-btn');
  assert.ok(inStockFilterBtn, 'In Stock Only toggle button should exist');

  // Initial sort was Low to High with In Stock Only
  const initialCards = filteredGrid.querySelectorAll('.product-card');
  assert.equal(initialCards[0].querySelector('.product-card-title').textContent, 'Cheap Keyboard');

  // Test live sorting: click Price: High to Low
  const descSortBtn = Array.from(sortBtns).find((b) => b.textContent.includes('High to Low'));
  assert.ok(descSortBtn);
  descSortBtn.dispatchEvent({ type: 'click', preventDefault() {} });

  const descCards = filteredGrid.querySelectorAll('.product-card');
  assert.equal(descCards[0].querySelector('.product-card-title').textContent, 'Expensive Keyboard');
  assert.equal(descSortBtn.classList.contains('is-active'), true);

  // Test live sorting: click Default
  const defaultSortBtn = Array.from(sortBtns).find((b) => b.textContent === 'Default');
  assert.ok(defaultSortBtn);
  defaultSortBtn.dispatchEvent({ type: 'click', preventDefault() {} });

  const defaultCards = filteredGrid.querySelectorAll('.product-card');
  assert.equal(defaultCards[0].querySelector('.product-card-title').textContent, 'Expensive Keyboard');
  assert.equal(defaultSortBtn.classList.contains('is-active'), true);

  // Toggle in-stock filter off (should reveal out-of-stock product)
  inStockFilterBtn.dispatchEvent({ type: 'click', preventDefault() {} });
  const allCards = filteredGrid.querySelectorAll('.product-card');
  assert.equal(allCards.length, 4, 'All 4 cards should be visible when in-stock filter is toggled off');

  // 7. Test Multi-Product Bundle Bag and Bundle Bar interactions
  const bundleBar = filteredGrid.querySelector('.products-bundle-bar');
  assert.ok(bundleBar, 'Products grid should render .products-bundle-bar container');
  assert.equal(bundleBar.classList.contains('is-visible'), false, 'Bundle bar should start hidden');

  const bagBtns = filteredGrid.querySelectorAll('.product-card-bag-btn');
  assert.equal(bagBtns.length, 4, 'Each product card should have a + Bag button');
  assert.match(bagBtns[0].textContent, /Bag/i);

  // Add first product to bag ($150 Expensive Keyboard)
  bagBtns[0].dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(bundleBar.classList.contains('is-visible'), true, 'Bundle bar should show when item is added');
  assert.match(bundleBar.querySelector('.bundle-bar-badge').textContent, /1 item/);
  assert.match(bundleBar.querySelector('.bundle-bar-total').textContent, /\$150\.00 USD/);

  // Add second product to bag ($45 Cheap Keyboard)
  bagBtns[1].dispatchEvent({ type: 'click', preventDefault() {} });
  assert.match(bundleBar.querySelector('.bundle-bar-badge').textContent, /2 items/);
  assert.match(bundleBar.querySelector('.bundle-bar-total').textContent, /\$195\.00 USD/);

  // Verify Clear button resets bundle
  const clearBtn = bundleBar.querySelector('.bundle-bar-clear-btn');
  assert.ok(clearBtn);
  clearBtn.dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(bundleBar.classList.contains('is-visible'), false, 'Bundle bar should hide when cleared');


  const loadingRoot = new MockNode('div');
  renderChatMarkdown(loadingRoot, ':::products-grid\n1. **Partial**', { streaming: true });
  const pendingPanel = loadingRoot.querySelector('.products-loading');
  assert.ok(pendingPanel, 'streamed product details get a loading panel, not partial cards');
  assert.equal(loadingRoot.querySelectorAll('.product-card').length, 0);
  renderChatMarkdown(loadingRoot, ':::products-grid\n1. **Partial**\n- **Price:** $50', { streaming: true });
  assert.equal(loadingRoot.querySelector('.products-loading'), pendingPanel, 'loading panel remains stable between deltas');
  renderChatMarkdown(loadingRoot, ':::products-grid\n1. **Partial**', { interrupted: true });
  assert.match(loadingRoot.textContent, /interrupted/);
  assert.equal(loadingRoot.querySelectorAll('button').length, 0);
  renderChatMarkdown(loadingRoot, ':::products-grid\n:::\n');
  assert.match(loadingRoot.textContent, /No product matches/);

  assert.ok(desktopHtml.includes('function requestBundlePurchase'), 'requestBundlePurchase handler must be defined');
});

test('admin model panel anchors below its header picker and composer accent sweeps with input length', () => {
  const headerStart = desktopHtml.indexOf('<header class="chat-header">');
  const panelStart = desktopHtml.indexOf('id="adminChatControls"');
  const composerStart = desktopHtml.indexOf('<footer class="composer-area"');
  assert.ok(headerStart >= 0 && panelStart > headerStart && panelStart < composerStart, 'provider panel belongs to the header, not after the composer');
  assert.match(desktopHtml, /id="adminProviderAccordion"/);
  assert.match(desktopHtml, /data-edge="top" pathLength="100"/);
  assert.match(desktopHtml, /data-edge="bottom" pathLength="100"/);
  assert.match(desktopHtml, /vector-effect:non-scaling-stroke/);
  assert.match(desktopHtml, /stroke-dasharray:100/);
  assert.match(desktopHtml, /path\.style\.strokeDashoffset = String\(100 \* \(1 - composerLiveProgress\)\)/);
  assert.match(desktopHtml, /send\.getBoundingClientRect\(\)\.left/);
  assert.match(desktopHtml, /@property --composer-progress\{syntax:"<percentage>";inherits:true/);
  assert.match(desktopHtml, /trigger\.addEventListener\('click', \(event\) => \{\s*event\.stopPropagation\(\)/);
  assert.doesNotMatch(desktopHtml, /Show me the available providers/);
});


test('one character triggers the full outline and only empty input retracts it', () => {
  const source = desktopHtml.match(/function composerProgressStep\(previousLength, previousProgress, length\) \{([\s\S]*?)\n  \}/)[1];
  const step = new Function('previousLength', 'previousProgress', 'length', source);
  assert.equal(step(0, 0, 1), 1, 'first character targets the complete outline');
  assert.equal(step(1, 1, 24), 1, 'additional typing holds the target');
  assert.equal(step(24, 1, 1), 1, 'partial deletion does not retract');
  assert.equal(step(1, 1, 0), 0, 'last character removed retracts');
  assert.equal(step(0, 0, 1), 1, 'typing again triggers a fresh full sweep');
  assert.match(desktopHtml, /\.85 \* arrival/);
});

test('chat submission consumes only applied choices, not uncommitted picker inputs', () => {
  const source = desktopHtml.slice(desktopHtml.indexOf('  async function sendChatMessage'), desktopHtml.indexOf('  async function sendChatMessage') + 3500);
  assert.match(source, /const appliedChoice = chatAdminAppliedChoice/);
  assert.doesNotMatch(source, /getElementById\('chatProviderSelect'\)/);
  assert.match(source, /resetAdminChatOverrides\(\)/);
  assert.match(desktopHtml, /item.catalogConfirmed === true/);
});

test('reviewed header groups true agent status and keeps unavailable controls disabled', () => {
  assert.match(desktopHtml, /class="header-upcoming" tabindex="0" role="group"/);
  assert.match(desktopHtml, /class="header-coming-soon">Coming soon/);
  assert.match(desktopHtml, /voiceBtn\.disabled = true/);
  assert.match(desktopHtml, /desktopBtn\.disabled = true/);
  assert.match(desktopHtml, /voiceBtn\.onclick = null/);
  assert.match(desktopHtml, /desktopBtn\.onclick = null/);
  assert.match(desktopHtml, /headerStatus\.dataset\.state = \['active', 'paused', 'archived'\]\.includes\(agent\?\.status\)/);
  assert.match(desktopHtml, /providerName\.textContent = provider\.displayName/);
  assert.match(desktopHtml, /modelName\.textContent = model/);
  assert.match(desktopHtml, /chip\.title = `\$\{provider\.displayName\} · \$\{model\}`/);
  assert.match(desktopHtml, /id="adminModelChip"[^>]* hidden/);
});

test('UI read deadlines cover the response body and release timers', async () => {
  const start = desktopHtml.indexOf('  async function fetchUiRead(');
  const end = desktopHtml.indexOf('  async function loadChatHistory(', start);
  const source = desktopHtml.slice(start, end);
  let deadline, cleared = 0;
  const make = (fetchImpl) => new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', `${source}; return fetchUiRead;`)(
    fetchImpl, AbortController, (callback, ms) => { assert.equal(ms, 12000); deadline = callback; return 1; }, () => { cleared += 1; },
  );
  const success = make(async () => ({ ok: true, status: 200, text: async () => '{"ready":true}' }));
  assert.deepEqual(await (await success('/read')).json(), { ready: true });
  assert.equal(cleared, 1);
  const stalled = make(async (path, { signal }) => ({ ok: true, status: 200, text: () => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted body')), { once: true });
  }) }));
  const request = stalled('/read');
  await Promise.resolve();
  deadline();
  await assert.rejects(request, /aborted body/);
  assert.equal(cleared, 2);
});

test('startup defers settings-only reads and history abort retains stale-response guards', () => {
  const boot = desktopHtml.slice(desktopHtml.lastIndexOf("document.getElementById('uiWaitRetry')"));
  assert.doesNotMatch(boot, /void loadPayPalWalletStatus|void loadPasskeyStatus/);
  const panes = desktopHtml.slice(desktopHtml.indexOf('  function setSettingsPane'), desktopHtml.indexOf('  function openGeneralOverlay'));
  assert.match(panes, /loadPasskeyStatus/);
  assert.match(panes, /selected === 'account'.*refreshPendingEmailChange/);
  assert.match(desktopHtml, /historyReadController\?\.abort\(\)/);
  assert.match(desktopHtml, /signal: historyReadController.signal/);
  assert.match(desktopHtml, /loadVersion !== chatHistoryLoadVersion/);
  assert.match(desktopHtml, /prefers-reduced-motion:reduce/);
});

test('dictation appends to drafts without exceeding the composer limit', () => {
  const start = desktopHtml.indexOf('  function dictationDraft(');
  const end = desktopHtml.indexOf('  function syncDictationControl(', start);
  const draft = new Function(`${desktopHtml.slice(start, end)}; return dictationDraft;`)();
  assert.equal(draft('Find', 'headphones'), 'Find headphones');
  assert.equal(draft('Find ', 'headphones'), 'Find headphones');
  assert.equal(draft('Existing draft', ''), 'Existing draft');
  assert.equal(draft('', 'hello'), 'hello');
  assert.equal(draft('a'.repeat(1998), 'long transcript').length, 2000);
});

test('composer microphone uses device-specific audio controls and never invokes the fake call handler', () => {
  const binding = desktopHtml.slice(desktopHtml.indexOf('  function syncVoiceAndDesktopControls'), desktopHtml.indexOf('  const settingsTabs'));
  assert.match(binding, /micBtn.onclick = toggleDictation/);
  assert.doesNotMatch(binding, /micBtn.onclick = toggleCall/);
  assert.match(desktopHtml, /createAudioInput/);
  assert.match(desktopHtml, /id="settingsPaneAudio"/);
  assert.match(desktopHtml, /chatPending \|\| dictationSession\) return/);
  assert.doesNotMatch(desktopHtml, /new Recognition\(/);
  assert.match(desktopHtml, /id="audioConsentDialog"/);
  assert.match(desktopHtml, /Your recording will be sent to a third-party service/);
  assert.doesNotMatch(desktopHtml, /id="audioServiceCheck"|id="audioCloudConsent"/);
});


test('composer supports bounded multiline editing and native Shift Enter', () => {
  assert.match(desktopHtml, /<textarea id="chatInput" rows="1"/);
  assert.match(desktopHtml, /maxlength="2000"><\/textarea>/);
  assert.match(desktopHtml, /Math.min\(132, Math.max\(22, input.scrollHeight\)\)/);
  assert.match(desktopHtml, /input._sizedValue === value && input._sizedWidth === width/);
  assert.match(desktopHtml, /if \(event.shiftKey\) return/);
  assert.match(desktopHtml, /!event.isComposing && event.keyCode !== 229/);
});


test('phone navigation uses a modal drawer and restores the original sidebar on desktop', () => {
  assert.match(desktopHtml, /id="phoneMenuButton"[^>]*aria-controls="phoneNavigation"/);
  assert.match(desktopHtml, /<dialog id="phoneNavigation" aria-labelledby="phoneNavigationTitle">/);
  assert.match(desktopHtml, /if \(media.matches\) dialog.append\(sidebar\)/);
  assert.match(desktopHtml, /else workspace.insertBefore\(sidebar, workspace.firstChild\)/);
  assert.match(desktopHtml, /dialog.showModal\(\)/);
  assert.match(desktopHtml, /media.addEventListener\('change', sync\)/);
  assert.match(desktopHtml, /height:100dvh/);
});
