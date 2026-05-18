const NATIVE_HOST_NAME = 'com.chatgpt.local_voice_bridge';
const SETTINGS_VERSION = 5;
const LEGACY_DEFAULT_API_URL = 'http://127.0.0.1:8765/v1/speak';
const LEGACY_DEFAULT_HEALTH_URL = 'http://127.0.0.1:8765/health';
const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  enabled: false,
  apiUrl: 'http://127.0.0.1:8717/v1/speak',
  healthUrl: 'http://127.0.0.1:8717/health',
  voiceProfile: 'irodori-v2',
  voiceVolume: 0.6,
  previewMaxLines: 2,
  previewMaxChars: 80,
  previewMinChars: 25,
  previewStableMs: 800,
  panelCollapsed: true,
};

const tabRegistry = new Map();
let uiOwnerTabId = null;
let selectedTabId = null;

let audioQueue = [];
let isPlaying = false;
let currentPlayingItem = null;
let currentPlaybackToken = null;
let playbackWatchdogTimer = null;
let playbackEpoch = 0;
let lastPlayedItem = null;
let queueSeq = 1;
const autoQueuedChunk0Keys = new Set();
const audioCache = new Map();
let lastStatusText = 'Ready';
let lastStatusLevel = 'info';

const debugStats = {
  speakCalls: 0,
  speakCallsByReason: {},
  replayCalls: 0,
  speakEvents: [],
};

function preferCurrentUnlessLegacyOrEmpty(currentValue, legacyValue, defaultValue) {
  const value = String(currentValue || '').trim();
  if (!value || value === legacyValue) return defaultValue;
  return value;
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.voiceVolume;
  return Math.min(1, Math.max(0, n));
}

function cloneItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    mode: item.mode,
    reason: item.reason,
    tabId: item.tabId,
    tabTitle: item.tabTitle,
    messageKey: item.messageKey,
    chunkIndex: item.chunkIndex,
    text: item.text,
    voiceProfile: item.voiceProfile,
    audioUrl: item.audioUrl || null,
    fromCache: Boolean(item.fromCache),
    forceRegenerate: Boolean(item.forceRegenerate),
    playedAt: item.playedAt || null,
  };
}

function makeQueueItem(base) {
  return {
    id: `q-${Date.now()}-${queueSeq++}`,
    mode: String(base.mode || 'manual'),
    reason: String(base.reason || 'manual'),
    tabId: Number(base.tabId),
    tabTitle: String(base.tabTitle || 'ChatGPT'),
    messageKey: String(base.messageKey || ''),
    chunkIndex: Number(base.chunkIndex || 0),
    text: String(base.text || ''),
    voiceProfile: String(base.voiceProfile || DEFAULT_SETTINGS.voiceProfile),
    audioUrl: base.audioUrl ? String(base.audioUrl) : null,
    fromCache: Boolean(base.fromCache),
    forceRegenerate: Boolean(base.forceRegenerate),
  };
}

function makeCacheKey(item) {
  return [
    String(item.voiceProfile || DEFAULT_SETTINGS.voiceProfile),
    String(item.tabId || ''),
    String(item.messageKey || ''),
    String(Number(item.chunkIndex || 0)),
    normalizeText(item.text || ''),
  ].join('::');
}

function setStatus(text, level = 'info') {
  lastStatusText = String(text || '').trim() || 'Ready';
  lastStatusLevel = String(level || 'info');
}

function ensureOwnerAndSelection() {
  const ids = Array.from(tabRegistry.keys());
  if (!ids.length) {
    uiOwnerTabId = null;
    selectedTabId = null;
    return;
  }
  if (!uiOwnerTabId || !tabRegistry.has(uiOwnerTabId)) {
    uiOwnerTabId = ids[0];
  }
  if (!selectedTabId || !tabRegistry.has(selectedTabId)) {
    selectedTabId = uiOwnerTabId;
  }
}

function buildStatePayload() {
  const tabs = Array.from(tabRegistry.entries()).map(([id, info]) => ({
    id,
    title: info.title,
    url: info.url,
  }));
  return {
    uiOwnerTabId,
    selectedTabId,
    tabs,
    queueSize: audioQueue.length,
    isPlaying,
    currentPlayingItem: cloneItem(currentPlayingItem),
    lastPlayedItem: cloneItem(lastPlayedItem),
    replayAvailable: Boolean(lastPlayedItem && lastPlayedItem.audioUrl),
    statusText: lastStatusText,
    statusLevel: lastStatusLevel,
  };
}

