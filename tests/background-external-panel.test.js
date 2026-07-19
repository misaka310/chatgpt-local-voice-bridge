'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const BACKGROUND_PATH = path.join(ROOT, 'extension', 'background.js');

function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('timed out'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function createHarness({ initialized = true } = {}) {
  const storage = {
    enabled: false,
    apiUrl: 'http://127.0.0.1:8717/v1/speak',
    healthUrl: 'http://127.0.0.1:8717/health',
    voiceProfile: 'irodori-v3',
    voiceId: 'sample',
    referenceVoice: 'sample',
    voiceVolume: 0.6,
    micConversationEnabled: false,
    sttModel: 'small',
    cancelGraceMs: 700,
  };
  const speakPosts = [];
  const petPosts = [];
  const statePosts = [];
  const conversationStatePosts = [];
  const settingsPosts = [];
  const sentMessages = [];
  let runtimeListener = null;
  let control = {
    ok: true,
    initialized,
    settingsRevision: 3,
    settings: {
      enabled: true,
      voiceVolume: 0.25,
      referenceVoice: 'asuka',
      micConversationEnabled: true,
      sttModel: 'medium',
      cancelGraceMs: 900,
    },
    commands: [{ id: 1, command: 'next' }],
    conversationEvents: [],
  };

  const chrome = {
    storage: {
      local: {
        async get(query) {
          if (query === null || query === undefined) return { ...storage };
          if (Array.isArray(query)) return Object.fromEntries(query.map((key) => [key, storage[key]]));
          if (typeof query === 'object') return { ...query, ...storage };
          return { [query]: storage[query] };
        },
        async set(values) { Object.assign(storage, values); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        },
      },
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { runtimeListener = listener; } },
    },
    tabs: {
      onRemoved: { addListener() {} },
      onActivated: { addListener() {} },
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
        return { ok: true };
      },
    },
  };

  async function fetch(url, options = {}) {
    const target = new URL(String(url));
    if (target.pathname === '/v1/control-panel/poll') {
      const after = Number(target.searchParams.get('after') || 0);
      return response({
        ...control,
        commands: control.commands.filter((item) => item.id > after),
      });
    }
    if (target.pathname === '/v1/control-panel/settings' && options.method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      settingsPosts.push(body);
      control = {
        ...control,
        initialized: true,
        settingsRevision: control.settingsRevision + 1,
        settings: {
          enabled: Boolean(body.enabled),
          voiceVolume: Number(body.voiceVolume),
          referenceVoice: String(body.referenceVoice || ''),
          micConversationEnabled: Boolean(body.micConversationEnabled),
          sttModel: String(body.sttModel || 'small'),
          cancelGraceMs: Number(body.cancelGraceMs ?? 700),
        },
      };
      return response(control);
    }
    if (target.pathname === '/v1/control-panel/state' && options.method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      statePosts.push(body);
      return response({ ok: true, extension: body });
    }
    if (target.pathname === '/v1/conversation/state' && options.method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      conversationStatePosts.push(body);
      return response({ ok: true, conversation: body });
    }
    if (target.pathname === '/v1/desktop-pet' && options.method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      petPosts.push(body);
      return response({ ok: true, selectedPetId: body.petId });
    }
    if (target.pathname === '/v1/speak' && options.method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      speakPosts.push(body);
      return response({
        ok: true,
        audioUrl: 'http://127.0.0.1:8717/audio/test.wav',
        voiceProfile: 'irodori-v3',
        referenceVoice: body.referenceVoice,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }

  const context = vm.createContext({
    chrome,
    console,
    crypto: { randomUUID: () => 'playback-id' },
    fetch,
    setTimeout,
    clearTimeout,
    URL,
    Uint8Array,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  });
  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, 'utf8'), context, { filename: BACKGROUND_PATH });
  assert.equal(typeof runtimeListener, 'function');

  function send(message, tabId = 101, title = 'Tab A') {
    let value;
    runtimeListener(message, {
      tab: { id: tabId, title, url: `https://chatgpt.com/c/${tabId}`, active: true },
    }, (responseValue) => { value = responseValue; });
    return value;
  }

  function sendAsync(message, tabId = 101, title = 'Tab A') {
    return new Promise((resolve) => {
      runtimeListener(message, {
        tab: { id: tabId, title, url: `https://chatgpt.com/c/${tabId}`, active: true },
      }, resolve);
    });
  }

  return {
    control: () => control,
    setControl(next) { control = { ...control, ...next }; },
    conversationStatePosts,
    petPosts,
    sentMessages,
    settingsPosts,
    speakPosts,
    statePosts,
    storage,
    send,
    sendAsync,
  };
}

