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

function preferCurrentUnlessLegacyOrEmpty(currentValue, legacyValue, defaultValue) {
  const value = String(currentValue || '').trim();
  if (!value || value === legacyValue) return defaultValue;
  return value;
}

// State for multi-tab UI aggregation
const tabRegistry = new Map();
let uiOwnerTabId = null;
let selectedTabId = null;

// Shared Queue State
let audioQueue = [];
let isPlaying = false;
let currentPlayingItem = null;
let lastPlayedItem = null;

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
    voiceVolume: Number.isFinite(Number(current.voiceVolume))
      ? Math.min(1, Math.max(0, Number(current.voiceVolume)))
      : DEFAULT_SETTINGS.voiceVolume,
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

// Global UI Logic
function electUiOwner() {
  const ids = Array.from(tabRegistry.keys());
  if (ids.length === 0) {
    uiOwnerTabId = null;
    selectedTabId = null;
    return null;
  }
  
  if (!uiOwnerTabId || !tabRegistry.has(uiOwnerTabId)) {
    uiOwnerTabId = ids[0];
  }
  
  if (!selectedTabId || !tabRegistry.has(selectedTabId)) {
    selectedTabId = uiOwnerTabId;
  }

  const state = {
    isUiOwner: false, // will be set per tab
    uiOwnerTabId,
    selectedTabId,
    tabs: Array.from(tabRegistry.entries()).map(([id, info]) => ({
      id,
      title: info.title,
      url: info.url,
    })),
    queueSize: audioQueue.length,
    isPlaying,
    currentPlayingItem,
    lastPlayedItem,
  };

  console.debug('[local-voice] electUiOwner state:', state);
  broadcastState(state);
  return state;
}

function broadcastState(providedState = null) {
  const tabs = Array.from(tabRegistry.entries()).map(([id, info]) => ({
    id,
    title: info.title,
    url: info.url,
  }));

  const baseState = providedState || {
    uiOwnerTabId,
    selectedTabId,
    tabs,
    queueSize: audioQueue.length,
    isPlaying,
    currentPlayingItem,
    lastPlayedItem,
  };

  for (const tabId of tabRegistry.keys()) {
    console.debug('[local-voice] broadcasting state to tab:', tabId, 'isOwner:', tabId === uiOwnerTabId);
    chrome.tabs.sendMessage(tabId, {
      type: 'state-update',
      payload: {
        ...baseState,
        isUiOwner: tabId === uiOwnerTabId,
      }
    }).catch(() => {});
  }
}