function broadcastState() {
  ensureOwnerAndSelection();
  const base = buildStatePayload();
  for (const tabId of tabRegistry.keys()) {
    chrome.tabs.sendMessage(tabId, {
      type: 'state-update',
      payload: {
        ...base,
        isUiOwner: tabId === uiOwnerTabId,
      },
    }).catch(() => {});
  }
}

function pushSpeakEvent(event) {
  debugStats.speakEvents.push({
    at: new Date().toISOString(),
    ...event,
  });
  if (debugStats.speakEvents.length > 200) {
    debugStats.speakEvents.splice(0, debugStats.speakEvents.length - 200);
  }
}

function incSpeakStats(reason, voiceProfile) {
  const key = String(reason || 'unknown');
  debugStats.speakCalls += 1;
  debugStats.speakCallsByReason[key] = (debugStats.speakCallsByReason[key] || 0) + 1;
  pushSpeakEvent({
    type: 'speak',
    reason: key,
    voiceProfile: String(voiceProfile || ''),
  });
}

function resetPlayback({ advanceEpoch }) {
  if (playbackWatchdogTimer) {
    clearTimeout(playbackWatchdogTimer);
    playbackWatchdogTimer = null;
  }
  if (advanceEpoch) {
    playbackEpoch += 1;
  }
  isPlaying = false;
  currentPlayingItem = null;
  currentPlaybackToken = null;
}

function resolveSelectedTarget(senderTabId) {
  if (selectedTabId && tabRegistry.has(selectedTabId)) return selectedTabId;
  if (senderTabId && tabRegistry.has(senderTabId)) return senderTabId;
  const ids = Array.from(tabRegistry.keys());
  return ids.length ? ids[0] : null;
}

function enqueueItem(baseItem, options = {}) {
  const item = makeQueueItem(baseItem);
  if (options.front) {
    audioQueue.unshift(item);
  } else {
    audioQueue.push(item);
  }
  return item;
}