test('external panel poll applies settings, executes each command once, and posts global state', async () => {
  const harness = createHarness();
  harness.send({ type: 'register-tab', title: 'Tab A' }, 101, 'Tab A');
  harness.send({
    type: 'report-chunks',
    messageKey: 'manual-reply',
    chunks: ['最初のチャンクです。', '次のチャンクです。'],
    autoPreview: '最初のチャンクです。',
    isAuto: false,
  }, 101, 'Tab A');

  const first = await harness.sendAsync({ type: 'external-control-poll' }, 101, 'Tab A');
  await waitFor(() => harness.speakPosts.length === 1 && harness.statePosts.length >= 1);

  assert.equal(first.ok, true);
  assert.equal(harness.storage.enabled, true);
  assert.equal(harness.storage.voiceVolume, 0.25);
  assert.equal(harness.storage.voiceId, 'asuka');
  assert.equal(harness.storage.referenceVoice, 'asuka');
  assert.equal(harness.storage.micConversationEnabled, true);
  assert.equal(harness.storage.sttModel, 'medium');
  assert.equal(harness.storage.cancelGraceMs, 900);
  assert.deepEqual(harness.petPosts.at(-1), { petId: 'asuka' });
  assert.equal(harness.speakPosts[0].text, '最初のチャンクです。');
  assert.equal(harness.speakPosts[0].referenceVoice, 'asuka');
  assert.equal(harness.statePosts.at(-1).tabsCount, 1);
  assert.equal(harness.statePosts.at(-1).currentText, '最初のチャンクです。');

  await harness.sendAsync({ type: 'external-control-poll' }, 101, 'Tab A');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.speakPosts.length, 1);
});

test('streaming updates preserve the already-read Auto text as the Next boundary', async () => {
  const harness = createHarness();
  harness.send({ type: 'register-tab', title: 'Tab A' }, 101, 'Tab A');
  harness.send({
    type: 'report-chunks',
    messageKey: 'streaming-reply',
    chunks: ['概ね妥当です。'],
    autoPreview: '概ね妥当です。',
    isAuto: true,
  }, 101, 'Tab A');
  await waitFor(() => harness.speakPosts.length === 1);
  harness.send({ type: 'playback-done', playbackToken: 'playback-id', ok: true, stopped: false }, 101, 'Tab A');

  harness.send({
    type: 'report-chunks',
    messageKey: 'streaming-reply',
    chunks: [
      '概ね妥当です。 ただし、公開時の誤認防止とブランド統一のために変更すべき項目があります。',
      'Chrome拡張名、EXE名、スタートメニュー名、READMEタイトルを独自名称へ統一します。',
    ],
    autoPreview: '概ね妥当です。 ただし、公開時の誤認防止とブランド統一のために変更すべき項目があります。',
    isAuto: false,
  }, 101, 'Tab A');
  harness.send({ type: 'ui-command', cmd: 'next' }, 101, 'Tab A');
  await waitFor(() => harness.speakPosts.length === 2);

  assert.equal(
    harness.speakPosts[1].text,
    'ただし、公開時の誤認防止とブランド統一のために変更すべき項目があります。',
  );
});

test('first extension poll seeds an uninitialized external panel from existing Chrome settings', async () => {
  const harness = createHarness({ initialized: false });
  harness.send({ type: 'register-tab', title: 'Tab A' }, 101, 'Tab A');

  const result = await harness.sendAsync({ type: 'external-control-poll' }, 101, 'Tab A');

  assert.equal(result.ok, true);
  assert.equal(harness.settingsPosts.length, 1);
  assert.deepEqual(harness.settingsPosts[0], {
    enabled: false,
    voiceVolume: 0.6,
    referenceVoice: 'sample',
    micConversationEnabled: false,
    sttModel: 'small',
    cancelGraceMs: 700,
    initialized: true,
  });
});