async function playNext() {
  if (isPlaying || audioQueue.length === 0 || !uiOwnerTabId) {
    broadcastState();
    return;
  }

  const item = audioQueue.shift();
  isPlaying = true;
  currentPlayingItem = item;
  broadcastState();

  try {
    const settings = await getSettings();
    const requestId = `bg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = await speak(item.text, requestId, item.voiceProfile || settings.voiceProfile);
    
    if (payload && payload.audioUrl) {
      chrome.tabs.sendMessage(uiOwnerTabId, {
        type: 'play-audio',
        payload: {
          url: payload.audioUrl,
          text: item.text,
          item: item
        }
      }).catch(err => {
        console.error('Failed to send play-audio to UI owner', err);
        isPlaying = false;
        currentPlayingItem = null;
        playNext();
      });
    } else {
      throw new Error('No audioUrl in speak response');
    }
  } catch (error) {
    console.error('Playback error in background:', error);
    isPlaying = false;
    currentPlayingItem = null;
    playNext();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateSettings();
});

chrome.runtime.onStartup.addListener(async () => {
  await migrateSettings();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabRegistry.has(tabId)) {
    tabRegistry.delete(tabId);
    if (uiOwnerTabId === tabId) {
      uiOwnerTabId = null;
      electUiOwner();
    } else if (selectedTabId === tabId) {
      selectedTabId = null;
      electUiOwner();
    } else {
      broadcastState();
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  const tabId = sender.tab ? sender.tab.id : null;

  if (message.type === 'register-tab') {
    console.debug('[local-voice] register-tab from:', tabId, message.title);
    let state = null;
    if (tabId) {
      tabRegistry.set(tabId, {
        title: message.title || 'ChatGPT',
        url: sender.tab.url,
        lastAssistantMessage: null,
        lastReadIndex: -1
      });
      state = electUiOwner();
    }
    const resp = { 
      ok: true, 
      payload: state ? { ...state, isUiOwner: tabId === uiOwnerTabId } : null 
    };
    console.debug('[local-voice] register-tab response sending:', resp);
    sendResponse(resp);
    return false;
  }

  if (message.type === 'report-chunks') {
    if (tabId && tabRegistry.has(tabId)) {
      const info = tabRegistry.get(tabId);
      if (message.title && message.title !== info.title) {
        info.title = message.title;
      }
      
      const isNewMessage = !info.lastAssistantMessage || info.lastAssistantMessage.messageKey !== message.messageKey;
      if (isNewMessage) {
        info.lastReadIndex = -1;
      }
      
      info.lastAssistantMessage = {
        messageKey: message.messageKey,
        text: message.text,
        chunks: message.chunks,
        capturedAt: Date.now()
      };

      if (message.isAuto) {
        if (isNewMessage && info.lastReadIndex === -1) {
          info.lastReadIndex = 0;
          audioQueue.push({
            tabId,
            tabTitle: info.title,
            messageKey: message.messageKey,
            chunkIndex: 0,
            text: message.chunks[0],
            voiceProfile: message.voiceProfile,
            isAuto: true
          });
          playNext();
        }
      }
      broadcastState();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'playback-done') {
    isPlaying = false;
    lastPlayedItem = currentPlayingItem;
    currentPlayingItem = null;
    broadcastState();
    playNext();
    return false;
  }

  if (message.type === 'ui-command') {
    const { cmd, params } = message;
    
    if (cmd === 'select-tab') {
      selectedTabId = params.tabId;
      broadcastState();
    } else if (cmd === 'stop') {
      audioQueue = [];
      isPlaying = false;
      currentPlayingItem = null;
      if (uiOwnerTabId) {
        chrome.tabs.sendMessage(uiOwnerTabId, { type: 'stop-audio' }).catch(() => {});
      }
      broadcastState();
    } else if (cmd === 'skip') {
      if (uiOwnerTabId) {
        chrome.tabs.sendMessage(uiOwnerTabId, { type: 'stop-audio' }).catch(() => {});
      }
      isPlaying = false;
      playNext();
    } else if (cmd === 'replay') {
      if (lastPlayedItem) {
        audioQueue.unshift(lastPlayedItem);
        playNext();
      }
    } else if (cmd === 'next' || cmd === 'read' || cmd === 'regen') {
      const targetId = selectedTabId || tabId;
      if (targetId && tabRegistry.has(targetId)) {
        const info = tabRegistry.get(targetId);
        if (info.lastAssistantMessage) {
          let chunkIndex = 0;
          if (cmd === 'next') {
            info.lastReadIndex = (info.lastReadIndex ?? -1) + 1;
            chunkIndex = info.lastReadIndex;
          } else if (cmd === 'regen') {
            chunkIndex = info.lastReadIndex >= 0 ? info.lastReadIndex : 0;
          } else {
            // read
            chunkIndex = 0;
            info.lastReadIndex = 0;
          }

          if (chunkIndex >= 0 && chunkIndex < info.lastAssistantMessage.chunks.length) {
            audioQueue.push({
              tabId: targetId,
              tabTitle: info.title,
              messageKey: info.lastAssistantMessage.messageKey,
              chunkIndex: chunkIndex,
              text: info.lastAssistantMessage.chunks[chunkIndex],
              voiceProfile: params ? params.voiceProfile : null
            });
            playNext();
          }
        }
      }
    }
    sendResponse({ ok: true });
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

  return false;
});