async function migrateSettings() {
  const current = await chrome.storage.local.get(null);
  const version = Number(current.settingsVersion || 0);
  if (version >= SETTINGS_VERSION) {
    await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...current });
    return;
  }
  const migrated = {
    ...DEFAULT_SETTINGS,
    ...current,
    settingsVersion: SETTINGS_VERSION,
    apiUrl: preferCurrentUnlessLegacyOrEmpty(current.apiUrl, LEGACY_DEFAULT_API_URL, DEFAULT_SETTINGS.apiUrl),
    healthUrl: preferCurrentUnlessLegacyOrEmpty(current.healthUrl, LEGACY_DEFAULT_HEALTH_URL, DEFAULT_SETTINGS.healthUrl),
    voiceProfile: String(current.voiceProfile || DEFAULT_SETTINGS.voiceProfile),
    voiceVolume: clampVolume(current.voiceVolume),
    previewMaxLines: DEFAULT_SETTINGS.previewMaxLines,
    previewMaxChars: DEFAULT_SETTINGS.previewMaxChars,
    previewMinChars: DEFAULT_SETTINGS.previewMinChars,
    previewStableMs: DEFAULT_SETTINGS.previewStableMs,
  };
  if (typeof current.panelCollapsed !== 'boolean') {
    migrated.panelCollapsed = DEFAULT_SETTINGS.panelCollapsed;
  }
  await chrome.storage.local.set(migrated);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body;
  try {
    body = await response.json();
  } catch (_error) {
    throw new Error(`Local API returned non-JSON response: ${response.status}`);
  }
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Local API failed: ${response.status}`);
  }
  return body;
}

async function speak(text, requestId, voiceProfile) {
  const settings = await getSettings();
  const pickedProfile = String(voiceProfile || settings.voiceProfile || DEFAULT_SETTINGS.voiceProfile);
  return postJson(settings.apiUrl, { text, requestId, source: 'chatgpt-web', voiceProfile: pickedProfile });
}

async function health() {
  const settings = await getSettings();
  const response = await fetch(settings.healthUrl, { method: 'GET', cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function callNativeHost(command) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      reject(new Error(error && error.message ? error.message : 'Native host is not available'));
      return;
    }

    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch (_error) {}
      handler(value);
    };

    port.onMessage.addListener((message) => {
      if (!message || !message.ok) {
        finish(reject, new Error((message && message.error) || 'Native host command failed'));
        return;
      }
      finish(resolve, message);
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const detail = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Native host disconnected';
      finish(reject, new Error(detail));
    });

    try {
      port.postMessage({ command });
    } catch (error) {
      finish(reject, new Error(error && error.message ? error.message : 'Failed to send native host message'));
    }
  });
}

async function dispatchPlayAudio(item, playbackToken, epoch) {
  const targetTabId = uiOwnerTabId;
  if (!targetTabId || !tabRegistry.has(targetTabId)) {
    throw new Error('No UI owner tab available');
  }
  if (!currentPlayingItem || currentPlayingItem.id !== item.id || playbackEpoch !== epoch) {
    return false;
  }
  await chrome.tabs.sendMessage(targetTabId, {
    type: 'play-audio',
    payload: {
      url: item.audioUrl,
      text: item.text,
      playbackToken,
      item: cloneItem(item),
    },
  });
  return true;
}

async function prepareAudio(item, epoch) {
  if (item.audioUrl) return item.audioUrl;

  const cacheKey = makeCacheKey(item);
  if (!item.forceRegenerate && audioCache.has(cacheKey)) {
    const cached = audioCache.get(cacheKey);
    item.audioUrl = cached.audioUrl;
    item.fromCache = true;
    pushSpeakEvent({
      type: 'cache-hit',
      reason: item.reason,
      voiceProfile: item.voiceProfile,
    });
    return item.audioUrl;
  }

  if (!currentPlayingItem || currentPlayingItem.id !== item.id || playbackEpoch !== epoch) {
    return null;
  }

  const requestId = `bg-${item.id}-${Date.now()}`.slice(0, 120);
  incSpeakStats(item.reason, item.voiceProfile);
  const payload = await speak(item.text, requestId, item.voiceProfile);
  if (!payload || !payload.audioUrl) {
    throw new Error('No audioUrl in speak response');
  }
  if (!currentPlayingItem || currentPlayingItem.id !== item.id || playbackEpoch !== epoch) {
    return null;
  }

  item.audioUrl = payload.audioUrl;
  item.fromCache = false;
  pushSpeakEvent({
    type: 'generated',
    reason: item.reason,
    voiceProfile: item.voiceProfile,
    audioUrl: payload.audioUrl,
  });
  audioCache.set(cacheKey, {
    audioUrl: payload.audioUrl,
    createdAt: Date.now(),
  });
  return item.audioUrl;
}

async function playNext() {
  ensureOwnerAndSelection();
  if (isPlaying) return;
  if (!uiOwnerTabId || !tabRegistry.has(uiOwnerTabId)) {
    broadcastState();
    return;
  }

  const item = audioQueue.shift();
  if (!item) {
    broadcastState();
    return;
  }

  isPlaying = true;
  currentPlayingItem = item;
  const epoch = playbackEpoch;
  const playbackToken = `pb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  currentPlaybackToken = playbackToken;
  if (playbackWatchdogTimer) {
    clearTimeout(playbackWatchdogTimer);
    playbackWatchdogTimer = null;
  }
  playbackWatchdogTimer = setTimeout(() => {
    if (!isPlaying || !currentPlayingItem || currentPlaybackToken !== playbackToken) return;
    resetPlayback({ advanceEpoch: true });
    setStatus('Playback timed out, moving to next item', 'warn');
    broadcastState();
    void playNext();
  }, 10000);
  setStatus(`Playing chunk ${item.chunkIndex + 1} (${item.mode})`, 'info');
  broadcastState();

  try {
    const audioUrl = await prepareAudio(item, epoch);
    if (!audioUrl) return;
    const sent = await dispatchPlayAudio(item, playbackToken, epoch);
    if (!sent) return;
    setStatus(`Queued ${audioQueue.length}`, 'info');
    broadcastState();
  } catch (error) {
    if (currentPlayingItem && currentPlayingItem.id === item.id && playbackEpoch === epoch) {
      resetPlayback({ advanceEpoch: false });
      setStatus(`Playback failed: ${error.message || String(error)}`, 'error');
      broadcastState();
      void playNext();
    }
  }
}

function registerOrRefreshTab(tabId, senderTab, title) {
  const existing = tabRegistry.get(tabId);
  if (existing) {
    existing.title = title || existing.title || 'ChatGPT';
    existing.url = senderTab && senderTab.url ? senderTab.url : existing.url;
    return existing;
  }

  const created = {
    title: title || 'ChatGPT',
    url: senderTab && senderTab.url ? senderTab.url : '',
    lastAssistantMessage: null,
    lastReadIndex: -1,
  };
  tabRegistry.set(tabId, created);
  return created;
}