test('conversation events are delivered to the selected ChatGPT tab once', async () => {
  const harness = createHarness();
  harness.send({ type: 'register-tab', title: 'Tab A' }, 101, 'Tab A');
  harness.setControl({
    commands: [],
    conversationEvents: [
      { id: 1, type: 'cancel_pending', payload: { sessionId: 4 } },
      { id: 2, type: 'transcript', payload: { sessionId: 4, text: '音声入力です', cancelGraceMs: 700 } },
    ],
  });

  await harness.sendAsync({ type: 'external-control-poll' }, 101, 'Tab A');
  await harness.sendAsync({ type: 'external-control-poll' }, 101, 'Tab A');

  const conversationMessages = harness.sentMessages.filter(({ message }) => (
    message.type === 'cancel-voice-send' || message.type === 'voice-transcript'
  ));
  assert.deepEqual(conversationMessages.map(({ tabId, message }) => ({ tabId, type: message.type })), [
    { tabId: 101, type: 'cancel-voice-send' },
    { tabId: 101, type: 'voice-transcript' },
  ]);
  assert.equal(conversationMessages[1].message.payload.text, '音声入力です');
});

test('conversation transcript stays on the tab whose composer was focused when recording started', async () => {
  const harness = createHarness();
  harness.send({ type: 'register-tab', title: 'Tab A' }, 101, 'Tab A');
  harness.send({ type: 'register-tab', title: 'Tab B', claimOwner: true }, 202, 'Tab B');
  harness.send({ type: 'composer-focused' }, 101, 'Tab A');
  harness.setControl({
    commands: [],
    conversation: { phase: 'transcribing' },
    conversationEvents: [
      { id: 1, type: 'cancel_pending', payload: { sessionId: 9 } },
      { id: 2, type: 'transcript', payload: { sessionId: 9, text: 'フォーカスしたタブへ送る', cancelGraceMs: 700 } },
    ],
  });

  await harness.sendAsync({ type: 'external-control-poll' }, 202, 'Tab B');

  const transcripts = harness.sentMessages.filter(({ message }) => message.type === 'voice-transcript');
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].tabId, 101);
  assert.equal(transcripts[0].message.payload.text, 'フォーカスしたタブへ送る');
  const cancels = harness.sentMessages.filter(({ message }) => message.type === 'cancel-voice-send');
  assert.deepEqual(new Set(cancels.map(({ tabId }) => tabId)), new Set([101, 202]));
});

test('assistant replies are not auto-queued while microphone transcription is active', async () => {
  const harness = createHarness();
  harness.send({ type: 'register-tab', title: 'Tab A' }, 101, 'Tab A');
  harness.setControl({
    commands: [],
    conversation: { phase: 'transcribing' },
    conversationEvents: [],
  });
  await harness.sendAsync({ type: 'external-control-poll' }, 101, 'Tab A');

  harness.send({
    type: 'report-chunks',
    messageKey: 'reply-during-stt',
    chunks: ['文字起こし中に来た別の返答です。'],
    autoPreview: '文字起こし中に来た別の返答です。',
    isAuto: true,
  }, 101, 'Tab A');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.speakPosts.length, 0);
});

test('content conversation state is posted to the loopback service without transcript text', async () => {
  const harness = createHarness();
  harness.send({ type: 'register-tab', title: 'Tab A' }, 101, 'Tab A');

  const result = await harness.sendAsync({
    type: 'conversation-state',
    payload: {
      phase: 'waiting_response',
      statusText: 'ChatGPT応答待ち',
      sttModel: 'small',
      error: '',
      text: '送信本文は転送しない',
    },
  }, 101, 'Tab A');

  assert.equal(result.ok, true);
  assert.equal(harness.conversationStatePosts.length, 1);
  assert.deepEqual(harness.conversationStatePosts[0], {
    phase: 'waiting_response',
    statusText: 'ChatGPT応答待ち',
    sttDevice: '',
    sttModel: 'small',
    error: '',
  });
});