function queueManualCommand(cmd, senderTabId, params) {
  const targetTabId = resolveSelectedTarget(senderTabId);
  if (!targetTabId || !tabRegistry.has(targetTabId)) {
    setStatus('No selected ChatGPT tab', 'warn');
    return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
  }

  const info = tabRegistry.get(targetTabId);
  const message = info.lastAssistantMessage;
  if (!message || !Array.isArray(message.chunks) || message.chunks.length === 0) {
    setStatus('Selected tab has no assistant response yet', 'warn');
    return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
  }

  let chunkIndex = 0;
  if (cmd === 'read') {
    chunkIndex = 0;
    info.lastReadIndex = 0;
  } else if (cmd === 'next') {
    const currentIndex = Number.isInteger(info.lastReadIndex) ? Number(info.lastReadIndex) : -1;
    const next = currentIndex + 1;
    if (next >= message.chunks.length) {
      info.lastReadIndex = message.chunks.length - 1;
      setStatus('No more chunks in this response', 'warn');
      return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
    }
    chunkIndex = Math.max(0, next);
    info.lastReadIndex = chunkIndex;
  } else if (cmd === 'regen') {
    chunkIndex = info.lastReadIndex >= 0 ? info.lastReadIndex : 0;
    if (chunkIndex >= message.chunks.length) {
      chunkIndex = message.chunks.length - 1;
    }
    info.lastReadIndex = chunkIndex;
  }

  const chunkText = String(message.chunks[chunkIndex] || '').trim();
  if (!chunkText) {
    setStatus('Chunk text is empty', 'warn');
    return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
  }

  const voiceProfile = String((params && params.voiceProfile) || DEFAULT_SETTINGS.voiceProfile);
  enqueueItem({
    mode: cmd,
    reason: cmd,
    tabId: targetTabId,
    tabTitle: info.title,
    messageKey: message.messageKey,
    chunkIndex,
    text: chunkText,
    voiceProfile,
    forceRegenerate: cmd === 'regen',
  });

  if (cmd === 'regen') {
    const cacheKey = makeCacheKey({
      tabId: targetTabId,
      messageKey: message.messageKey,
      chunkIndex,
      text: chunkText,
      voiceProfile,
    });
    audioCache.delete(cacheKey);
  }

  setStatus(`${cmd.toUpperCase()} chunk ${chunkIndex + 1}`, 'info');
  void playNext();
  return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
}

function replayLast() {
  if (!lastPlayedItem || !lastPlayedItem.audioUrl) {
    setStatus('Replay unavailable (nothing played yet)', 'warn');
    return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
  }

  debugStats.replayCalls += 1;
  enqueueItem({
    mode: 'replay',
    reason: 'replay',
    tabId: lastPlayedItem.tabId,
    tabTitle: lastPlayedItem.tabTitle,
    messageKey: lastPlayedItem.messageKey,
    chunkIndex: lastPlayedItem.chunkIndex,
    text: lastPlayedItem.text,
    voiceProfile: lastPlayedItem.voiceProfile,
    audioUrl: lastPlayedItem.audioUrl,
    fromCache: true,
  }, { front: true });

  setStatus(`Replay chunk ${Number(lastPlayedItem.chunkIndex) + 1}`, 'info');
  void playNext();
  return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
}

function finalizePlaybackFromMessage(message) {
  const token = String((message && message.playbackToken) || '');
  if (!isPlaying || !currentPlayingItem || !currentPlaybackToken || token !== currentPlaybackToken) {
    return { ok: true, payload: { ignored: true } };
  }

  const completed = currentPlayingItem;
  resetPlayback({ advanceEpoch: false });

  if (message.ok && !message.stopped) {
    lastPlayedItem = {
      ...cloneItem(completed),
      audioUrl: completed.audioUrl,
      playedAt: new Date().toISOString(),
    };
    setStatus(`Played ${completed.tabTitle} chunk ${completed.chunkIndex + 1}`, 'info');
  } else if (message.stopped) {
    setStatus('Playback stopped', 'info');
  } else {
    setStatus(`Playback error: ${String(message.error || 'unknown')}`, 'error');
  }

  broadcastState();
  void playNext();
  return { ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } };
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateSettings();
});

chrome.runtime.onStartup.addListener(async () => {
  await migrateSettings();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!tabRegistry.has(tabId)) return;

  tabRegistry.delete(tabId);
  for (const key of Array.from(autoQueuedChunk0Keys)) {
    if (key.startsWith(`${tabId}::`)) autoQueuedChunk0Keys.delete(key);
  }
  audioQueue = audioQueue.filter((item) => item.tabId !== tabId);

  if (currentPlayingItem && currentPlayingItem.tabId === tabId) {
    resetPlayback({ advanceEpoch: true });
  }

  if (uiOwnerTabId === tabId || selectedTabId === tabId) {
    uiOwnerTabId = null;
    selectedTabId = null;
  }

  ensureOwnerAndSelection();
  setStatus('Tab closed, state updated', 'info');
  broadcastState();
  void playNext();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  const senderTabId = sender.tab ? sender.tab.id : null;

  if (message.type === 'register-tab') {
    if (senderTabId) {
      registerOrRefreshTab(senderTabId, sender.tab, message.title);
    }
    ensureOwnerAndSelection();
    const payload = buildStatePayload();
    sendResponse({
      ok: true,
      payload: senderTabId ? { ...payload, isUiOwner: senderTabId === uiOwnerTabId } : payload,
    });
    broadcastState();
    return false;
  }

  if (message.type === 'report-chunks') {
    if (senderTabId && tabRegistry.has(senderTabId)) {
      const info = tabRegistry.get(senderTabId);
      if (message.title && message.title !== info.title) {
        info.title = String(message.title);
      }

      const messageKey = String(message.messageKey || '').trim();
      const chunks = Array.isArray(message.chunks) ? message.chunks.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const text = String(message.text || '');
      if (!messageKey || !chunks.length) {
        sendResponse({ ok: true, payload: { ignored: true } });
        return false;
      }

      const isNewMessage = !info.lastAssistantMessage || info.lastAssistantMessage.messageKey !== messageKey;
      if (isNewMessage) {
        info.lastReadIndex = -1;
      }

      info.lastAssistantMessage = {
        messageKey,
        text,
        chunks,
        capturedAt: Date.now(),
      };

      if (message.isAuto) {
        const chunk0 = String(chunks[0] || '').trim();
        const autoKey = `${senderTabId}::${messageKey}::0`;
        if (chunk0 && !autoQueuedChunk0Keys.has(autoKey)) {
          autoQueuedChunk0Keys.add(autoKey);
          info.lastReadIndex = 0;
          enqueueItem({
            mode: 'auto',
            reason: 'auto',
            tabId: senderTabId,
            tabTitle: info.title,
            messageKey,
            chunkIndex: 0,
            text: chunk0,
            voiceProfile: String(message.voiceProfile || DEFAULT_SETTINGS.voiceProfile),
          });
          setStatus(`Auto queued ${info.title} chunk 1`, 'info');
          void playNext();
        }
      }
      broadcastState();
    }
    sendResponse({ ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } });
    return false;
  }

  if (message.type === 'playback-done') {
    sendResponse(finalizePlaybackFromMessage(message));
    return false;
  }

  if (message.type === 'ui-command') {
    const cmd = String(message.cmd || '');
    const params = message.params && typeof message.params === 'object' ? message.params : {};

    if (cmd === 'select-tab') {
      const tabId = Number(params.tabId);
      if (tabRegistry.has(tabId)) {
        selectedTabId = tabId;
        setStatus(`Selected tab: ${tabRegistry.get(tabId).title}`, 'info');
      } else {
        setStatus('Selected tab is no longer available', 'warn');
      }
      broadcastState();
      sendResponse({ ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } });
      return false;
    }

    if (cmd === 'stop') {
      audioQueue = [];
      if (uiOwnerTabId) {
        chrome.tabs.sendMessage(uiOwnerTabId, {
          type: 'stop-audio',
          payload: { playbackToken: currentPlaybackToken, reason: 'stop' },
        }).catch(() => {});
      }
      resetPlayback({ advanceEpoch: true });
      setStatus('Stopped and cleared queue', 'info');
      broadcastState();
      sendResponse({ ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } });
      return false;
    }

    if (cmd === 'skip') {
      if (uiOwnerTabId) {
        chrome.tabs.sendMessage(uiOwnerTabId, {
          type: 'stop-audio',
          payload: { playbackToken: currentPlaybackToken, reason: 'skip' },
        }).catch(() => {});
      }
      resetPlayback({ advanceEpoch: true });
      setStatus('Skipped current item', 'info');
      broadcastState();
      void playNext();
      sendResponse({ ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } });
      return false;
    }

    if (cmd === 'replay') {
      const response = replayLast();
      broadcastState();
      sendResponse(response);
      return false;
    }

    if (cmd === 'read' || cmd === 'next' || cmd === 'regen') {
      getSettings()
        .then((settings) => {
          const mergedParams = {
            ...params,
            voiceProfile: String(params.voiceProfile || settings.voiceProfile || DEFAULT_SETTINGS.voiceProfile),
          };
          const response = queueManualCommand(cmd, senderTabId, mergedParams);
          broadcastState();
          sendResponse(response);
        })
        .catch((error) => {
          setStatus(`Command failed: ${error.message || String(error)}`, 'error');
          broadcastState();
          sendResponse({ ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } });
        });
      return true;
    }

    sendResponse({ ok: true, payload: { statusText: lastStatusText, statusLevel: lastStatusLevel } });
    return false;
  }

  if (message.type === 'speak') {
    speak(String(message.text || ''), String(message.requestId || ''), String(message.voiceProfile || ''))
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'health') {
    health()
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'native-status') {
    callNativeHost('status')
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'native-start') {
    callNativeHost('start')
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'native-stop') {
    callNativeHost('stop')
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'debug-get-state') {
    sendResponse({
      ok: true,
      payload: {
        state: buildStatePayload(),
        currentPlaybackToken,
        queue: audioQueue.map((item) => cloneItem(item)),
        tabs: Array.from(tabRegistry.entries()).map(([id, info]) => ({
          id,
          title: info.title,
          url: info.url,
          lastReadIndex: info.lastReadIndex,
          messageKey: info.lastAssistantMessage ? info.lastAssistantMessage.messageKey : null,
          chunkCount: info.lastAssistantMessage && Array.isArray(info.lastAssistantMessage.chunks) ? info.lastAssistantMessage.chunks.length : 0,
        })),
        debugStats: {
          speakCalls: debugStats.speakCalls,
          speakCallsByReason: { ...debugStats.speakCallsByReason },
          replayCalls: debugStats.replayCalls,
          speakEvents: debugStats.speakEvents.map((event) => ({ ...event })),
        },
      },
    });
    return false;
  }

  if (message.type === 'debug-force-playback-done') {
    if (!isPlaying || !currentPlaybackToken) {
      sendResponse({ ok: true, payload: { ignored: true } });
      return false;
    }
    sendResponse(finalizePlaybackFromMessage({
      playbackToken: currentPlaybackToken,
      ok: true,
      stopped: false,
    }));
    return false;
  }

  if (message.type === 'debug-get-owner-content-state') {
    if (!uiOwnerTabId || !tabRegistry.has(uiOwnerTabId)) {
      sendResponse({ ok: false, error: 'ui owner tab is unavailable' });
      return false;
    }
    chrome.tabs.sendMessage(uiOwnerTabId, { type: 'debug-content-state' }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (!response || !response.ok) {
        sendResponse({ ok: false, error: (response && response.error) || 'content debug response failed' });
        return;
      }
      sendResponse({ ok: true, payload: response.payload });
    });
    return true;
  }

  if (message.type === 'debug-force-owner-web-audio-next') {
    if (!uiOwnerTabId || !tabRegistry.has(uiOwnerTabId)) {
      sendResponse({ ok: false, error: 'ui owner tab is unavailable' });
      return false;
    }
    chrome.tabs.sendMessage(uiOwnerTabId, { type: 'debug-force-web-audio-next' }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (!response || !response.ok) {
        sendResponse({ ok: false, error: (response && response.error) || 'failed to set owner fallback flag' });
        return;
      }
      sendResponse({ ok: true, payload: response.payload });
    });
    return true;
  }

  if (message.type === 'debug-set-owner-playback-simulated') {
    if (!uiOwnerTabId || !tabRegistry.has(uiOwnerTabId)) {
      sendResponse({ ok: false, error: 'ui owner tab is unavailable' });
      return false;
    }
    chrome.tabs.sendMessage(uiOwnerTabId, {
      type: 'debug-set-playback-simulated',
      enabled: Boolean(message.enabled),
    }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (!response || !response.ok) {
        sendResponse({ ok: false, error: (response && response.error) || 'failed to set playback simulation mode' });
        return;
      }
      sendResponse({ ok: true, payload: response.payload });
    });
    return true;
  }

  return false;
});
